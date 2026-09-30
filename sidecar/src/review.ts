// @ref LLP 0001#sidecar-split — the one thing the app cannot do: run git and
// an agent. A review is a job: check the PR out into a worktree, load the
// selected skill, run the runner, stream its output, keep the result.
import { mkdirSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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
  skill?: string; // skill name under the skills directories; default 'pr-review'
}

export interface ReviewJob {
  id: string;
  request: ReviewRequest;
  status: 'queued' | 'checking-out' | 'running' | 'done' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  output: string; // streamed markdown so far
  error: string | null;
  worktree: string | null;
}

/** What a runner must provide; the choice of runner is LLP 0004's decision. */
export interface Runner {
  name: string;
  /** Runs the review in `worktree`, calling `onChunk` as output arrives; resolves with the final text. */
  run(input: { worktree: string; prompt: string; skill: string; signal: AbortSignal; onChunk: (text: string) => void }): Promise<string>;
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

export function loadSkill(name = 'pr-review'): string {
  const skill = listSkills().find((s) => s.name === name);
  if (!skill) throw new Error(`no skill named ${name} (looked in ${skillDirs.join(', ')})`);
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
 * One bare mirror per repository under the cache, one worktree per PR head.
 * The agent sees the whole tree, not just the diff — the LLP-aware skill
 * needs to follow `@ref`s into `llp/`.
 */
export async function checkout(request: ReviewRequest, token: string): Promise<string> {
  const cache = resolve(paths.appSupport, '../../Caches/revu/repos');
  const mirror = resolve(cache, `${request.repo}.git`);
  const worktree = resolve(cache, 'worktrees', request.repo.replace('/', '__'), `pr-${request.number}`);
  mkdirSync(resolve(cache, 'worktrees', request.repo.replace('/', '__')), { recursive: true });
  const remote = `https://x-access-token:${token}@github.com/${request.repo}.git`;
  const env = { GIT_TERMINAL_PROMPT: '0' };

  if (!existsSync(mirror)) {
    mkdirSync(cache, { recursive: true });
    await sh(['git', 'clone', '--bare', '--filter=blob:none', remote, mirror], cache, env);
  } else {
    await sh(['git', '--git-dir', mirror, 'remote', 'set-url', 'origin', remote], cache, env);
  }
  // Fetch the PR head and base explicitly; refs/pull/N/head exists on GitHub.
  await sh(['git', '--git-dir', mirror, 'fetch', '--force', 'origin', `refs/pull/${request.number}/head:refs/revu/pr/${request.number}`, request.baseSha], cache, env);

  if (existsSync(worktree)) {
    await sh(['git', '--git-dir', mirror, 'worktree', 'remove', '--force', worktree], cache, env).catch(() => undefined);
  }
  await sh(['git', '--git-dir', mirror, 'worktree', 'add', '--detach', worktree, request.headSha], cache, env);
  // Never leave the token in the worktree's remote config.
  await sh(['git', '--git-dir', mirror, 'remote', 'set-url', 'origin', `https://github.com/${request.repo}.git`], cache, env);
  return worktree;
}

export function buildPrompt(request: ReviewRequest, skill: string): string {
  return [
    skill.trim(),
    '',
    '---',
    '',
    `# Task: review ${request.repo}#${request.number} — ${request.title}`,
    '',
    `Base: ${request.baseSha}`,
    `Head: ${request.headSha} (${request.headRef})`,
    '',
    'The pull request is checked out in the current working directory at the head commit.',
    `Diff: \`git diff ${request.baseSha}...${request.headSha}\``,
    '',
    '## Description from the author',
    '',
    request.body.trim() || '(none)',
  ].join('\n');
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
  };
  jobs.set(job.id, job);
  const controller = new AbortController();
  controllers.set(job.id, controller);
  void (async () => {
    try {
      job.status = 'checking-out';
      onChange(job);
      job.worktree = await checkout(request, token);
      job.status = 'running';
      onChange(job);
      const skill = loadSkill(request.skill);
      const prompt = buildPrompt(request, skill);
      const final = await runner.run({
        worktree: job.worktree,
        prompt,
        skill: request.skill ?? 'pr-review',
        signal: controller.signal,
        onChunk: (text) => {
          job.output += text;
          onChange(job);
        },
      });
      if (final && !job.output) job.output = final;
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
