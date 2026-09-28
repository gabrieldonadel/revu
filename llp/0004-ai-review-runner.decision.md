# LLP 0004: The AI-review runner

**Type:** Decision
**Status:** Draft (undecided — Gabriel to choose, 2026-09-28)
**Systems:** Sidecar, AI review
**Author:** Gabriel Donadel Dall'Agnol / Claude
**Date:** 2026-09-28
**Related:** LLP 0001 (the sidecar is the only place this can run), `skills/pr-review/SKILL.md`

## What is decided already

- A review is a **job** in the sidecar: check the PR head out into a worktree
  (bare mirror per repo, `refs/pull/N/head`), load the selected skill file,
  build one prompt (skill + PR facts), run the runner, stream its output,
  keep the result. `sidecar/src/review.ts`.
- The runner is one interface: `run({ worktree, prompt, skill, onChunk })`.
- Skills are `SKILL.md` directories in the LLP shape; `~/.config/revu/skills/`
  shadows the bundled `skills/`. The default is LLP-aware (`pr-review`).
- The app never posts to GitHub on the runner's behalf; the user does.

## Undecided: which runner

| | Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) | `claude -p` (CLI) |
|---|---|---|
| Auth | API key or SDK auth, configured in the sidecar | reuses the user's existing CLI login |
| Streaming | structured events, per-tool control | text stream; less structure |
| Tool control | allow-list tools, read-only enforceable | `--permission-mode`, coarser |
| Skills | pass the skill text in the prompt, or mount as a skill | the CLI already discovers `.claude/skills/` in the worktree |
| Setup cost | a dependency + a key | none if the CLI is installed |
| Product path | the one to ship | the one to demo first |

Until this is decided the sidecar's runner is `unconfigured` and a review
fails with that exact message.
