import type { Answer, Sources, Result, Storage, Database, NativeModule } from './app.contract.d.ts';

// revu's data: device-flow sign-in (LLP 0002), GitHub polling (LLP 0001
// §Polling, now in-app: exact2 gives app.ts `net.fetch` and a Keychain-backed
// secret store, so the sidecar is only the AI-review runner), seen-state in
// SQLite so "new since last check" survives restarts, PR details for the
// quick look, skill rules by repository, and the sidecar's review jobs.
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
const SIDECAR = 'http://127.0.0.1:47831';
const UA = 'revu/0.1 (+https://revu.donadel.dev)';
const DEFAULT_SKILL = 'pr-review';

type Store = Parameters<Answer>[2];
type Session = Result<'currentSession'>;
type Inbox = Result<'reviewRequests'>;
type Review = Inbox['mine'][number];
type PrDetail = Result<'prDetail'>;
type Job = Result<'reviewJob'>;
type Finding = Job['findings'][number];
type SkillSettings = Result<'skillSettings'>;
type Rule = SkillSettings['rules'][number];
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

function elapsed(fromIso: string, toIso: string | null, now: number): string {
  const from = Date.parse(fromIso);
  const to = toIso ? Date.parse(toIso) : now;
  const s = Math.max(0, Math.round((to - from) / 1000));
  if (!Number.isFinite(s)) return '0:00';
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
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

async function sidecar(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(SIDECAR + path, {
    ...init,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(init.headers as Record<string, string> | undefined) },
  });
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

// --- storage -----------------------------------------------------------

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
    // Skill rules by repository (design 1f): first match wins, by position.
    await db.execute('CREATE TABLE IF NOT EXISTS rules (pattern TEXT PRIMARY KEY, skill TEXT NOT NULL, position INTEGER NOT NULL)');
    return await work(db);
  } finally {
    await db.close();
  }
}

// --- pull-request details, cached by the search's updated_at --------------

interface PullFacts {
  updatedAt: string;
  headSha: string;
  baseSha: string;
  headRef: string;
  baseRef: string;
  teams: string[];
  files: number;
  additions: number;
  deletions: number;
  body: string;
  checkedAt: number;
  ci: string;
  ciLabel: string;
}

const pulls = new Map<string, PullFacts>();

async function checkRuns(store: Store, repo: string, sha: string): Promise<{ ci: string; ciLabel: string }> {
  try {
    const res = await gh(store, `/repos/${repo}/commits/${sha}/check-runs?per_page=100`);
    if (!res.ok) return { ci: 'none', ciLabel: 'Checks unknown' };
    const runs = (((await res.json()) as Json).check_runs ?? []) as Json[];
    if (runs.length === 0) return { ci: 'none', ciLabel: 'No checks' };
    const failed = runs.filter((r) => ['failure', 'timed_out', 'cancelled', 'action_required'].includes(String(r.conclusion))).length;
    const running = runs.filter((r) => r.status !== 'completed').length;
    const passed = runs.filter((r) => ['success', 'neutral', 'skipped'].includes(String(r.conclusion))).length;
    if (failed > 0) return { ci: 'fail', ciLabel: `${failed} ${failed === 1 ? 'check' : 'checks'} failed` };
    if (running > 0) return { ci: 'run', ciLabel: `Checks running · ${passed} of ${runs.length} done` };
    return { ci: 'pass', ciLabel: passed === runs.length ? `${passed} of ${runs.length} passed` : 'Checks passed' };
  } catch {
    return { ci: 'none', ciLabel: 'Checks unknown' };
  }
}

async function pullFacts(store: Store, repo: string, number: number, updatedAt: string, now: number): Promise<PullFacts | null> {
  const key = `${repo}#${number}`;
  const cached = pulls.get(key);
  if (cached && cached.updatedAt === updatedAt) {
    // Running checks are re-read once a minute; settled ones stay.
    if (cached.ci !== 'run' || now - cached.checkedAt < 60_000) return cached;
    const ci = await checkRuns(store, repo, cached.headSha);
    const fresh = { ...cached, ...ci, checkedAt: now };
    pulls.set(key, fresh);
    return fresh;
  }
  try {
    const res = await gh(store, `/repos/${repo}/pulls/${number}`);
    if (!res.ok) return cached ?? null;
    const p = (await res.json()) as Json;
    const headSha = String(p.head?.sha ?? '');
    const ci = headSha ? await checkRuns(store, repo, headSha) : { ci: 'none', ciLabel: 'No checks' };
    const facts: PullFacts = {
      updatedAt,
      headSha,
      baseSha: String(p.base?.sha ?? ''),
      headRef: String(p.head?.ref ?? ''),
      baseRef: String(p.base?.ref ?? ''),
      teams: ((p.requested_teams ?? []) as Json[]).map((t) => String(t.slug ?? t.name ?? '')),
      files: Number(p.changed_files ?? 0),
      additions: Number(p.additions ?? 0),
      deletions: Number(p.deletions ?? 0),
      body: String(p.body ?? ''),
      checkedAt: now,
      ...ci,
    };
    pulls.set(key, facts);
    return facts;
  } catch {
    return cached ?? null;
  }
}

// --- inbox (LLP 0001 §Polling, §State) ---------------------------------

const emptyInbox: Inbox = { ready: false, login: '', unread: 0, total: 0, mineCount: 0, teamCount: 0, polledAt: 'never', error: '', mine: [], team: [] };

async function search(store: Store, q: string): Promise<Json[]> {
  const res = await gh(store, `/search/issues?q=${encodeURIComponent(q)}&per_page=100&sort=updated`);
  if (!res.ok) throw new Error(`GitHub answered ${res.status} to the search.`);
  return (((await res.json()) as Json).items ?? []) as Json[];
}

async function reviewRequests(store: Store, storage: Storage, login: string, pollMs: number, epoch: number, _actionsStamp: number): Promise<Inbox> {
  if (!store.get('github.token')) return emptyInbox;
  const now = pollMs || epoch;
  let items: Json[];
  let direct: Set<string>;
  try {
    // `review-requested:@me` includes the user's teams; `user-review-requested`
    // is the user alone — the difference is the "Requested from teams" list.
    const [all, mine] = await Promise.all([
      search(store, 'is:open is:pr review-requested:@me archived:false'),
      search(store, 'is:open is:pr user-review-requested:@me archived:false'),
    ]);
    items = all;
    direct = new Set(mine.map((i) => String(i.html_url ?? '')));
  } catch (e) {
    return { ...emptyInbox, login, error: message(e).startsWith('GitHub answered') ? message(e) : `GitHub could not be reached: ${message(e)}` };
  }

  const reviews: Review[] = [];
  for (const item of items.slice(0, 30)) {
    const repo = String(item.repository_url ?? '').replace(`${API}/repos/`, '');
    const [owner, name] = repo.split('/');
    const number = Number(item.number);
    const updatedAt = String(item.updated_at ?? '');
    const facts = await pullFacts(store, repo, number, updatedAt, now);
    const url = String(item.html_url ?? '');
    reviews.push({
      id: `${repo}#${number}`,
      owner: owner ?? '',
      name: name ?? '',
      repo,
      number,
      title: String(item.title ?? ''),
      url,
      author: String(item.user?.login ?? ''),
      requestedAt: updatedAt,
      age: age(updatedAt, now),
      unread: true,
      team: direct.has(url) ? '' : (facts?.teams[0] ?? 'team'),
      ci: facts?.ci ?? 'none',
      ciLabel: facts?.ciLabel ?? 'Checks unknown',
    });
  }

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

  const mine = reviews.filter((r) => r.team === '');
  const team = reviews.filter((r) => r.team !== '');
  return {
    ready: true,
    login,
    unread: reviews.filter((r) => r.unread).length,
    total: reviews.length,
    mineCount: mine.length,
    teamCount: team.length,
    polledAt: clock(now),
    error: '',
    mine,
    team,
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

// --- quick look (design 1c) ------------------------------------------------

const emptyDetail: PrDetail = { ready: false, id: '', repo: '', number: 0, title: '', url: '', author: '', baseRef: '', headRef: '', headSha: '', baseSha: '', ci: 'none', ciLabel: '', files: 0, additions: 0, deletions: 0, changed: [], body: '', skill: DEFAULT_SKILL, skillRule: '*', error: '' };

async function prDetail(store: Store, storage: Storage, owner: string, name: string, number: string, _rulesStamp: number): Promise<PrDetail> {
  if (!owner || !name || !number || !store.get('github.token')) return emptyDetail;
  const repo = `${owner}/${name}`;
  const n = Number(number);
  try {
    const [pullRes, filesRes] = await Promise.all([gh(store, `/repos/${repo}/pulls/${n}`), gh(store, `/repos/${repo}/pulls/${n}/files?per_page=100`)]);
    if (!pullRes.ok) return { ...emptyDetail, repo, number: n, error: `GitHub answered ${pullRes.status} for the pull request.` };
    const p = (await pullRes.json()) as Json;
    const files = filesRes.ok ? ((await filesRes.json()) as Json[]) : [];
    const headSha = String(p.head?.sha ?? '');
    const ci = headSha ? await checkRuns(store, repo, headSha) : { ci: 'none', ciLabel: 'No checks' };
    const match = await matchSkill(storage, repo, 0);
    return {
      ready: true,
      id: `${repo}#${n}`,
      repo,
      number: n,
      title: String(p.title ?? ''),
      url: String(p.html_url ?? ''),
      author: String(p.user?.login ?? ''),
      baseRef: String(p.base?.ref ?? ''),
      headRef: String(p.head?.ref ?? ''),
      headSha,
      baseSha: String(p.base?.sha ?? ''),
      ...ci,
      files: Number(p.changed_files ?? files.length),
      additions: Number(p.additions ?? 0),
      deletions: Number(p.deletions ?? 0),
      changed: files.slice(0, 40).map((f) => ({ path: String(f.filename ?? ''), additions: Number(f.additions ?? 0), deletions: Number(f.deletions ?? 0) })),
      body: String(p.body ?? '').trim(),
      skill: match.skill,
      skillRule: match.pattern,
      error: '',
    };
  } catch (e) {
    return { ...emptyDetail, repo, number: n, error: `GitHub could not be reached: ${message(e)}` };
  }
}

// --- skill rules (design 1f) ----------------------------------------------

const defaultRules: Rule[] = [{ pattern: '*', skill: DEFAULT_SKILL }];

async function readRules(storage: Storage): Promise<Rule[]> {
  try {
    return await withDb(storage, async (db) => {
      const rows = await db.query('SELECT pattern, skill FROM rules ORDER BY position ASC');
      if (rows.rows.length === 0) return defaultRules;
      return rows.rows.map((r) => ({ pattern: String(r[0]), skill: String(r[1]) }));
    });
  } catch {
    return defaultRules;
  }
}

function globMatches(pattern: string, repo: string): boolean {
  const re = new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
  return re.test(repo);
}

async function matchSkill(storage: Storage, repo: string, _stamp: number): Promise<Result<'matchSkill'>> {
  const rules = await readRules(storage);
  // The catch-all is always last, so a list without one still matches.
  for (const r of [...rules, ...defaultRules]) if (globMatches(r.pattern, repo)) return { skill: r.skill, pattern: r.pattern };
  return { skill: DEFAULT_SKILL, pattern: '*' };
}

async function addRule(storage: Storage, pattern: string, skill: string): Promise<Result<'addRule'>> {
  const p = pattern.trim().toLowerCase();
  const s = skill.trim().replace(/\.md$/, '');
  if (!p || !s) return { stamp: ++stamp, error: 'A rule needs a pattern and a skill.' };
  try {
    await withDb(storage, async (db) => {
      const rules = await db.query('SELECT pattern, skill, position FROM rules ORDER BY position ASC');
      if (rules.rows.length === 0) {
        // Materialise the default so the catch-all keeps its place at the end.
        await db.execute('INSERT INTO rules (pattern, skill, position) VALUES (?, ?, ?)', ['*', DEFAULT_SKILL, 1000]);
      }
      const max = rules.rows.reduce((m, r) => Math.max(m, Number(r[2])), 0);
      // A new specific rule goes before the catch-all; the catch-all stays last.
      const position = p === '*' ? 1000 : Math.min(max, 999) - 1 + 1;
      await db.execute('INSERT OR REPLACE INTO rules (pattern, skill, position) VALUES (?, ?, ?)', [p, s, p === '*' ? 1000 : position]);
      // Re-number so order is stable: specifics in insertion order, `*` last.
      const all = await db.query("SELECT pattern FROM rules WHERE pattern != '*' ORDER BY position ASC, rowid ASC");
      let i = 0;
      for (const row of all.rows) await db.execute('UPDATE rules SET position = ? WHERE pattern = ?', [i++, String(row[0])]);
    });
    return { stamp: ++stamp, error: '' };
  } catch (e) {
    return { stamp: ++stamp, error: `Could not save the rule: ${message(e)}` };
  }
}

async function removeRule(storage: Storage, pattern: string): Promise<Result<'removeRule'>> {
  try {
    await withDb(storage, (db) => db.execute('DELETE FROM rules WHERE pattern = ?', [pattern]));
    return { stamp: ++stamp, error: '' };
  } catch (e) {
    return { stamp: ++stamp, error: `Could not remove the rule: ${message(e)}` };
  }
}

async function skillSettings(storage: Storage, selected: string, _rulesStamp: number, _savedStamp: number): Promise<SkillSettings> {
  const rules = await readRules(storage);
  const base: SkillSettings = { reachable: false, rules, skills: [], selected: '', usedBy: '', path: '', content: '', lines: [], error: '' };
  let skills: SkillSettings['skills'];
  try {
    const res = await sidecar('/skills');
    if (!res.ok) return { ...base, error: `sidecar answered ${res.status}` };
    skills = ((await res.json()) as Json[]).map((s) => {
      const name = String(s.name ?? '');
      const usedBy = rules.filter((r) => r.skill === name).map((r) => r.pattern);
      return { name, path: String(s.path ?? ''), description: String(s.description ?? ''), usedBy: usedBy.join(', ') };
    });
  } catch (e) {
    return { ...base, error: `sidecar offline: ${message(e)}` };
  }
  const pick = skills.find((s) => s.name === selected) ?? skills.find((s) => s.name === DEFAULT_SKILL) ?? skills[0];
  if (!pick) return { ...base, reachable: true, error: 'No skill files found.' };
  try {
    const res = await sidecar(`/skills/${encodeURIComponent(pick.name)}`);
    const body = (await res.json()) as Json;
    if (!res.ok) return { ...base, reachable: true, skills, selected: pick.name, usedBy: pick.usedBy, path: pick.path, error: String(body.error ?? res.status) };
    const content = String(body.content ?? '');
    const lines = content.split('\n').map((text, i) => ({ n: i + 1, text: text === '' ? ' ' : text, heading: /^#{1,6}\s/.test(text) }));
    return { reachable: true, rules, skills, selected: pick.name, usedBy: pick.usedBy || '(no rule)', path: String(body.path ?? pick.path), content, lines, error: '' };
  } catch (e) {
    return { ...base, reachable: true, skills, selected: pick.name, usedBy: pick.usedBy, path: pick.path, error: `Could not read the skill: ${message(e)}` };
  }
}

async function saveSkill(name: string, content: string): Promise<Result<'saveSkill'>> {
  try {
    const res = await sidecar(`/skills/${encodeURIComponent(name)}`, { method: 'PUT', body: JSON.stringify({ content }) });
    const body = (await res.json()) as Json;
    if (!res.ok) return { stamp: ++stamp, ok: false, error: String(body.error ?? `sidecar answered ${res.status}`) };
    return { stamp: ++stamp, ok: true, error: '' };
  } catch (e) {
    return { stamp: ++stamp, ok: false, error: `Could not save: ${message(e)}` };
  }
}

// --- AI review jobs (LLP 0004; the sidecar runs them) ----------------------

async function sidecarStatus(): Promise<Result<'sidecarStatus'>> {
  try {
    const res = await sidecar('/health');
    if (!res.ok) return { reachable: false, runner: '', detail: `sidecar answered ${res.status}` };
    const body = (await res.json()) as Json;
    return { reachable: true, runner: String(body.runner ?? 'unconfigured'), detail: '' };
  } catch (e) {
    return { reachable: false, runner: '', detail: message(e) };
  }
}

async function startReview(store: Store, storage: Storage, id: string, skill: string): Promise<Result<'startReview'>> {
  const token = store.get('github.token');
  const [repo, number] = id.split('#');
  if (!token || !repo || !number) return { stamp: ++stamp, id: '', error: 'Nothing to review.' };
  const [owner, name] = repo.split('/');
  try {
    const detail = await prDetail(store, storage, owner ?? '', name ?? '', number, 0);
    if (!detail.ready) return { stamp: ++stamp, id: '', error: detail.error || 'The pull request could not be read.' };
    // The sidecar checks the PR out itself; it gets the token over loopback
    // for that one clone and keeps it in memory only (LLP 0001 §Transport).
    const auth = await sidecar('/auth/token', { method: 'POST', body: JSON.stringify({ access_token: token }) });
    if (!auth.ok) return { stamp: ++stamp, id: '', error: `The sidecar refused the token (${auth.status}).` };
    const res = await sidecar('/reviews', {
      method: 'POST',
      body: JSON.stringify({ repo, number: Number(number), title: detail.title, body: detail.body, baseSha: detail.baseSha, headSha: detail.headSha, headRef: detail.headRef, skill }),
    });
    const body = (await res.json()) as Json;
    if (!res.ok) return { stamp: ++stamp, id: '', error: String(body.error ?? `sidecar answered ${res.status}`) };
    return { stamp: ++stamp, id: String(body.id ?? ''), error: '' };
  } catch (e) {
    return { stamp: ++stamp, id: '', error: `The sidecar could not be reached: ${message(e)}` };
  }
}

/** Findings are lines the skill's Output section asks for:
 *  `- [BUG] path:line — title` (or `**BUG**`), with the following indented or
 *  plain lines as the body until the next finding or heading. */
function parseFindings(output: string): Finding[] {
  const findings: Finding[] = [];
  const head = /^\s*(?:[-*]\s*)?(?:\[|\*\*)?(BUG|RULE|TEST|NIT)(?:\]|\*\*)?:?\s*(?:`?([^`\s—–:-][^`\s]*?)`?\s*[—–-]\s*)?(.+)$/;
  let current: Finding | null = null;
  for (const raw of output.split('\n')) {
    const m = head.exec(raw);
    if (m) {
      current = { index: findings.length, sev: m[1]!, loc: m[2] ?? '', title: m[3]!.trim(), body: '' };
      findings.push(current);
      continue;
    }
    if (/^\s*#/.test(raw)) { current = null; continue; }
    if (current && raw.trim()) current.body = current.body ? `${current.body}\n${raw.trim()}` : raw.trim();
  }
  return findings;
}

function summarise(output: string): string {
  const paragraphs = output.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p && !/^#/.test(p) && !parseFindings(p).length);
  return paragraphs[0] ?? '';
}

const emptyJob: Job = { ready: false, id: '', status: '', skill: DEFAULT_SKILL, step: 0, progress: 0, elapsed: '0:00', log: [], summary: '', findings: [], error: '' };

async function reviewJob(jobId: string, tick: number, epoch: number): Promise<Job> {
  if (!jobId) return emptyJob;
  try {
    const res = await sidecar(`/reviews/${encodeURIComponent(jobId)}`);
    const body = (await res.json()) as Json;
    if (!res.ok) return { ...emptyJob, id: jobId, status: 'failed', error: String(body.error ?? `sidecar answered ${res.status}`) };
    const status = String(body.status ?? 'queued');
    const output = String(body.output ?? '');
    const step = status === 'queued' ? 0 : status === 'checking-out' ? 1 : status === 'running' ? (output ? 3 : 2) : 5;
    const progress = status === 'done' ? 100 : Math.min(95, step * 20 + (status === 'running' ? Math.min(15, output.length / 200) : 0));
    const now = epoch + tick * 5000;
    return {
      ready: true,
      id: jobId,
      status,
      skill: String(body.request?.skill ?? DEFAULT_SKILL),
      step,
      progress,
      elapsed: elapsed(String(body.startedAt ?? ''), body.finishedAt ? String(body.finishedAt) : null, now),
      log: output.split('\n').filter((l) => l.trim()).slice(-3),
      summary: status === 'done' ? summarise(output) : '',
      findings: status === 'done' ? parseFindings(output) : [],
      error: String(body.error ?? ''),
    };
  } catch (e) {
    return { ...emptyJob, id: jobId, status: 'failed', error: `The sidecar could not be reached: ${message(e)}` };
  }
}

async function cancelReview(jobId: string): Promise<Result<'cancelReview'>> {
  if (!jobId) return { stamp: ++stamp, ok: false };
  try {
    const res = await sidecar(`/reviews/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
    return { stamp: ++stamp, ok: res.ok };
  } catch {
    return { stamp: ++stamp, ok: false };
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
  // The OS accepts a post silently while permission is undecided or denied;
  // posting then would burn the once-only `announced` flag on a banner no one
  // saw. Leave the row unannounced until the user has granted.
  const status = await notificationStatus(native);
  if (status.permission !== 'granted') return { stamp: ++stamp, count: 0, error: `notifications ${status.permission}` };
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
 *  action and returns what happened so the inbox re-asks. */
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

/** The menu bar item follows the inbox and the running review (LLP 0006). */
async function trayState(native: Native, count: number, busy: boolean): Promise<Result<'trayState'>> {
  const n = notifier(native);
  if (!n) return { ok: false };
  try {
    return { ok: Boolean((n.call({ op: 'tray', count, busy }) as { ok?: boolean }).ok) };
  } catch {
    const r = (await n.later({ op: 'tray', count, busy })) as { ok?: boolean };
    return { ok: Boolean(r.ok) };
  }
}

/** Which window this session draws: the popover, or a kind the popover opened (LLP 0006 D2). */
async function windowRole(native: Native): Promise<Result<'windowRole'>> {
  const n = notifier(native);
  if (!n) return { kind: 'popover' };
  try {
    return { kind: String((n.call({ op: 'role' }) as { kind?: string }).kind ?? 'popover') };
  } catch {
    return { kind: String(((await n.later({ op: 'role' })) as { kind?: string }).kind ?? 'popover') };
  }
}

/** Opens (or shows) the window of a kind; false where there are no windows, so the app navigates instead. */
async function openWindow(native: Native, kind: string): Promise<Result<'openWindow'>> {
  const n = notifier(native);
  if (!n) return { stamp: ++stamp, ok: false };
  try {
    const r = (await n.later({ op: 'window', kind })) as { ok?: boolean };
    return { stamp: ++stamp, ok: Boolean(r.ok) };
  } catch {
    return { stamp: ++stamp, ok: false };
  }
}

const sources: Sources = {
  windowRole: (_, _store, _storage, native) => windowRole(native),
  openWindow: ([kind], _store, _storage, native) => openWindow(native, String(kind ?? 'settings')),
  trayState: ([count, busy], _store, _storage, native) => trayState(native, Number(count), Boolean(busy)),
  notificationStatus: (_, _store, _storage, native) => notificationStatus(native),
  requestNotificationPermission: (_, _store, _storage, native) => requestNotificationPermission(native),
  announceNew: ([now], store, storage, native) => announceNew(store, storage, native, Number(now)),
  notificationActions: ([now], _store, storage, native) => notificationActions(storage, native, Number(now)),
  sidecarStatus: () => sidecarStatus(),
  currentSession: (_, store) => currentSession(store),
  reviewRequests: ([login, pollMs, epoch, actionsStamp], store, storage) => reviewRequests(store, storage, String(login ?? ''), Number(pollMs), Number(epoch), Number(actionsStamp)),
  prDetail: ([owner, name, number, rulesStamp], store, storage) => prDetail(store, storage, String(owner ?? ''), String(name ?? ''), String(number ?? ''), Number(rulesStamp)),
  reviewJob: ([jobId, tick, epoch]) => reviewJob(String(jobId ?? ''), Number(tick), Number(epoch)),
  skillSettings: ([selected, rulesStamp, savedStamp], _store, storage) => skillSettings(storage, String(selected ?? ''), Number(rulesStamp), Number(savedStamp)),
  matchSkill: ([repo, rulesStamp], _store, storage) => matchSkill(storage, String(repo ?? ''), Number(rulesStamp)),
  deviceStart: ([now]) => deviceStart(Number(now)),
  devicePoll: ([code, now], store) => devicePoll(store, String(code), Number(now)),
  signOut: (_, store) => {
    store.forget('github.token');
    return { ...signedOut };
  },
  markSeen: ([id], _store, storage) => markSeen(storage, String(id)),
  startReview: ([id, skill], store, storage) => startReview(store, storage, String(id ?? ''), String(skill ?? DEFAULT_SKILL)),
  cancelReview: ([jobId]) => cancelReview(String(jobId ?? '')),
  addRule: ([pattern, skill], _store, storage) => addRule(storage, String(pattern ?? ''), String(skill ?? '')),
  removeRule: ([pattern], _store, storage) => removeRule(storage, String(pattern ?? '')),
  saveSkill: ([name, content]) => saveSkill(String(name ?? ''), String(content ?? '')),
};

export const answer: Answer = (source, args, store, storage, native) => sources[source](args, store, storage, native);
