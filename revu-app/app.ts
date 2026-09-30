import type { Answer, Sources, Result, Storage, Database, NativeModule } from './app.contract.d.ts';

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
  // The AI-review sidecar on loopback (LLP 0001 §Transport, LLP 0004).
  'net.fetch http://127.0.0.1:47831',
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

function age(iso: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (!Number.isFinite(minutes)) return '';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function clock(now: number): string {
  const d = new Date(now);
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

async function deviceStart(now: number): Promise<DeviceCode> {
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
      expiresAt: now + Number(body.expires_in ?? 900) * 1000,
    };
  } catch (e) {
    return { ...empty, error: `device code failed: ${message(e)}` };
  }
}

// GitHub's device flow asks for at least `interval` seconds between polls and
// answers `slow_down` (+5 s) when pushed; the Contract clock is a fixed 5 s, so
// the source itself skips polls until the next allowed time.
const pollNotBefore = new Map<string, number>();

async function devicePoll(store: Store, deviceCode: string, now: number): Promise<Grant> {
  const base: Grant = { stamp: ++stamp, status: 'pending', login: '', error: '' };
  const notBefore = pollNotBefore.get(deviceCode) ?? 0;
  if (now < notBefore) return base;
  pollNotBefore.set(deviceCode, now + 5000);
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
        return base;
      case 'slow_down':
        pollNotBefore.set(deviceCode, now + Number(body.interval ?? 10) * 1000);
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
      'CREATE TABLE IF NOT EXISTS prs (id TEXT PRIMARY KEY, first_seen_at TEXT NOT NULL, seen INTEGER NOT NULL DEFAULT 0, announced INTEGER NOT NULL DEFAULT 0, title TEXT NOT NULL DEFAULT \'\', url TEXT NOT NULL DEFAULT \'\', author TEXT NOT NULL DEFAULT \'\', requested_at TEXT NOT NULL DEFAULT \'\')',
    );
    // An older table (before announcing) gains the new columns in place.
    const cols = await db.query('PRAGMA table_info(prs)');
    const names = new Set(cols.rows.map((r) => String(r[1])));
    for (const [name, decl] of [['announced', 'INTEGER NOT NULL DEFAULT 0'], ['title', "TEXT NOT NULL DEFAULT ''"], ['url', "TEXT NOT NULL DEFAULT ''"], ['author', "TEXT NOT NULL DEFAULT ''"], ['requested_at', "TEXT NOT NULL DEFAULT ''"]] as const) {
      if (!names.has(name)) await db.execute(`ALTER TABLE prs ADD COLUMN ${name} ${decl}`);
    }
    return await work(db);
  } finally {
    await db.close();
  }
}

const emptyInbox: Inbox = { ready: false, login: '', unread: 0, total: 0, polledAt: 'never', error: '', reviews: [] };

async function reviewRequests(store: Store, storage: Storage, login: string, now: number, _actionsStamp: number): Promise<Inbox> {
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
      age: age(String(item.updated_at ?? ''), now),
      unread: true,
    };
  });

  // Seen-state: bake/agent mode has no storage; degrade to "all unread".
  try {
    await withDb(storage, async (db) => {
      const firstSeen = new Date(now).toISOString();
      for (const r of reviews) {
        await db.execute('INSERT OR IGNORE INTO prs (id, first_seen_at, seen, title, url, author, requested_at) VALUES (?, ?, 0, ?, ?, ?, ?)', [r.id, firstSeen, r.title, r.url, r.author, r.requestedAt]);
        await db.execute('UPDATE prs SET title = ?, url = ?, author = ? WHERE id = ?', [r.title, r.url, r.author, r.id]);
      }
      // Rows are positional (SQLValue[]), in SELECT order.
      const rows = await db.query('SELECT id, seen FROM prs');
      const seen = new Map<string, boolean>();
      for (const row of rows.rows) seen.set(String(row[0]), Number(row[1]) === 1);
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
    polledAt: clock(now),
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

type SidecarStatus = Result<'sidecarStatus'>;

async function sidecarStatus(): Promise<SidecarStatus> {
  try {
    const res = await fetch('http://127.0.0.1:47831/health');
    if (!res.ok) return { reachable: false, runner: '', detail: `sidecar answered ${res.status}` };
    const body = (await res.json()) as Json;
    return { reachable: true, runner: String(body.runner ?? 'unconfigured'), detail: '' };
  } catch (e) {
    return { reachable: false, runner: '', detail: message(e) };
  }
}

// --- notifications (LLP 0003; exact2 LLP 1067.000 module `revu-notifier`) ---

type Native = NativeModule | null | undefined;
type NotifyStatus = Result<'notificationStatus'>;
type Announced = Result<'announceNew'>;
type Actions = Result<'notificationActions'>;

function notifier(native: Native): NativeModule | null {
  return native && native.available ? native : null;
}

async function notificationStatus(native: Native): Promise<NotifyStatus> {
  const n = notifier(native);
  if (!n) return { available: false, permission: 'unavailable', pending: 0 };
  n.watch('notifications');
  try {
    return (n.call({ op: 'status' }) as NotifyStatus);
  } catch {
    return (await n.later({ op: 'status' })) as NotifyStatus;
  }
}

async function requestNotificationPermission(native: Native): Promise<NotifyStatus> {
  const n = notifier(native);
  if (!n) return { available: false, permission: 'unavailable', pending: 0 };
  const r = (await n.later({ op: 'permission' })) as { permission: string };
  return { available: true, permission: r.permission, pending: 0 };
}

/** Post one notification per review request not yet announced; the SQLite
 *  `announced` flag is what makes each fire exactly once across restarts. */
async function announceNew(store: Store, storage: Storage, native: Native, now: number): Promise<Announced> {
  const n = notifier(native);
  if (!n || !store.get('github.token')) return { stamp: ++stamp, count: 0, error: n ? '' : 'notifier unavailable' };
  let count = 0;
  let error = '';
  try {
    await withDb(storage, async (db) => {
      const rows = await db.query("SELECT id, title, url, author, requested_at FROM prs WHERE announced = 0 AND seen = 0 ORDER BY requested_at DESC LIMIT 5");
      for (const row of rows.rows) {
        const [id, title, url, author] = row.map((v) => String(v));
        const [repo, number] = id.split('#');
        try {
          await n.later({
            op: 'notify',
            id: `revu:${id}`,
            title: `Review requested: ${repo}#${number}`,
            subtitle: author,
            body: title,
            sound: 'default',
            actions: [
              { id: 'open', title: 'Open' },
              { id: 'seen', title: 'Mark read' },
            ],
            data: { prId: id, url },
          });
          await db.execute('UPDATE prs SET announced = 1 WHERE id = ?', [id]);
          count += 1;
        } catch (e) {
          error = message(e);
        }
      }
    });
  } catch (e) {
    error = message(e);
  }
  return { stamp: ++stamp, count, error };
}

/** Re-asked whenever the module announces `notifications`; applies each
 *  action (open → the URL is opened by the module's host? no: here) and
 *  returns what happened so the inbox re-asks. */
async function notificationActions(storage: Storage, native: Native, now: number): Promise<Actions> {
  const n = notifier(native);
  if (!n) return { stamp: 0, applied: [] };
  n.watch('notifications');
  let actions: Array<{ notificationId: string; actionId: string; data: { prId?: string; url?: string } }> = [];
  try {
    actions = ((n.call({ op: 'drain' }) as { actions?: typeof actions }).actions) ?? [];
  } catch {
    actions = (((await n.later({ op: 'drain' })) as { actions?: typeof actions }).actions) ?? [];
  }
  const applied: string[] = [];
  for (const a of actions) {
    const prId = a.data?.prId ?? '';
    if (!prId) continue;
    if (a.actionId === 'seen' || a.actionId === 'open' || a.actionId === 'default') {
      try { await withDb(storage, (db) => db.execute('UPDATE prs SET seen = 1 WHERE id = ?', [prId])); } catch { /* agent mode */ }
    }
    applied.push(`${a.actionId}:${prId}`);
  }
  // A new stamp only when something happened, so a mere re-ask does not churn the inbox.
  return { stamp: applied.length ? now : 0, applied };
}

const sources: Sources = {
  notificationStatus: (_, _store, _storage, native) => notificationStatus(native),
  requestNotificationPermission: (_, _store, _storage, native) => requestNotificationPermission(native),
  announceNew: ([now], store, storage, native) => announceNew(store, storage, native, Number(now)),
  notificationActions: ([now], _store, storage, native) => notificationActions(storage, native, Number(now)),
  sidecarStatus: () => sidecarStatus(),
  currentSession: (_, store) => currentSession(store),
  reviewRequests: ([login, now, actionsStamp], store, storage) => reviewRequests(store, storage, String(login ?? ''), Number(now), Number(actionsStamp)),
  deviceStart: ([now]) => deviceStart(Number(now)),
  devicePoll: ([code, now], store) => devicePoll(store, String(code), Number(now)),
  signOut: (_, store) => {
    store.forget('github.token');
    return { ...signedOut };
  },
  markSeen: ([id], _store, storage) => markSeen(storage, String(id)),
};

export const answer: Answer = (source, args, store, storage, native) => sources[source](args, store, storage, native);
