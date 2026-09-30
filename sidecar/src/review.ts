// @ref LLP 0001#sidecar-split — the one thing the app cannot do: run git and
// an agent. A review is a job: check the PR out into a worktree, load the
// selected skill, run the runner, stream its output, keep the result.
import { mkdirSync, existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { paths } from './config.ts';

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
  error: string | null;
  worktree: string | null; // the scratch directory — never a checkout
  result: ReviewResult | null; // the skill's JSON, read after the run
  resultPath: string | null;
  posted: { reviewId: number; url: string; count: number } | null;
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

export function buildPrompt(request: ReviewRequest, skill: string): string {
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
    'The current directory is an empty scratch directory.',
    '',
    `Write the findings JSON to ${resultPath(request)} exactly as the skill describes, then stop.`,
    'Do NOT run post-review.ts and do NOT post anything to GitHub: revu previews the',
    'comments and stages the review itself. Never clone the repository.',
    '',
    '## Description from the author',
    '',
    request.body.trim() || '(none)',
  ].join('\n');
}

/** Stage the chosen comments as a PENDING review on GitHub through the
 *  skill's own script (`post-review.ts post`), which re-resolves each
 *  comment's line against the live diff. Returns the review's id and URL. */
export async function postReview(job: ReviewJob, chosen: number[], token: string): Promise<{ reviewId: number; url: string; count: number }> {
  if (!job.result) throw new Error('nothing to post: the review has no result');
  const skill = listSkills().find((s) => s.name === (job.request.skill ?? DEFAULT_SKILL));
  const script = skill ? resolve(skill.path, '..', 'post-review.ts') : '';
  if (!script || !existsSync(script)) throw new Error('this skill has no post-review.ts');
  const comments = job.result.comments.filter((_, i) => chosen.includes(i));
  const subset = { ...job.result, comments };
  const file = `/tmp/revu-post-${job.request.number}-${Date.now()}.json`;
  writeFileSync(file, JSON.stringify(subset, null, 2));
  const env = { GITHUB_TOKEN: token, GH_TOKEN: token, PATH: [process.env.PATH, `${process.env.HOME}/.bun/bin`, '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean).join(':') };
  const out = await sh([process.execPath, 'run', script, 'post', file], job.worktree ?? '/tmp', env);
  const id = /review ID: (\d+)/.exec(out)?.[1];
  if (!id) throw new Error(`post-review.ts posted nothing: ${out.trim().split('\n').slice(-3).join(' ')}`);
  const posted = { reviewId: Number(id), url: `${job.result.pr_url}/files`, count: comments.length };
  job.posted = posted;
  return posted;
}

const jobs = new Map<string, ReviewJob>();
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
    error: null,
    worktree: null,
    result: null,
    resultPath: null,
    posted: null,
  };
  jobs.set(job.id, job);
  const controller = new AbortController();
  controllers.set(job.id, controller);
  void (async () => {
    try {
      job.status = 'preparing';
      onChange(job);
      try { unlinkSync(resultPath(request)); } catch { /* none yet */ }
      job.worktree = scratchDir(request);
      job.status = 'running';
      onChange(job);
      const skill = loadSkill(request.skill, (text) => { job.output += text; onChange(job); });
      const prompt = buildPrompt(request, skill);
      const final = await runner.run({
        worktree: job.worktree,
        prompt,
        skill: request.skill ?? DEFAULT_SKILL,
        token,
        model: request.model ?? '',
        signal: controller.signal,
        onChunk: (text) => {
          job.output += text;
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
      controllers.delete(job.id);
      job.finishedAt = new Date().toISOString();
      onChange(job);
    }
  })();
  return job;
}
