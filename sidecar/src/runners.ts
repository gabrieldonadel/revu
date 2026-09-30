// @ref LLP 0004 — the runners: the user's own local agent CLI, chosen in the
// app's Settings ▸ Model. Each runs non-interactively in a scratch directory
// with the skill's prompt, streams its progress as log lines, and leaves the
// skill's JSON (`/tmp/deep-code-review-<n>.json`) for the sidecar to read.
// The cwd is an empty scratch directory: the user's code is never checked
// out; the agent reads the PR through an authenticated `gh` (GH_TOKEN).
// Neither posts to GitHub: the app previews and posts (LLP 0005 1e).
import { existsSync } from 'node:fs';
import { delimiter } from 'node:path';

import type { Runner } from './review.ts';

export type AgentName = 'claude' | 'codex';

/** Where a login shell would find the CLIs; the app is launched without one. */
function searchPath(): string {
  const home = process.env.HOME ?? '';
  const extra = [`${home}/.local/bin`, `${home}/.bun/bin`, `${home}/.npm-global/bin`, '/opt/homebrew/bin', '/usr/local/bin'];
  return [...new Set([...(process.env.PATH ?? '').split(delimiter), ...extra])].filter(Boolean).join(delimiter);
}

function find(binary: string): string | null {
  for (const dir of searchPath().split(delimiter)) {
    const candidate = `${dir}/${binary}`;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Which agents this Mac has; the app's Model tab shows it. */
export function availableAgents(): Record<AgentName, { available: boolean; path: string }> {
  const claude = find('claude');
  const codex = find('codex');
  return {
    claude: { available: claude !== null, path: claude ?? '' },
    codex: { available: codex !== null, path: codex ?? '' },
  };
}

/** The agent's environment: a login shell's basics and the token — not the
 *  sidecar's own (a dev-run sidecar inherits its launcher's CLAUDE_* and
 *  tooling variables, which would point the agent at someone else's config). */
function agentEnv(token: string): Record<string, string> {
  const keep = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM'];
  const env: Record<string, string> = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k]!;
  env.PATH = searchPath();
  env.GH_TOKEN = token;
  env.GITHUB_TOKEN = token;
  // Dev only: point Claude Code at another config dir (never set by the app).
  if (process.env.REVU_DEV_CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = process.env.REVU_DEV_CLAUDE_CONFIG_DIR;
  return env;
}

function nowStamp(): string {
  return new Date().toTimeString().slice(0, 8);
}

async function pump(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = pending.indexOf('\n')) >= 0) {
      onLine(pending.slice(0, i));
      pending = pending.slice(i + 1);
    }
  }
  if (pending.trim()) onLine(pending);
}

function describeTool(name: string, input: Record<string, unknown>): string {
  const p = (k: string) => String(input[k] ?? '');
  switch (name) {
    case 'Read': return `reading ${p('file_path')}`;
    case 'Grep': return `searching ${p('pattern')}`;
    case 'Glob': return `listing ${p('pattern')}`;
    case 'Bash': return `$ ${p('command')}`;
    case 'Write': return `writing ${p('file_path')}`;
    case 'Task': return `exploring: ${p('description') || p('prompt')}`;
    default: return `${name.toLowerCase()} ${Object.values(input).map(String).join(' ')}`.trim();
  }
}

/** `claude -p`: the user's Claude Code login, `gh` as the only tool besides
 *  writing the skill's JSON under /tmp. Progress from stream-json. */
export const claudeRunner: Runner = {
  name: 'claude',
  async run({ worktree, prompt, token, model, signal, onChunk }) {
    const bin = find('claude');
    if (!bin) throw new Error('Claude Code is not installed (no `claude` on PATH)');
    const args = [
      '-p', '--verbose', '--output-format', 'stream-json',
      ...(model ? ['--model', model] : []),
      '--permission-mode', 'dontAsk',
      // No Read/Grep/Glob: there is nothing local to read; gh is the only
      // source. Absolute paths in permission rules start with `//`.
      '--allowedTools', 'Bash(gh *)', 'Write(//tmp/**)', 'Write(//private/tmp/**)', `Write(//${worktree.replace(/^\//, '')}/**)`,
      '--add-dir', '/tmp',
    ];
    const proc = Bun.spawn([bin, ...args], {
      cwd: worktree,
      env: agentEnv(token),
      stdin: new Response(prompt).body ?? undefined,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    signal.addEventListener('abort', () => proc.kill());
    let result = '';
    let stderr = '';
    const errs = pump(proc.stderr, (line) => { stderr += `${line}\n`; });
    await pump(proc.stdout, (line) => {
      let event: Record<string, any>;
      try { event = JSON.parse(line); } catch { return; }
      if (event.type === 'assistant') {
        for (const block of event.message?.content ?? []) {
          if (block.type === 'tool_use') onChunk(`${nowStamp()} ${describeTool(String(block.name), block.input ?? {})}\n`);
          else if (block.type === 'text' && String(block.text).trim()) onChunk(`${nowStamp()} ${String(block.text).trim().split('\n')[0]}\n`);
        }
      } else if (event.type === 'result') {
        result = String(event.result ?? '');
        if (event.is_error) onChunk(`${nowStamp()} error: ${result}\n`);
      }
    });
    await errs;
    const code = await proc.exited;
    if (signal.aborted) throw new Error('cancelled');
    if (code !== 0) throw new Error(`claude exited ${code}: ${stderr.trim().split('\n').slice(-3).join(' ') || result}`);
    return result;
  },
};

/** `codex exec`: the user's Codex CLI login; JSONL events for progress, the
 *  last message as the result. Not exercised on a Mac without Codex (LLP 0004). */
export const codexRunner: Runner = {
  name: 'codex',
  async run({ worktree, prompt, token, model, signal, onChunk }) {
    const bin = find('codex');
    if (!bin) throw new Error('Codex CLI is not installed (no `codex` on PATH)');
    const last = `/tmp/revu-codex-${Date.now()}.md`;
    const args = ['exec', '--json', '--sandbox', 'workspace-write', '--skip-git-repo-check', '-C', worktree, '--output-last-message', last, ...(model ? ['-m', model] : []), '-'];
    const proc = Bun.spawn([bin, ...args], {
      cwd: worktree,
      env: agentEnv(token),
      stdin: new Response(prompt).body ?? undefined,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    signal.addEventListener('abort', () => proc.kill());
    let stderr = '';
    const errs = pump(proc.stderr, (line) => { stderr += `${line}\n`; });
    await pump(proc.stdout, (line) => {
      let event: Record<string, any>;
      try { event = JSON.parse(line); } catch { return; }
      const item = event.item ?? event.msg ?? event;
      const kind = String(item.type ?? event.type ?? '');
      if (kind.includes('command')) onChunk(`${nowStamp()} $ ${String(item.command ?? item.cmd ?? '')}\n`);
      else if (kind.includes('reasoning') || kind.includes('message')) {
        const text = String(item.text ?? item.message ?? '').trim();
        if (text) onChunk(`${nowStamp()} ${text.split('\n')[0]}\n`);
      }
    });
    await errs;
    const code = await proc.exited;
    if (signal.aborted) throw new Error('cancelled');
    if (code !== 0) throw new Error(`codex exited ${code}: ${stderr.trim().split('\n').slice(-3).join(' ')}`);
    try { return await Bun.file(last).text(); } catch { return ''; }
  },
};

export const runners: Record<AgentName, Runner> = { claude: claudeRunner, codex: codexRunner };
