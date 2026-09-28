---
name: exact-inspect
description: Inspect, verify, and debug a running Exact app through Acto's snapshot-first workflow.
---

<!-- Generated: Acto scaffold skill -->
<!-- Authority: packages/exact-cli/skills/skills-manifest.json + tagged docs fragments -->
<!-- Generator: bun scripts/generate-skills-content.mjs --write -->
<!-- LLP: 0340 -->
<!-- Committed: yes -->
<!-- Input digest: 1d9f220d80f9b236049dfd317bc40cdc227f8a96eaa1d2d3a060b5d9c61086b2 -->
<!-- Source commit: 994dc6ef373f88aa956412a3a5066c017829c1ba (excluded from equality) -->

# exact-inspect

## Versioned source and fallback order

1. When an app is running, prefer `exact_onboarding` or `GET /agent/onboarding`; it describes the runtime actually being driven.
2. Pre-boot/offline, use the stamped snapshot below. The v1 catalog is checkout-gated, so the scaffold intentionally omits an unusable CLI rung.

Acto is Exact's built-in agent subsystem — the way an AI agent (or a script,
or a curious human with `curl`) sees and drives a running Exact app. This
guide teaches the mental model and the core working loop. It is deliberately
short; use the full Agent API reference when you need endpoint-by-endpoint
detail.

If you are an agent and an Exact app is running, **Acto is your eyes and
hands**. Reach for it before screenshots-by-hand, generic browser automation,
or log archaeology.

> **On the name.** Acto (LLP 0321) is the internal working name for the whole
> subsystem — inspector, agent server, MCP tools, HTTP surfaces, clients, and
> replay. The wire names are older and unchanged: MCP tools are `exact_*`,
> HTTP routes are `/agent/*`, the dev-server relay is `/__exact/agent/*`, and
> the TypeScript client is `ExactAgent`. When you see those names, you are
> looking at Acto.

Three ideas carry the whole API. Get these and everything else is detail.

**A snapshot is a consistency token.** Most reads return a `snapshotId` —
"the UI as of this observation." Refs, annotated screenshots, and trees from
one snapshot describe the same instant.

**Refs are snapshot-local handles.** Targetable elements get refs like `@e1`.
A ref means nothing without the `snapshotId` that minted it, and it can go
stale when the app re-renders. A stale ref fails with `409 stale-snapshot` plus a
typed reason and remedy — the answer is almost always: take a fresh snapshot,
re-find your element, retry once.

**Errors have one first-failure order.** Acto resolves operation name, tier,
schema, capability, pins, mode, target, evidence axes, then dispatchability.
An unknown HTTP name therefore returns `404 unknown-op` even when its body and
authorization are also invalid. Error envelopes carry `actoSurfaceVersion: 2`.

**Target evidence is generation-bound.** Refs die with their snapshot, and a
numeric `viewId` is a snapshot-local logical key, never standalone identity.
Only `snapshotId` scopes it; `rootId` does not. After structural change,
re-find or re-resolve the target; use `exact_correlate` only with a current
correlation handle.

Two more things worth knowing before you act:

- **Roots.** Modals, sheets, and overlays can live in a separate UI root.
  If the thing you're looking for isn't in the tree, list `exact_roots` and
  pass `rootId` explicitly.
- **Coordinates are root-local points, not pixels.** Frames fold in scroll
  offsets the inspector has observed; an element can have a frame far outside
  the viewport and still be perfectly real.

### Targeting order

When you interact, identify the target this way, best first:

1. `ref` + `snapshotId` — precise and validated
2. `testId` — stable, author-assigned (this is why every significant Contract
   node should carry one)
3. accessibility `label`
4. `viewId` + `snapshotId` — a bare `viewId` is refused
5. raw `x`/`y` coordinates — last resort; least stable, no receipts about
   what you actually hit

Everything you do with Acto is some version of: **observe → act → observe
again**.

### 1. Observe: one bundled snapshot

Start every session — and every new screen — with a single bundled snapshot
rather than separate tree and screenshot calls (refs are snapshot-local, so
separate calls give you refs from *different* instants):

```text
exact_snapshot({
  include: ["tree", "screenshot", "diagnostics"],
  treeFormat: "yaml",
  screenshot: { annotate: true }
})
```

or over HTTP: `POST /__exact/agent/snapshot` with the same body. Keep the
returned `snapshotId`. The annotated screenshot stamps the same `@eN` refs
onto the image, so the picture and the tree agree.

For tree-only reads, `exact_tree` with `format="dense"` is the recommended
mid-density view: structure plus refs, testIds, values, states, and frames on
targetable nodes. `format="yaml"` is structure-only; drill into one subtree
with `viewId` + `snapshotId` + `format="full"` when you need everything about
a little rather than a little about everything.

### 2. Act

- `exact_tap` — press things
- `exact_type` — text entry (supports `clearFirst`)
- `exact_set_value` — change-driven controls like sliders, without faking a drag
- `exact_scroll` / host scroll — see "Scrolling on native" below
- `exact_gesture` — swipe, pinch, longPress
- `exact_navigate` — drive the router directly

Pass `ref` + `snapshotId` (or `testId`). Check `data.dispatched`, not the
HTTP status: a blocked interaction (typed `failure`) is a **422**
`action-refused` error whose typed `details` name the interactability failure
and whose `data` keeps the full receipt — branch on
`failure.remedy`. A 200 with `dispatched: false` and no `failure` means no
handler ran. `nativeReachability.reachesTarget: false` after a semantic
dispatch is a bug you just found, not a success.

### 3. Observe again — cheaply

After a mutation, don't re-dump the world. In order of preference:

- **`observeAfter` on the action itself.** Any mutating call accepts
  `observeAfter: { include: [...] }` and returns the post-action bundle
  inline — act and observe in one round trip, settle-gated by default so you
  see the UI after animations and navigation quiesce.
- **A diff.** `POST /agent/tree` with
  `{ "since": "<oldSnapshotId>", "diffMode": "semantic" }` gives
  you an added/removed/updated summary instead of a full tree.
- **A fresh bundled snapshot** — when the screen genuinely changed shape.

And when you need to wait for something, **use `exact_wait`, never sleep**.
Conditions (`viewExists`, `textContains`, `idle`, `networkIdle`,
`animationSettled`, `navigationSettled`, `visible`, `interactable`,
`floatingPositioned`, `presencePhase`, `focusTrapped`, `dismissed`, and
`semanticState`) are event-sourced and typically resolve in single-digit
milliseconds after the condition becomes true, instead of on a poll tick.

### Which Acto surface should I use?

Use the smallest surface that can answer the question:

| Task | Start with | Escalate when |
| --- | --- | --- |
| Understand a screen | `exact_snapshot`, then `exact_tree format="dense"` or a semantic diff | Use `exact_layout` / `exact_diagnostics` for geometry; use pixels only for a genuinely visual claim. |
| Find an element | `exact_find` by `testId`, role, label, or text | Use `exact_resolve_target` for ambiguity, clipping, occlusion, or a recommended tap point. |
| Act once | `exact_tap`, `exact_type`, `exact_set_value`, or `exact_scroll` with a stable target | Use realistic host input only when the claim is that physical input reaches the native control. |
| Verify an effect | `observeAfter`, a semantic diff, or `exact_wait` | Re-snapshot only when the screen changed shape or the target ref went stale. |
| Judge pixels | `exact_screenshot` for your own inspection | Use `exact_visual_query` only when configured and the question cannot be answered from tree/layout/diagnostics. |
| Repeat a reviewed workflow | Record one session, export its sanitized flow with `exact replay export`, then run it with `exact replay run` | Replay re-resolves selectors; inspect drift receipts instead of treating weaker matches as identical. |
| Read or change document selection | `exact_selection` with `projection:"document"` or its `act` arm, then `exact_copy({preview:true})` | Use `exact_plan_drag` only when a physical cross-view gesture is the behavior under test. |
| Tune a Contract surface | `exact_design_mode` to select, preview an advertised affordance, then save or discard | Do not use it as a general source editor; it is a local/dev provenance-aware surface. |
| Compose a bounded multi-step local task | Ordinary tools first; use `exact_code_grant` + `exact_code` when composition materially reduces round trips | Keep the allowlist and ceilings narrow. Code Mode is local/dev, grant-bound, audited, and not arbitrary JavaScript. |
| Debug below semantics | `exact_hit_test`, `exact_native_probe` (`mode:"hit-test"` or `"inspect"`), logs, network, focus, or perf | Choose the probe that owns the disputed fact; do not infer native reachability from a semantic dispatch receipt. |

**Use Code Mode for local/dev composition.** It is not a broad default
recommendation until the LLP 0350/0326 benchmark gate promotes it. Grant only
what the program needs:

```text
exact_code_grant({sdkVersion:"acto-code-v1",
  operationAllowlist:["exact_type","exact_wait"],
  ceilings:{wallMs:5000, operations:4}})
exact_code({version:"acto-code-v1", language:"typescript-subset",
  grantId:"<grant-id>", waitMs:250,
  source:`await acto.type({testId:"station-search", clearFirst:true}, "Palo");
          await acto.wait({condition:"textContains", text:"Palo Alto"});
          return acto.pass("station found");`})
```

Poll `exact_code_status({executionId})` after `running`; review a `paused`
operation before `exact_code_resume`, or use `exact_code_cancel`. Stop at the
terminal `CodeReceipt`. The SDK is `observe`/`snapshot`, `tree`, `find`,
`resolveTarget`, `tap`, `type`, `setValue`, `scroll`, `wait`, and
`pass`/`fail`. The TypeScript subset forbids imports, ambient authority,
network/filesystem access, eval, workers, timers, time, and randomness.

Use it for understood multi-step or bounded-loop workflows, not one-off,
exploratory, unavailable-SDK, deployed, or multi-tenant work.
`exact_run_js` is a debug escape hatch.

Scaffolded apps check in `.mcp.json`; prefer its `exact_*` bridge while
`bun run dev` is running. The relay normally lives at
`http://127.0.0.1:8083/__exact/` (`EXACT_DEV_URL` overrides it), while a native
host may expose the direct local endpoint at
`http://127.0.0.1:9333/agent/`. Before the app boots, use the stamped skill
snapshot in `.claude/skills/exact-inspect/SKILL.md` or its `.agents` twin.
Once the app is reachable, `exact_onboarding` / `GET /agent/onboarding` wins
because it describes the runtime actually being driven.

<!-- exact-skills-stamp: input=1d9f220d80f9b236049dfd317bc40cdc227f8a96eaa1d2d3a060b5d9c61086b2 content=00bba440adebad6cde984d35dc6ff0a26b75c1febc66f7297688c0ab620123ec operation-consequence=882c19a9aa86f47ca8948440f112c328d9466b03fff86e379b61ef7cc19667ae -->
