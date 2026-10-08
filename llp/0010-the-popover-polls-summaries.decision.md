# LLP 0010: What the popover polls must be small

**Type:** Decision
**Status:** Active (2026-10-07)
**Systems:** Sidecar, App
**Author:** Gabriel Donadel Dall'Agnol / Claude
**Date:** 2026-10-07
**Related:** LLP 0001 (the sidecar split), LLP 0004 (review jobs), LLP 0006 (the popover)

## The report

Gabriel, on rc.10: "the app constantly stalls when I click in the menu bar
showing the beachball". An idle sample of the app is clean, and the module's
click path has no synchronous wait, so the stall is not the click: it is
work the app does *anyway*, seen only when the pointer is over the app's own
window — a menu bar app has no window the rest of the time.

## The cause

The plan's sources run in Hermes **on the main thread** (exact2's
`ExactNativeModule.swift`: a TypeScript answer holds the main thread while
it runs). Three of them polled the sidecar and parsed what came back:

- `recentReviews` (`GET /reviews`) each minute, and `priorReview` (the same
  route) every 30 s while a pull request was open. The route answered with
  **every job as it sits in memory**: the full agent transcript (`output`),
  the pull request's per-file `patches`, and `files` — whole files, both
  sides, kept for the finding's "expand". After a few reviews of real pull
  requests that is megabytes, parsed on the main thread each time.
- `reviewJob` (`GET /reviews/:id`) every 5 s for as long as a job is on
  screen, done or not. The route dropped `patches` but sent `files` and the
  whole transcript, and recomputed every finding's hunks each time.

A short stall per poll, several polls a minute, forever: a beachball on
whichever click happens to land during one.

## Decision

- **`GET /reviews` answers summaries** (`ReviewSummary`, `review.ts`): id,
  the request without its body, status, times, error, `posted`, and two
  numbers the list needs — `findings` and `verdict`. It takes `?repo=&number=`
  so `priorReview` filters on the sidecar, not in the plan.
- **`GET /reviews/:id` answers `detail(job, hunks)`**: no `patches`, no
  `files`; the transcript's last 64 KB (the window shows its last 200
  lines) with `outputLines` and `ghCalls` counted over the whole of it, so
  the progress step and the "N gh calls" stay right. Whole files keep their
  own route (`/reviews/:id/file`), fetched one at a time on expand.
- **Reads of the sidecar are independent HTTP** (`exactIndependentHttp`,
  LLP 1041 in exact2): a slow `GET` no longer holds the ordered lane the
  module's calls and the other sidecar requests queue on. Writes (start,
  cancel, post, save skill) stay ordered.
- **A reopen shows the popover**: `applicationShouldHandleReopen` is added to
  ExactMac's delegate as the quit answer was (LLP 0006 D3), so the Dock,
  Finder and `open -a revu` all do what a click on the item does — and the
  popover can be driven from a shell when no Accessibility grant is at hand.

## Consequences

- The Reviewed tab and the prior-review card read `findings`/`verdict` from
  the summary; nothing in the popover sees a comment body until the review
  window asks for the job.
- A job's persisted file still carries its `patches` (slimmed of `files` and
  to 4 KB of transcript); that is disk, not the poll.
- Measured on the build Mac with two finished reviews on disk: the list went
  from 140 KB to 1.2 KB; a job's detail is under 10 KB.
