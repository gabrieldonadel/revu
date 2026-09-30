# LLP 0004: The AI-review runner is the user's local agent CLI

**Type:** Decision
**Status:** Active (decided 2026-09-30; Claude Code exercised, Codex CLI written from its documentation)
**Systems:** Sidecar, AI review, App (Settings ▸ Model, review results)
**Author:** Gabriel Donadel Dall'Agnol / Claude
**Date:** 2026-09-28, revised 2026-09-30
**Related:** LLP 0001 (the sidecar is the only place a process can run), LLP 0005 (1d/1e), `skills/deep-code-review/`

## Decision

A review runs on the **local agent CLI the user already has and is logged
into** — Claude Code (`claude -p`) or the Codex CLI (`codex exec`) — chosen
in Settings ▸ Model and kept in the app's SQLite (`settings.agent`). The
sidecar's `/health` reports which CLIs this Mac has; a review names its agent
per job (`POST /reviews { agent }`). No SDK, no API key in revu.

**The user's code is never checked out.** Ruled by Gabriel 2026-09-30:
"Never ever do a local checkout of users code in the reviews." The sidecar
clones nothing and adds no worktrees. The agent runs in an empty scratch
directory (`~/Library/Caches/revu/scratch/<repo>-<n>`) with `GH_TOKEN` set,
and reads the pull request through `gh` alone: `gh pr view`, `gh pr diff`,
`gh api …/contents/…`. Claude Code is given `Bash(gh *)` and
`Write(/tmp/*)` as its only tools; there is nothing local to read.

**The default skill is `deep-code-review`** (bundled from Gabriel's gist,
`skills/deep-code-review/`): context before critique, a single checklist,
findings as JSON at `/tmp/deep-code-review-<n>.json` with `critical` /
`design` / `suggestion` / `nit` severities and `line_content` anchors. The
runner's task prompt tells the agent to write that JSON and stop — never to
run `post-review.ts` — because posting is the app's (design 1e).

**Posting is the user's click.** The results screen shows the summary, the
verdict, and each comment with a checkbox; "Post N comments" stages the
chosen subset as a **pending** review the user finishes on GitHub. The
sidecar does what the skill's `post-review.ts post` does, natively (a
packaged sidecar has no `bun` to run the script): each comment's line is
re-resolved against the live diff (`line_content` wins), a comment whose
line is not in the diff is dropped and reported, never guessed.

## How progress reaches the window

`claude -p --output-format stream-json`: each `assistant` event's tool
uses become one log line (`$ gh pr diff …`, `writing /tmp/…`); the `result`
event ends the run. `codex exec --json`: JSONL items, commands and messages
as lines, `--output-last-message` as the result. The job's status is
`queued → preparing → running → done | failed`; the app maps it to the 1d
steps. A cancel aborts the process.

## Why this and not the SDK

The user's CLI login is the credential they already trust; revu holds no
model key. `gh` under the agent's control keeps the review's reach explicit
and remote-only, which is what "never check out" asks. The SDK stays
possible behind the same `Runner` interface if a hosted runner is wanted.

## Consequences

- Codex is unexercised on this Mac (no `codex` installed); its runner
  follows the CLI's documented flags and may need a flag or event-shape fix
  on first use.
- A review costs whatever the user's CLI plan meters; nothing is billed to revu.
- The `pr-review` skill (LLP-aware, markdown output) stays selectable but
  produces no JSON, so its result shows as a transcript without checkboxes.
