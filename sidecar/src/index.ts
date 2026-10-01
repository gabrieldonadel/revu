// revu sidecar — the process the Exact app cannot be.
// @ref LLP 0001#sidecar-split — why a second process exists at all.
// @ref LLP 0001#transport — loopback HTTP for requests, WS for pushes.

import type { ServerWebSocket } from 'bun';
import { createHash, randomBytes } from 'node:crypto';

import { loadConfig } from './config.ts';
import { closeMissing, getMeta, listPending, markSeen, openDb, setMeta, upsertPr, type PullRequestRow } from './db.ts';
import { GitHubClient, pollDeviceFlow, startDeviceFlow, type ReviewRequest } from './github.ts';
import { cancelJob, fileAt, getJob, hunksFor, listJobs, listSkills, loadPersistedJobs, postReview, readSkill, startReview, writeSkill, type ReviewRequest as ReviewJobRequest } from './review.ts';
import { availableAgents, runners, type AgentName } from './runners.ts';

const config = loadConfig();
const db = openDb();
const host = config.sidecar.host ?? '127.0.0.1';
const port = config.sidecar.port ?? 47831;
const configuredPoll = Math.max(10, config.github.pollIntervalSeconds ?? 60);

// The token lives in the app's Keychain (desktop.secureStorage) and is handed
// to the sidecar per session over loopback. It is never written to disk here.
let token: string | null = null;
let client: GitHubClient | null = null;
let login: string | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let lastPollAt: string | null = null;
let lastPollError: string | null = null;

type Event =
  | { type: 'snapshot'; login: string | null; prs: PullRequestRow[]; lastPollAt: string | null; lastPollError: string | null }
  | { type: 'review_requested'; pr: PullRequestRow }
  | { type: 'auth'; login: string | null }
  | { type: 'review'; job: ReturnType<typeof getJob> };

// @ref LLP 0004 — the runner is the user's local agent CLI, named per job
// (Settings ▸ Model in the app); `claude` when the job names none.
function runnerFor(agent: string | undefined) {
  const name = (agent ?? 'claude') as AgentName;
  const runner = runners[name];
  if (!runner) throw new Error(`no such agent: ${agent}`);
  return runner;
}

const sockets = new Set<ServerWebSocket<undefined>>();

// --- the browser sign-in (LLP 0002 r4) ---
const oauthFlows = new Map<string, { verifier: string; redirectUri: string; token: string | null; error: string | null; startedAt: number }>();

/** The code → token step. The secret never reaches the app: it is in this
 *  process's `.env` (dev) or behind the hosted exchange endpoint. */
async function exchangeCode(code: string, verifier: string, redirectUri: string): Promise<string> {
  const secret = process.env.GITHUB_CLIENT_SECRET;
  if (secret) {
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: config.github.oauthClientId, client_secret: secret, code, code_verifier: verifier, redirect_uri: redirectUri }),
    });
    const body = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
    if (!body.access_token) throw new Error(body.error_description ?? body.error ?? `GitHub answered ${res.status}`);
    return body.access_token;
  }
  const endpoint = config.github.oauthExchangeUrl;
  if (!endpoint) throw new Error('no client secret here and no exchange endpoint configured (github.oauthExchangeUrl)');
  const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, code_verifier: verifier, redirect_uri: redirectUri }) });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (!res.ok || !body.access_token) throw new Error(body.error ?? `the exchange endpoint answered ${res.status}`);
  return body.access_token;
}

function oauthPage(message: string, ok: boolean): string {
  // The mark (the app icon): a rounded square with Lucide's git-pull-request.
  const mark = `<div style="width:48px;height:48px;border-radius:12px;background:${ok ? '#11181c' : 'rgb(207,34,46)'};display:flex;align-items:center;justify-content:center;margin-bottom:20px"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><path d="M6 9v12"/></svg></div>`;
  const safe = message.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>revu</title><body style="font-family:-apple-system,system-ui;background:#f9fafb;color:#11181c;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0"><div style="background:#fff;border:1px solid #e1e4e8;border-radius:12px;padding:32px 28px;max-width:420px;box-shadow:0 8px 30px rgba(0,0,0,.12)">${mark}<h1 style="font-size:18px;margin:0 0 8px;letter-spacing:-.01em">${ok ? 'Connected to GitHub' : 'Sign-in did not finish'}</h1><p style="font-size:14px;line-height:1.5;color:#596068;margin:0">${safe}</p></div>`;
}

function broadcast(event: Event): void {
  const data = JSON.stringify(event);
  for (const ws of sockets) ws.send(data);
}

function snapshot(): Event {
  return { type: 'snapshot', login, prs: listPending(db), lastPollAt, lastPollError };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function setToken(next: string): Promise<{ login: string }> {
  const candidate = new GitHubClient(next);
  const me = await candidate.me();
  token = next;
  client = candidate;
  login = me.login;
  broadcast({ type: 'auth', login });
  schedulePoll(0);
  return { login: me.login };
}

function clearToken(): void {
  token = null;
  client = null;
  login = null;
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
  broadcast({ type: 'auth', login: null });
}

function schedulePoll(delaySeconds: number): void {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(() => {
    void pollOnce();
  }, delaySeconds * 1000);
}

function ingest(requests: ReviewRequest[]): PullRequestRow[] {
  const fresh: PullRequestRow[] = [];
  for (const request of requests) {
    if (upsertPr(db, request)) {
      const row = listPending(db).find((pr) => pr.id === request.id);
      if (row) fresh.push(row);
    }
  }
  return fresh;
}

async function pollOnce(): Promise<void> {
  if (!client) return;
  let nextDelay = configuredPoll;
  try {
    // Cheap incremental signal first; it carries the real requested_at.
    const outcome = await client.reviewRequestNotifications(getMeta(db, 'notifications.lastModified'));
    if (outcome.lastModified) setMeta(db, 'notifications.lastModified', outcome.lastModified);
    if (outcome.pollInterval) nextDelay = Math.max(nextDelay, outcome.pollInterval);
    const fresh = ingest(outcome.requests);

    // Full refresh reconciles closes/merges and anything predating the daemon.
    // Once per 5 polls is enough; search has its own (lower) rate limit.
    const tick = Number(getMeta(db, 'poll.tick') ?? '0') + 1;
    setMeta(db, 'poll.tick', String(tick));
    if (tick % 5 === 1) {
      const open = await client.openReviewRequests();
      fresh.push(...ingest(open));
      closeMissing(db, new Set(open.map((pr) => pr.id)));
    }

    lastPollAt = new Date().toISOString();
    lastPollError = null;
    for (const pr of fresh) broadcast({ type: 'review_requested', pr });
    broadcast(snapshot());
  } catch (error) {
    lastPollError = error instanceof Error ? error.message : String(error);
    // Back off on failure; GitHub's abuse limits want this.
    nextDelay = Math.min(configuredPoll * 4, 600);
    broadcast(snapshot());
  } finally {
    schedulePoll(nextDelay);
  }
}

const server = Bun.serve<undefined>({
  hostname: host,
  port,
  async fetch(request, srv) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/events' && srv.upgrade(request, { data: undefined })) return undefined as unknown as Response;

    if (request.method === 'GET' && path === '/health') {
      const agents = availableAgents();
      return json({ ok: true, login, authenticated: token !== null, lastPollAt, lastPollError, port, runner: 'local-agent', agents });
    }

    if (request.method === 'POST' && path === '/auth/device/start') {
      const start = await startDeviceFlow(config.github.oauthClientId, config.github.scopes);
      return json(start);
    }

    if (request.method === 'POST' && path === '/auth/device/poll') {
      const body = (await request.json()) as { device_code: string };
      const result = await pollDeviceFlow(config.github.oauthClientId, body.device_code);
      if (result.status === 'ok') {
        const me = await setToken(result.access_token);
        // Returned exactly once so the app can store it in the Keychain.
        return json({ status: 'ok', login: me.login, access_token: result.access_token, scope: result.scope });
      }
      return json(result);
    }

    if (request.method === 'POST' && path === '/auth/token') {
      const body = (await request.json()) as { access_token: string };
      try {
        return json(await setToken(body.access_token));
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 401);
      }
    }

    // @ref LLP 0002 r4 — the login button: the browser flow with a loopback
    // callback and PKCE. The code is exchanged for a token by whoever holds
    // the client secret: this sidecar when `.env` has GITHUB_CLIENT_SECRET
    // (dev), else the hosted exchange endpoint (config.github.oauthExchangeUrl).
    if (request.method === 'POST' && path === '/oauth/start') {
      const state = randomBytes(24).toString('base64url');
      const verifier = randomBytes(48).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;
      oauthFlows.set(state, { verifier, redirectUri, token: null, error: null, startedAt: Date.now() });
      const q = new URLSearchParams({ client_id: config.github.oauthClientId, redirect_uri: redirectUri, scope: config.github.scopes.join(' '), state, code_challenge: challenge, code_challenge_method: 'S256' });
      return json({ state, url: `https://github.com/login/oauth/authorize?${q}` });
    }

    if (request.method === 'GET' && path === '/oauth/callback') {
      const code = url.searchParams.get('code') ?? '';
      const state = url.searchParams.get('state') ?? '';
      const flow = oauthFlows.get(state);
      if (!flow || !code) return new Response(oauthPage('This sign-in link is not one revu started.', false), { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      try {
        const accessToken = await exchangeCode(code, flow.verifier, flow.redirectUri);
        await setToken(accessToken);
        flow.token = accessToken;
        return new Response(oauthPage(`Signed in as ${login}. You can close this tab and go back to revu.`, true), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      } catch (error) {
        flow.error = error instanceof Error ? error.message : String(error);
        return new Response(oauthPage(`Sign-in failed: ${flow.error}`, false), { status: 500, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
    }

    // The app polls this on its clock; the token is handed over once.
    if (request.method === 'GET' && path === '/oauth/result') {
      const state = url.searchParams.get('state') ?? '';
      const flow = oauthFlows.get(state);
      if (!flow) return json({ status: 'unknown' }, 404);
      if (flow.error) { oauthFlows.delete(state); return json({ status: 'error', error: flow.error }); }
      if (flow.token) { oauthFlows.delete(state); return json({ status: 'ok', access_token: flow.token, login }); }
      if (Date.now() - flow.startedAt > 10 * 60_000) { oauthFlows.delete(state); return json({ status: 'expired' }); }
      return json({ status: 'pending' });
    }

    // Dev loop only: the app hands its token here at review time; a local
    // tool may read it back to seed the app's own store (loopback only).
    if (request.method === 'GET' && path === '/auth/token') {
      return token ? json({ access_token: token, login }) : json({ error: 'no token yet' }, 404);
    }

    if (request.method === 'DELETE' && path === '/auth/token') {
      clearToken();
      return json({ ok: true });
    }

    if (request.method === 'GET' && path === '/prs') {
      return json(snapshot());
    }

    if (request.method === 'POST' && path === '/poll') {
      if (!client) return json({ error: 'not authenticated' }, 401);
      await pollOnce();
      return json(snapshot());
    }

    if (request.method === 'GET' && path === '/skills') {
      return json(listSkills());
    }

    const skill = path.match(/^\/skills\/([^/]+)$/);
    if (request.method === 'GET' && skill) {
      try {
        return json(readSkill(decodeURIComponent(skill[1]!)));
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 404);
      }
    }
    if (request.method === 'PUT' && skill) {
      const body = (await request.json().catch(() => ({}))) as { content?: string };
      if (typeof body.content !== 'string') return json({ error: 'content is required' }, 400);
      try {
        return json(writeSkill(decodeURIComponent(skill[1]!), body.content));
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
    }

    if (request.method === 'GET' && path === '/reviews') {
      return json(listJobs());
    }

    if (request.method === 'POST' && path === '/reviews') {
      if (!token) return json({ error: 'not authenticated' }, 401);
      const body = (await request.json()) as ReviewJobRequest;
      if (!body?.repo || !body?.number || !body?.headSha || !body?.baseSha) {
        return json({ error: 'repo, number, baseSha and headSha are required' }, 400);
      }
      let runner;
      try {
        runner = runnerFor(body.agent);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
      const job = startReview(body, token, runner, (j) => broadcast({ type: 'review', job: j }));
      return json(job, 202);
    }

    const review = path.match(/^\/reviews\/([^/]+)$/);
    if (request.method === 'GET' && review) {
      const job = getJob(decodeURIComponent(review[1]!));
      if (!job) return json({ error: 'not found' }, 404);
      const { patches: _p, ...slim } = job;
      // The hunks need the token; without one the window shows the comments alone.
      const hunks = job.result && token ? await hunksFor(job, token).catch(() => []) : [];
      return json({ ...slim, hunks });
    }
    const file = path.match(/^\/reviews\/([^/]+)\/file$/);
    if (request.method === 'GET' && file) {
      if (!token) return json({ error: 'not authenticated' }, 401);
      const job = getJob(decodeURIComponent(file[1]!));
      if (!job) return json({ error: 'not found' }, 404);
      const filePath = url.searchParams.get('path') ?? '';
      const side = url.searchParams.get('side') === 'LEFT' ? 'LEFT' : 'RIGHT';
      if (!filePath) return json({ error: 'path is required' }, 400);
      const got = await fileAt(job, token, filePath, side).catch(() => null);
      return got ? json(got) : json({ error: 'the file could not be fetched' }, 502);
    }

    const post = path.match(/^\/reviews\/([^/]+)\/post$/);
    if (request.method === 'POST' && post) {
      if (!token) return json({ error: 'not authenticated' }, 401);
      const job = getJob(decodeURIComponent(post[1]!));
      if (!job) return json({ error: 'not found' }, 404);
      const body = (await request.json().catch(() => ({}))) as { comments?: number[]; verdict?: string; edits?: Record<string, string> };
      try {
        const posted = await postReview(job, body.comments ?? [], token, body.verdict, body.edits ?? {});
        broadcast({ type: 'review', job });
        return json(posted);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 500);
      }
    }
    if (request.method === 'DELETE' && review) {
      const job = cancelJob(decodeURIComponent(review[1]!));
      if (job) broadcast({ type: 'review', job });
      return job ? json(job) : json({ error: 'not found' }, 404);
    }

    const seen = path.match(/^\/prs\/(.+)\/seen$/);
    if (request.method === 'POST' && seen) {
      const body = (await request.json().catch(() => ({}))) as { seen?: boolean };
      markSeen(db, decodeURIComponent(seen[1]!), body.seen ?? true);
      broadcast(snapshot());
      return json({ ok: true });
    }

    return json({ error: 'not found' }, 404);
  },
  websocket: {
    open(ws) {
      sockets.add(ws);
      ws.send(JSON.stringify(snapshot()));
    },
    close(ws) {
      sockets.delete(ws);
    },
    message() {},
  },
});

console.log(`[revu-sidecar] ${loadPersistedJobs()} past reviews loaded`);
console.log(`[revu-sidecar] listening on http://${host}:${server.port}  (db: ${db.filename})`);
