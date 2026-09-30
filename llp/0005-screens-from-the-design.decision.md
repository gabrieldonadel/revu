# LLP 0005: The screens follow the Claude Design file

**Type:** Decision
**Status:** Active (implemented 2026-09-30)
**Systems:** App
**Author:** Gabriel Donadel Dall'Agnol / Claude
**Date:** 2026-09-30
**Related:** LLP 0001, LLP 0003, LLP 0004

## Decision

`revu-app/app.contract` renders the six screens of the Claude Design
project "GitHub PR Review App" (`PR Review Menu Bar.dc.html`) on the Expo
design-system tokens (`colors_and_type.css`, light):

| Design | Route | What drives it |
| --- | --- | --- |
| 1a Onboarding — connect GitHub | `/` signed out | device flow (LLP 0002) |
| 1b Popover — pending requests | `/` signed in | `reviewRequests`: two searches, `review-requested:@me` and `user-review-requested:@me`; the difference is "Requested from teams" |
| 1c Popover — PR quick look | `/pr/:owner/:name/:number` | `prDetail`: the pull, its files, its check runs, the matched skill |
| 1d Popover — AI review in progress | `/pr/…/review` while the job runs | `reviewJob`: the sidecar's job, polled on the 5 s clock |
| 1e Review window — pick comments | `/pr/…/review` once the job is done | `reviewJob`: findings parsed from the runner's output |
| 1f Settings — skills by repository | `/settings` | `skillSettings`: rules in SQLite, skill files from the sidecar |

The window is sized like the design's popover (440 × 640) and stays one
window: 1e and 1f, drawn at 880 wide in the design, are laid out for the
narrow window instead of opening a second one.

## Why

The design is the agreed look; Contract can express it directly (flex
layout, `svg` for the Lucide icons, `line-clamp`, `text-transform`,
`letter-spacing`), so the tokens become `style` declarations and nothing
sits between the design and the plan. One window keeps the app inside what
Exact2 offers today; a menu bar popover and a second window are host
capabilities that arrive with the menu bar item (LLP 0003, deferred).

## What differs from the design, and why

- **Fonts.** Inter and JetBrains Mono are not bundled; `system-ui` and
  `ui-monospace` stand in. Contract refuses an undeclared family.
- **Teams.** The design's team rows carry a team name; GitHub's search
  does not, so the name comes from the pull's `requested_teams` (first
  slug), fetched once per pull and cached by `updated_at`.
- **Checks.** The CI dot reads the head commit's check runs: any failure →
  red, any incomplete → orange, else green; no runs → grey.
- **Unread.** The design has no unread state; here an unread title is
  semibold with "· new" after the checks label. Opening a request reads
  it, as the banner's **Mark read** does (LLP 0003).
- **1d steps.** The design's five steps map to the sidecar's job status:
  queued → checking-out → running (loaded skill, then reviewing once
  output arrives) → done. "Drafting comments" is never lit separately; the
  runner decides that (LLP 0004).
- **1e findings.** Parsed from the output the skill asks for
  (`- [BUG] path:line — title`, then body lines). Selecting a finding
  expands its body. The design's checkboxes and **Post N comments** are
  not wired: the skill forbids posting to GitHub, and the review is read in
  the window.
- **1f editing.** The skill viewer is read-only with line numbers, as
  drawn; **Edit** swaps in a `textarea`, **Save** writes through the
  sidecar to `~/.config/revu/skills/<name>/SKILL.md`, which shadows the
  bundled file — the bundled skill is never edited in place. Rules cannot
  be dragged; a new rule goes before the catch-all `*`, which stays last.
- **Tabs.** "General" shows the poll cadence, notification permission and
  sidecar state; "Accounts" holds sign-out; "Model" waits for LLP 0004.
- **Polling.** The inbox re-asks once a minute (`pollMs`) and on
  **Refresh**, not on every 5 s clock tick; only the announce (LLP 0003)
  and the device-flow poll ride the tick.

## Consequences

- Until LLP 0004 chooses a runner, **Run AI review** reaches 1d and ends
  in the "did not run" state with the sidecar's `runner unconfigured`.
- One pull costs three GitHub calls the first time it is seen (search
  item, pull, check runs); a settled pull costs none until it updates.
- The design file is the reference for look; this LLP is the reference
  for what the screens do. A change to either updates the other.
