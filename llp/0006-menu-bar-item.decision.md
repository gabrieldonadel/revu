# LLP 0006: The menu bar item is the module's; the host's window is the popover

**Type:** Decision
**Status:** Active (implemented 2026-09-30)
**Systems:** App, Notifications
**Author:** Gabriel Donadel Dall'Agnol / Claude
**Date:** 2026-09-30
**Related:** LLP 0003, LLP 0005

## Decision

On macOS revu is a menu bar app, as designed (design 1b: the pull-request
icon with the pending count; 1d: a spinner while a review runs). The same
native module that posts notifications (`revu-app/modules/apple/Notifier.swift`,
LLP 0003) owns an `NSStatusItem`, and turns the host's one window into the
popover under it:

- The Dock icon goes: `NSApp.setActivationPolicy(.accessory)` at module load.
- The window keeps its class (ExactMac's `ExactWindow`) but loses its title
  bar and buttons (`.titled` + `.fullSizeContentView`, transparent, hidden
  controls), floats, follows the active Space, is 380 × 600 like the design's
  popover, and is placed under the item on the item's screen.
- A click on the item shows or hides it; it hides when the app deactivates
  (a click anywhere else). It is **hidden, never closed**: ExactMac ends the
  session when its window closes.
- A right-click gives **Open revu**, **Settings…** and **Quit revu**.
- The app drives the item over `native.call({ op: "tray", count, busy })`
  from a `trayState` resource that follows the inbox's total and whether a
  review job is running.
- A notification's **Open** (or a click on its body) shows the popover.

### D2 — Settings is a window of its own; windows are sessions with a role

Design 1f is an 880 × 640 window, not a popover page. ExactMac opens a
second window only as a second session of the same plan (`launch_handler`
`navigate-new`, ⌘N / `newWindowForTab:`), so revu sets that launch mode and
the module drives it: the popover's `native.later({ op: "window", kind })`
records the kind, sends `newWindowForTab:` down the responder chain, and the
new session's module instance — one per session (LLP 1067.000) — takes the
pending kind as its **role**. The plan asks `windowRole()` and a "settings"
session draws settings whatever its nav says, with the wide two-pane layout;
its clock neither polls nor announces (that is the popover's session), and
only the popover's instance is the notification centre's delegate.

The settings window keeps its traffic lights; its close button hides it
(the session stays for the next open), ⌘W closes it and the next open boots
afresh. On the web, where there are no windows, Settings stays a route.

### D3 — The delegate's "quit after the last window closes" is overridden

AppKit runs that check when the last visible window is hidden, not only
closed — a popover's every dismissal — and ExactMac's delegate answers yes.
The module replaces that one answer on the delegate's class at load
(`method_setImplementation`) with "no": an accessory app lives in the bar
and quits from its item's menu or ⌘Q. This is the one place the module
reaches into the host; a host-side "accessory" launch mode would retire it.

## Why

Exact2 has no host menu bar capability (LLP 0003 §Why); the app module can
reach AppKit in-process, which is enough for the item and for restyling
the window — no host change, no waiver. Reusing the host's window keeps the
runner, the agent driver, and the window's session as they are; a second
window or an `NSPopover` with a foreign content view would not.

A titled-but-transparent window rather than a borderless one, because a
borderless `NSWindow` cannot become key unless its class says so, and the
window's class is the host's. The transparent title bar takes no clicks from
the content (the Exact view is the hit target) and the window is not
movable, so it behaves as a popover.

Polling keeps running while the popover is hidden: an ordered-out window is
not "hidden" to the page (ExactMac's `PageFacts.hidden` looks at visible
windows only), and the runner pauses nothing on that fact anyway.

## Consequences

- The bare binary (`bun run app:mac`, no bundle identity) keeps its normal
  window and Dock icon: the item needs a bundle, as notifications do.
- Under the agent driver no item is made; the window stays a window, so
  drives are unchanged.
- The window frame autosave is switched off; the popover's place is the
  item's.
- ⌘Q works while the popover is key; otherwise the item's menu quits.
