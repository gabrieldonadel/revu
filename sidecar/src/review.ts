// @ref LLP 0001#sidecar-split — the one thing the app cannot do: run git and
// an agent. A review is a job: check the PR out into a worktree, load the
// selected skill, run the runner, stream its output, keep the result.
import { mkdirSync, existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { bundleDir, paths } from './config.ts';

export interface ReviewRequest {
  repo: string; // owner/name
  number: number;
  title: string;
  body: string;
  baseSha: string;
  headSha: string;
  headRef: string;
  skill?: string; // skill name under the skills directories; default 'deep-code-review'
  agent?: string; // 'claude' | 'codex' — the local CLI that runs it (LLP 0004)
  model?: string; // the CLI's model alias/name; empty = the CLI's own default
  url?: string; // the PR's html_url, for the skill's `gh` calls
}

/** The skill's structured result (deep-code-review's JSON), once the runner has written it. */
export interface ReviewResult {
  pr_url: string;
  owner: string;
  repo: string;
  pull_number: number;
  summary: string;
  verdict: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
  comments: Array<{ path: string; line: number; side: 'LEFT' | 'RIGHT'; body: string; severity: string; line_content?: string }>;
}

export interface ReviewJob {
  id: string;
  request: ReviewRequest;
  status: 'queued' | 'preparing' | 'running' | 'done' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  output: string; // streamed progress so far
  lastOutputAt: string | null; // when the agent last said anything
  error: string | null;
  worktree: string | null; // the scratch directory — never a checkout
  result: ReviewResult | null; // the skill's JSON, read after the run
  resultPath: string | null;
  posted: { reviewId: number; url: string; count: number; dropped: string[] } | null;
  patches?: Record<string, string>; // per-file patches, fetched once for the hunks
  files?: Record<string, string[]>; // whole files by side:path, for "expand"
}

/** What a runner must provide; the choice of runner is LLP 0004's decision. */
export interface Runner {
  name: string;
  /** Runs the review in `worktree`, calling `onChunk` as output arrives; resolves with the final text. */
  run(input: { worktree: string; prompt: string; skill: string; token: string; model: string; signal: AbortSignal; onChunk: (text: string) => void }): Promise<string>;
}

const skillDirs = [
  resolve(`${process.env.HOME}/.config/revu/skills`),
  resolve(import.meta.dir, '../../skills'),
  // A packaged sidecar (inside revu.app/Contents/Resources) ships its skills beside it.
  resolve(bundleDir, 'skills'),
];

export function listSkills(): Array<{ name: string; path: string; description: string }> {
  const out: Array<{ name: string; path: string; description: string }> = [];
  for (const dir of skillDirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = resolve(dir, entry.name, 'SKILL.md');
      if (!existsSync(file)) continue;
      if (out.some((s) => s.name === entry.name)) continue; // user dir shadows bundled
      const text = readFileSync(file, 'utf8');
      const description = /^description:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? '';
      out.push({ name: entry.name, path: file, description });
    }
  }
  return out;
}

/** The skill's text and where it lives; the user directory shadows the bundled one. */
export function readSkill(name: string): { name: string; path: string; content: string } {
  const skill = listSkills().find((s) => s.name === name);
  if (!skill) throw new Error(`no skill named ${name}`);
  return { name, path: skill.path, content: readFileSync(skill.path, 'utf8') };
}

/** Writes go to the user directory only, so a bundled skill is shadowed, never edited in place. */
export function writeSkill(name: string, content: string): { name: string; path: string } {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) throw new Error(`not a skill name: ${name}`);
  const dir = resolve(skillDirs[0]!, name);
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, 'SKILL.md');
  writeFileSync(path, content);
  return { name, path };
}

export const DEFAULT_SKILL = 'deep-code-review';

/** The named skill's text; a rule naming a skill that is not there falls back to the default, loudly. */
export function loadSkill(name = DEFAULT_SKILL, onChunk?: (text: string) => void): string {
  const skills = listSkills();
  let skill = skills.find((s) => s.name === name);
  if (!skill) {
    onChunk?.(`no skill named ${name}; using ${DEFAULT_SKILL}\n`);
    skill = skills.find((s) => s.name === DEFAULT_SKILL);
  }
  if (!skill) throw new Error(`no skill named ${name} and no ${DEFAULT_SKILL} (looked in ${skillDirs.join(', ')})`);
  return readFileSync(skill.path, 'utf8');
}

async function sh(cmd: string[], cwd: string, env: Record<string, string> = {}): Promise<string> {
  const proc = Bun.spawn(cmd, { cwd, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${cmd.join(' ')} failed (${code}): ${err.trim() || out.trim()}`);
  return out;
}

/**
 * The review never checks the user's code out (ruled 2026-09-30): the agent
 * works in an empty scratch directory and reads the pull request through
 * `gh` — its diff, its files, its metadata — nothing is cloned.
 */
export function scratchDir(request: ReviewRequest): string {
  const dir = resolve(paths.appSupport, '../../Caches/revu/scratch', `${request.repo.replace('/', '__')}-${request.number}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** The last JSON object with a `comments` array in a text, if any. */
export function salvageJson(text: string): ReviewResult | null {
  let best: ReviewResult | null = null;
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    if (!/"comments"/.test(text.slice(start, start + 4000)) && !/"comments"/.test(text.slice(start))) continue;
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (ch === '\\') i += 1;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            const parsed = JSON.parse(text.slice(start, i + 1)) as ReviewResult;
            if (Array.isArray(parsed.comments) && typeof parsed.summary === 'string') best = parsed;
          } catch { /* not this one */ }
          break;
        }
      }
    }
  }
  return best;
}

/** Where the deep-code-review skill writes its JSON. */
export function resultPath(request: ReviewRequest): string {
  return `/tmp/deep-code-review-${request.number}.json`;
}

/** The pull request as GitHub serves it, fetched once by the sidecar so the
 *  agent starts with everything: the unified diff (capped) and the file list. */
export async function fetchPullContext(request: ReviewRequest, token: string): Promise<{ diff: string; files: string; truncated: boolean }> {
  const headers = { Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'revu-sidecar' };
  const base = `https://api.github.com/repos/${request.repo}/pulls/${request.number}`;
  const [diffRes, filesRes] = await Promise.all([
    fetch(base, { headers: { ...headers, Accept: 'application/vnd.github.diff' } }),
    fetch(`${base}/files?per_page=100`, { headers: { ...headers, Accept: 'application/vnd.github+json' } }),
  ]);
  const limit = 160_000;
  let diff = diffRes.ok ? await diffRes.text() : `(the diff could not be fetched: ${diffRes.status})`;
  const truncated = diff.length > limit;
  if (truncated) diff = `${diff.slice(0, limit)}\n… (diff truncated at ${limit} characters; fetch the rest with gh pr diff)`;
  const list = filesRes.ok ? ((await filesRes.json()) as Array<{ filename: string; status: string; additions: number; deletions: number }>) : [];
  const files = list.map((f) => `- ${f.filename} (${f.status}, +${f.additions} −${f.deletions})`).join('\n') || '(file list unavailable)';
  return { diff, files, truncated };
}

export function buildPrompt(request: ReviewRequest, skill: string, context?: { diff: string; files: string }): string {
  const url = request.url ?? `https://github.com/${request.repo}/pull/${request.number}`;
  return [
    skill.trim(),
    '',
    '---',
    '',
    `# Task: review ${url} — ${request.title}`,
    '',
    `Base: ${request.baseSha}`,
    `Head: ${request.headSha} (${request.headRef})`,
    '',
    'Nothing is checked out locally and nothing may be cloned: read the pull request',
    `through \`gh\` only — \`gh pr diff ${url}\`, \`gh pr view ${url}\`, and \`gh api\` for the`,
    'contents of files you need (e.g. `gh api repos/{owner}/{repo}/contents/{path}?ref=<sha>`).',
    'The current directory is an empty scratch directory. You have NO Read, Grep, Glob, Task or',
    'Explore tools here — do not try them; every look at code is one `gh api` call (a file at',
    'the head sha, a tree listing, or `gh search code`). Batch what you need; keep the review focused.',
    '',
    'The diff and the changed-file list are below, already fetched — start from them; use',
    '`gh api` only for context the diff does not show (a full file at the head sha, callers).',
    '',
    `Finish by replying with the findings JSON exactly as the skill describes, as your final message,`,
    'in one ```json fenced block — that reply is how revu receives it. Do not write files, do NOT',
    'run post-review.ts and do NOT post anything to GitHub: revu previews the comments and stages',
    'the review itself. Never clone the repository.',
    '',
    '## Description from the author',
    '',
    request.body.trim() || '(none)',
    '',
    '## Changed files',
    '',
    context?.files ?? '(not fetched)',
    '',
    '## Diff',
    '',
    '```diff',
    context?.diff ?? '(not fetched)',
    '```',
  ].join('\n');
}

export interface HunkLine { kind: 'context' | 'add' | 'del'; old: number; new: number; text: string; target: boolean }

/** The diff lines around a comment's target, for the review window's diff
 *  card (design 1e): up to `around` lines each side within its hunk. */
export async function hunksFor(job: ReviewJob, token: string, around = 3): Promise<HunkLine[][]> {
  if (!job.result) return [];
  if (!job.patches) {
    job.patches = {};
    for (let page = 1; page <= 10; page += 1) {
      const res = await fetch(`https://api.github.com/repos/${job.request.repo}/pulls/${job.request.number}/files?per_page=100&page=${page}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'revu-sidecar' },
      });
      if (!res.ok) break;
      const list = (await res.json()) as Array<{ filename: string; patch?: string }>;
      for (const f of list) job.patches[f.filename] = f.patch ?? '';
      if (list.length < 100) break;
    }
    persist(job);
  }
  return job.result.comments.map((c) => {
    const patch = job.patches?.[c.path];
    if (!patch) return [];
    const lines: HunkLine[] = [];
    let oldN = 0; let newN = 0;
    for (const raw of patch.split('\n')) {
      const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (h) { oldN = Number(h[1]); newN = Number(h[2]); lines.push({ kind: 'context', old: -1, new: -1, text: raw, target: false }); continue; }
      if (raw.startsWith('\\')) continue;
      if (raw.startsWith('+')) { lines.push({ kind: 'add', old: -1, new: newN, text: raw.slice(1), target: false }); newN += 1; }
      else if (raw.startsWith('-')) { lines.push({ kind: 'del', old: oldN, new: -1, text: raw.slice(1), target: false }); oldN += 1; }
      else { lines.push({ kind: 'context', old: oldN, new: newN, text: raw.slice(1), target: false }); oldN += 1; newN += 1; }
    }
    const side = c.side === 'LEFT' ? 'old' : 'new';
    let at = lines.findIndex((l) => l[side] === c.line);
    if (at < 0 && c.line_content) at = lines.findIndex((l) => l.text.includes(c.line_content!.trim()));
    if (at < 0) return [];
    lines[at]!.target = true;
    // The whole enclosing hunk, header included (GitHub shows a hunk whole);
    // `around` only caps a huge one.
    let start = at; while (start > 0 && !lines[start]!.text.startsWith('@@')) start -= 1;
    let end = at + 1; while (end < lines.length && !lines[end]!.text.startsWith('@@')) end += 1;
    const cap = Math.max(around * 10, 40);
    const lo = Math.max(start, at - cap); const hi = Math.min(end, at + cap + 1);
    return lines.slice(lo, hi);
  });
}

/** The whole file a comment points at, at the pull request's head (RIGHT)
 *  or base (LEFT) commit, for the review window's "expand" (GitHub's ⤢).
 *  Fetched once per path and side, kept on the job. */
export async function fileAt(job: ReviewJob, token: string, path: string, side: 'LEFT' | 'RIGHT'): Promise<{ lines: string[]; sha: string } | null> {
  const sha = side === 'LEFT' ? job.request.baseSha : job.request.headSha;
  const key = `${side}:${path}`;
  job.files ??= {};
  if (job.files[key]) return { lines: job.files[key]!, sha };
  const res = await fetch(`https://api.github.com/repos/${job.request.repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${sha}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github.raw+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'revu-sidecar' },
  });
  if (!res.ok) return null;
  const text = await res.text();
  if (text.length > 2_000_000) return null;
  const lines = text.split('\n');
  job.files[key] = lines;
  return { lines, sha };
}

/** The pull request's diff on the new side: for each file, the right-side
 *  line numbers the diff shows and their text — what a review comment can
 *  anchor to. From the API's per-file `patch` (no clone, no `gh`). */
async function rightSideLines(request: ReviewRequest, token: string): Promise<Map<string, Map<number, string>>> {
  const files = new Map<string, Map<number, string>>();
  for (let page = 1; page <= 10; page += 1) {
    const res = await fetch(`https://api.github.com/repos/${request.repo}/pulls/${request.number}/files?per_page=100&page=${page}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'revu-sidecar' },
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status} for the diff`);
    const list = (await res.json()) as Array<{ filename: string; patch?: string }>;
    for (const f of list) {
      const lines = new Map<number, string>();
      let right = 0;
      for (const line of (f.patch ?? '').split('\n')) {
        const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (hunk) { right = Number(hunk[1]); continue; }
        if (line.startsWith('-')) continue;
        if (line.startsWith('\\')) continue;
        lines.set(right, line.slice(1));
        right += 1;
      }
      files.set(f.filename, lines);
    }
    if (list.length < 100) break;
  }
  return files;
}

/** Stage the chosen comments as a PENDING review on GitHub (no `event`),
 *  each line re-resolved against the live diff the way the skill's own
 *  post-review.ts does: `line_content` wins over the number when it is
 *  found; a comment whose line is not in the diff is dropped, not guessed.
 *  Returns the review's id and URL. */
export async function postReview(job: ReviewJob, chosen: number[], token: string, verdictOverride?: string, edits: Record<string, string> = {}): Promise<{ reviewId: number; url: string; count: number; dropped: string[] }> {
  if (!job.result) throw new Error('nothing to post: the review has no result');
  if (verdictOverride === 'APPROVE' || verdictOverride === 'REQUEST_CHANGES' || verdictOverride === 'COMMENT') job.result.verdict = verdictOverride;
  // The user's edited wording replaces the agent's for the comments they changed.
  const wanted = job.result.comments
    .map((c, i) => (typeof edits[String(i)] === 'string' && edits[String(i)]!.trim() ? { ...c, body: edits[String(i)]!.trim() } : c))
    .filter((_, i) => chosen.includes(i));
  if (wanted.length === 0) throw new Error('no comments chosen');
  const diff = await rightSideLines(job.request, token);
  const dropped: string[] = [];
  const comments: Array<{ path: string; line: number; side: string; body: string }> = [];
  for (const c of wanted) {
    const lines = diff.get(c.path);
    if (!lines) { dropped.push(`${c.path}: not in the diff`); continue; }
    let line = c.line;
    if (c.line_content) {
      const needle = c.line_content.trim();
      const hits = [...lines.entries()].filter(([, text]) => text.includes(needle)).map(([n]) => n);
      if (hits.length) line = hits.reduce((best, n) => (Math.abs(n - c.line) < Math.abs(best - c.line) ? n : best), hits[0]!);
    }
    if (!lines.has(line)) { dropped.push(`${c.path}:${c.line}: line not in the diff`); continue; }
    const label = c.severity === 'critical' ? '🔴 **critical**' : c.severity === 'design' ? '🟡 **design**' : c.severity === 'suggestion' ? '🔵 **suggestion**' : '⚪ **nit**';
    comments.push({ path: c.path, line, side: c.side || 'RIGHT', body: `${label} — ${c.body}` });
  }
  if (comments.length === 0) throw new Error(`nothing could be anchored to the diff: ${dropped.join('; ')}`);
  const verdict = job.result.verdict === 'APPROVE' ? '✅ APPROVE' : job.result.verdict === 'REQUEST_CHANGES' ? '🔴 REQUEST_CHANGES' : '💬 COMMENT';
  const res = await fetch(`https://api.github.com/repos/${job.request.repo}/pulls/${job.request.number}/reviews`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'revu-sidecar', 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: `**Suggested verdict: ${verdict}**\n\n${job.result.summary}`, comments }),
  });
  const body = (await res.json().catch(() => ({}))) as { id?: number; html_url?: string; message?: string };
  if (!res.ok) throw new Error(`GitHub refused the review (${res.status}): ${body.message ?? ''}`);
  const posted = { reviewId: Number(body.id ?? 0), url: `${job.result.pr_url}/files`, count: comments.length, dropped };
  job.posted = posted;
  persist(job);
  return posted;
}

const jobs = new Map<string, ReviewJob>();

/** Finished jobs live on disk (without their transcript's bulk), so a result
 *  outlives the sidecar and the review window can open it later. */
const jobsDir = resolve(paths.appSupport, 'reviews');

function persist(job: ReviewJob): void {
  try {
    mkdirSync(jobsDir, { recursive: true });
    const { files: _files, ...rest } = job;
    const slim = { ...rest, output: job.output.slice(-4000) };
    writeFileSync(resolve(jobsDir, `${job.id.replace(/[^a-z0-9._-]/gi, '_')}.json`), JSON.stringify(slim));
  } catch { /* the disk is not the job's problem */ }
}

export function loadPersistedJobs(): number {
  if (!existsSync(jobsDir)) return 0;
  let n = 0;
  for (const entry of readdirSync(jobsDir)) {
    if (!entry.endsWith('.json')) continue;
    try {
      const job = JSON.parse(readFileSync(resolve(jobsDir, entry), 'utf8')) as ReviewJob;
      if (job.id && !jobs.has(job.id)) { jobs.set(job.id, job); n += 1; }
    } catch { /* skip a bad file */ }
  }
  return n;
}
let counter = 0;

export function getJob(id: string): ReviewJob | undefined {
  return jobs.get(id);
}

/** A cancel marks the job failed; a runner that honours `signal` stops. */
export function cancelJob(id: string): ReviewJob | undefined {
  const job = jobs.get(id);
  if (!job) return undefined;
  if (job.status === 'done' || job.status === 'failed') return job;
  job.status = 'failed';
  job.error = 'cancelled';
  job.finishedAt = new Date().toISOString();
  controllers.get(id)?.abort();
  return job;
}

const controllers = new Map<string, AbortController>();

export function listJobs(): ReviewJob[] {
  return [...jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function startReview(request: ReviewRequest, token: string, runner: Runner, onChange: (job: ReviewJob) => void): ReviewJob {
  const job: ReviewJob = {
    id: `review:${Date.now()}:${++counter}`,
    request,
    status: 'queued',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    output: '',
    lastOutputAt: null,
    error: null,
    worktree: null,
    result: null,
    resultPath: null,
    posted: null,
  };
  jobs.set(job.id, job);
  const controller = new AbortController();
  controllers.set(job.id, controller);
  // A review that has not ended in 20 minutes is stuck, not thorough.
  const deadline = setTimeout(() => {
    if (job.status === 'done' || job.status === 'failed') return;
    job.status = 'failed';
    job.error = 'no result after 20 minutes; the agent was stopped';
    job.finishedAt = new Date().toISOString();
    controller.abort();
    onChange(job);
  }, 20 * 60_000);
  void (async () => {
    try {
      job.status = 'preparing';
      onChange(job);
      try { unlinkSync(resultPath(request)); } catch { /* none yet */ }
      job.worktree = scratchDir(request);
      job.status = 'running';
      onChange(job);
      const skill = loadSkill(request.skill, (text) => { job.output += text; onChange(job); });
      const context = await fetchPullContext(request, token);
      job.output += `sidecar: fetched the diff (${Math.round(context.diff.length / 1024)} KB${context.truncated ? ', truncated' : ''}) and ${context.files.split('\n').length} files\n`;
      onChange(job);
      const prompt = buildPrompt(request, skill, context);
      const final = await runner.run({
        worktree: job.worktree,
        prompt,
        skill: request.skill ?? DEFAULT_SKILL,
        token,
        model: request.model ?? '',
        signal: controller.signal,
        onChunk: (text) => {
          job.output += text;
          job.lastOutputAt = new Date().toISOString();
          onChange(job);
        },
      });
      if (final && !job.output) job.output = final;
      // The skill's JSON is the result; the transcript is only progress.
      const path = resultPath(request);
      job.resultPath = path;
      // An agent that could not write the file usually prints the JSON in
      // its last message instead; take it from there.
      if (!existsSync(path)) {
        const salvaged = salvageJson(final) ?? salvageJson(job.output);
        if (salvaged) {
          writeFileSync(path, JSON.stringify(salvaged, null, 2));
          job.output += `sidecar: took the findings JSON from the agent's message\n`;
        }
      }
      if (existsSync(path)) {
        try {
          job.result = JSON.parse(readFileSync(path, 'utf8')) as ReviewResult;
        } catch (e) {
          throw new Error(`the skill's JSON at ${path} is unreadable: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else if ((job.status as ReviewJob['status']) !== 'failed') {
        throw new Error(`the agent finished without writing ${path}; its last words: ${final.trim().slice(-300) || '(none)'}`);
      }
      // A cancel may have flipped the status while the runner was running.
      if ((job.status as ReviewJob['status']) !== 'failed') job.status = 'done';
    } catch (error) {
      if ((job.status as ReviewJob['status']) !== 'failed') {
        job.status = 'failed';
        job.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      clearTimeout(deadline);
      controllers.delete(job.id);
      job.finishedAt = new Date().toISOString();
      persist(job);
      onChange(job);
    }
  })();
  return job;
}
