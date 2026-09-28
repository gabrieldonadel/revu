import type { Answer, Sources, Result, Storage, Database } from './app.contract.d.ts';

// revu's data: device-flow sign-in (LLP 0002), GitHub polling (LLP 0001
// §Polling, now in-app: exact2 gives app.ts `net.fetch` and a Keychain-backed
// secret store, so the sidecar is only the AI-review runner), and seen-state
// in SQLite so "new since last check" survives restarts.
export const appId = 'dev.donadel.revu';
export const grants = [
  'net.fetch https://api.github.com',
  'net.fetch https://github.com',
  'secret.keep github.token',
  'sqlite.open app:/data/revu.db',
].join('\n');

const CLIENT_ID = 'Ov23li3weoDK9jZ4ycnp';
const SCOPES = 'notifications repo read:user';
const API = 'https://api.github.com';
const UA = 'revu/0.1 (+https://revu.donadel.dev)';

type Store = Parameters<Answer>[2];
type Session = Result<'currentSession'>;
type Inbox = Result<'reviewRequests'>;
type Review = Inbox['reviews'][number];
type Json = Record<string, any>;

let stamp = 0;

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function age(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (!Number.isFinite(minutes)) return '';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function clock(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

async function gh(store: Store, path: string, init: RequestInit = {}): Promise<Response> {
  const token = store.get('github.token');
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': UA,
    'X-GitHub-Api-Version': '2022-11-28',
    ...(init.headers as Record<string, string> | undefined),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(API + path, { ...init, headers, exactIndependentHttp: { maxResponseBytes: 4 << 20 } } as RequestInit);
}

// --- session -----------------------------------------------------------

const signedOut: Session = { signedIn: false, login: '', error: '' };

async function currentSession(store: Store): Promise<Session> {
  if (!store.get('github.token')) return signedOut;
  try {
    const res = await gh(store, '/user');
    if (res.status === 401) {
      store.forget('github.token');
      return { ...signedOut, error: 'GitHub rejected the saved token; sign in again.' };
    }
    if (!res.ok) return { ...signedOut, error: `GitHub answered ${res.status}.` };
    const me = (await res.json()) as Json;
    return { signedIn: true, login: String(me.login ?? ''), error: '' };
  } catch (e) {
    // Offline is not signed-out: keep the token, report the reach failure.
    return { signedIn: true, login: '', error: `GitHub could not be reached: ${message(e)}` };
  }
}

// --- device flow (LLP 0002) --------------------------------------------

type DeviceCode = Result<'deviceStart'>;
type Grant = Result<'devicePoll'>;

async function deviceStart(): Promise<DeviceCode> {
  const empty: DeviceCode = { stamp: ++stamp, ok: false, userCode: '', verificationUri: '', deviceCode: '', expiresAt: 0, error: '' };
  try {
    const res = await fetch('https://github.com/login/device/code', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({ client_id: CLIENT_ID, scope: SCOPES }),
    });
    if (!res.ok) return { ...empty, error: `device code failed: ${res.status}` };
    const body = (await res.json()) as Json;
    return {
      ...empty,
      ok: true,
      userCode: String(body.user_code ?? ''),
      verificationUri: String(body.verification_uri ?? ''),
      deviceCode: String(body.device_code ?? ''),
      expiresAt: Date.now() + Number(body.expires_in ?? 900) * 1000,
    };
  } catch (e) {
    return { ...empty, error: `device code failed: ${message(e)}` };
  }
}

async function devicePoll(store: Store, deviceCode: string): Promise<Grant> {
  const base: Grant = { stamp: ++stamp, status: 'pending', login: '', error: '' };
  try {
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({ client_id: CLIENT_ID, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
    });
    const body = (await res.json()) as Json;
    if (body.access_token) {
      store.set('github.token', String(body.access_token));
      const me = await currentSession(store);
      return { ...base, status: 'ok', login: me.login };
    }
    switch (body.error) {
      case 'authorization_pending':
      case 'slow_down':
        return base;
      case 'expired_token':
        return { ...base, status: 'expired', error: 'The code expired; start again.' };
      case 'access_denied':
        return { ...base, status: 'denied', error: 'Authorization was denied.' };
      default:
        return { ...base, status: 'error', error: String(body.error ?? 'unknown error') };
    }
  } catch (e) {
    return { ...base, error: `GitHub could not be reached: ${message(e)}` };
  }
}

// --- inbox (LLP 0001 §Polling, §State) ---------------------------------

async function withDb<T>(storage: Storage, work: (db: Database) => Promise<T>): Promise<T> {
  const db = await storage.sqlite.open('app:/data/revu.db');
  try {
    await db.execute(
      'CREATE TABLE IF NOT EXISTS prs (id TEXT PRIMARY KEY, first_seen_at TEXT NOT NULL, seen INTEGER NOT NULL DEFAULT 0)',
    );
    return await work(db);
  } finally {
    await db.close();
  }
}

const emptyInbox: Inbox = { ready: false, login: '', unread: 0, total: 0, polledAt: 'never', error: '', reviews: [] };

async function reviewRequests(store: Store, storage: Storage, login: string): Promise<Inbox> {
  if (!store.get('github.token')) return emptyInbox;
  let items: Json[];
  try {
    const q = encodeURIComponent('is:open is:pr review-requested:@me archived:false');
    const res = await gh(store, `/search/issues?q=${q}&per_page=100&sort=updated`);
    if (!res.ok) return { ...emptyInbox, login, error: `GitHub answered ${res.status} to the search.` };
    items = ((await res.json()) as Json).items ?? [];
  } catch (e) {
    return { ...emptyInbox, login, error: `GitHub could not be reached: ${message(e)}` };
  }

  const reviews: Review[] = items.map((item) => {
    const repo = String(item.repository_url ?? '').replace(`${API}/repos/`, '');
    return {
      id: `${repo}#${item.number}`,
      repo,
      number: Number(item.number),
      title: String(item.title ?? ''),
      url: String(item.html_url ?? ''),
      author: String(item.user?.login ?? ''),
      requestedAt: String(item.updated_at ?? ''),
      age: age(String(item.updated_at ?? '')),
      unread: true,
    };
  });

  // Seen-state: bake/agent mode has no storage; degrade to "all unread".
  try {
    await withDb(storage, async (db) => {
      const now = new Date().toISOString();
      for (const r of reviews) {
        await db.execute('INSERT OR IGNORE INTO prs (id, first_seen_at, seen) VALUES (?, ?, 0)', [r.id, now]);
      }
      const rows = await db.query('SELECT id, seen FROM prs');
      const seen = new Map<string, boolean>();
      for (const row of rows.rows as Array<Record<string, unknown>>) seen.set(String(row.id), Number(row.seen) === 1);
      for (const r of reviews) r.unread = !(seen.get(r.id) ?? false);
    });
  } catch {
    // Unavailable storage (bake, agent mode, a busy file) keeps every row unread.
  }

  return {
    ready: true,
    login,
    unread: reviews.filter((r) => r.unread).length,
    total: reviews.length,
    polledAt: clock(),
    error: '',
    reviews,
  };
}

async function markSeen(storage: Storage, id: string): Promise<Result<'markSeen'>> {
  try {
    await withDb(storage, (db) => db.execute('UPDATE prs SET seen = 1 WHERE id = ?', [id]));
  } catch {
    // Same degradation as above.
  }
  return { stamp: ++stamp, id };
}

const sources: Sources = {
  currentSession: (_, store) => currentSession(store),
  reviewRequests: ([login], store, storage) => reviewRequests(store, storage, String(login ?? '')),
  deviceStart: () => deviceStart(),
  devicePoll: ([code], store) => devicePoll(store, String(code)),
  signOut: (_, store) => {
    store.forget('github.token');
    return { ...signedOut };
  },
  markSeen: ([id], _store, storage) => markSeen(storage, String(id)),
};

export const answer: Answer = (source, args, store, storage) => sources[source](args, store, storage);
