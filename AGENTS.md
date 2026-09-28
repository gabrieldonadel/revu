# revu

This is the canonical agent-instructions file for this project. `CLAUDE.md`
mirrors it (a symlink on unix).

## Framework policy

This project is authored in **Contract**, Exact's default UI framework
(LLP 0160). Author new UI surfaces as `.contract` components. Contract is
also the production-web scaffold default (LLP 0288); `--target web` records
web project intent but uses this same Contract starter today. The React tier
stays fully supported via `exact new --framework react`.

## Contract primer

A Contract component is one indent-structured `.contract` file: props,
`state`, `derive`d values, `action`s, an optional `contract` block of
checkable behavior claims, and the `view` tree. The routes under
`src/app/routes/` are working examples — this is `index.contract` (the `/`
route):

```contract
// The `/` route, scaffolded by `exact new` (LLP 0160, ENG-22451).
// Contract is Exact's default UI framework: state, actions, and the view
// live in one indent-structured file, and the `contract` block declares
// behavior the runtime (and agents) can check against the rendered tree.

use theme from "@exact/facet-contract"
use FacetButton from "@exact/facet-contract/components/button.contract"

component HomeRoute
  state count = 0

  derive doubled = count * 2

  action increment writes count
    count = count + 1

  action decrement writes count
    count = count - 1

  contract
    has text "Exact Counter"
    has button "Up"
    has button "Down"
    press button "Up" -> increment
    press button "Down" -> decrement
    has node testId="about-link"

  view
    column gap=theme.spacing.s4 padding=theme.spacing.s6 maxWidth=480 alignSelf="center" width="100%" background=theme.color.background.default
      text "Exact Counter" size=theme.type.small.fontSize weight=theme.type.small.fontWeight letterSpacing=theme.type.small.letterSpacing color=theme.color.text.link
      text `Count: ${count}` size=theme.type.h2.fontSize weight=theme.type.h2.fontWeight color=theme.color.text.default testId="counter-value"
      text `Doubled: ${doubled}` size=theme.type.p.fontSize color=theme.color.text.secondary testId="counter-doubled"
      row gap=theme.spacing.s2
        FacetButton(label="Up", press=increment, testId="increment")
        FacetButton(label="Down", variant="secondary", press=decrement, testId="decrement")
      link href="/about" label="About this app" testId="about-link"
        text "About this app" size=theme.type.small.fontSize weight=theme.type.small.fontWeight color=theme.color.text.link
```

Key rules the compiler enforces:

- `state name = expr` declares reactive state; `derive name = expr` is computed.
- `action name writes a, b` must declare every state it writes; undeclared
  writes are compile errors.
- Interactive view nodes (`button`, `input`) need a label or `testId`.
- `each item in items key=item.id` — keys are required on lists.
- `when expr` / `else` branch the view tree.
- `link href="/about"` navigates between routes.

### The contract block

The `contract` block declares behavior the runtime can check against the
rendered tree and agents can read back:

- `has button "Up"` — the labeled element must exist.
- `press button "Up" -> increment` — pressing it runs the action.
- `state button "Up" is enabled` (or `is disabled`).
- `when <expr> then <clause>` — clauses that only apply in some states.

### Router entry

`src/main.tsx` is a thin boot shim: it builds the file router over the
generated registry (`src/app/routes.runtime.web.ts`), attaches browser
history, and mounts the Contract router adapter. `src/app/
contract-route-module.ts` re-exports the Contract route-record helper the
generated registries import. `vite.config.mjs` wires `contractVitePlugin()`
from `@exact/contract/vite-plugin` so `.contract` modules compile in the dev
graph.

### Verify loop

1. Run `exact guide <intent>` and open the returned component/technique page.
2. Write the behavior in a `contract` block, then compose public
   `@exact/facet-contract` components. Use resolved theme tokens for raw
   layout; do not recreate a Facet control from built-in tags.
3. Compile/test, then run `bun run dev` and use the agent surface to verify
   behavior against the contract block by `testId`.
4. Run the project's existing registered verification checks before claiming
   completion. There is no additional subjective visual-consistency gate.

### What's built / what's coming

Contract v0 covers components, props/state/derive/actions, contract blocks,
lists, conditionals, and `.contract` route modules, on the dev-web loop and
the native protocol path. Facet exposes 31 public Contract components,
including the F2b form controls, F3 overlays, and seven Figma v2 preview
bindings. Check the Exact Guide and registry for availability; eight public
Facet components remain React-only, and the React tier stays supported for
those logged exceptions.

## Exact Guide

Before authoring UI, read
`node_modules/@exact/guide/content/getting-started/the-authoring-loop.md`.
Before using a feature area, search the installed, version-matched corpus with
`exact guide <words>` and read the returned page. The complete capability map
is `node_modules/@exact/guide/content/capabilities.generated.md`. Prefer this
installed Guide over model memory; its `guide-manifest.json` records the Exact
versions it was verified against.

## Routing

This is a routed app (LLP 0154 single-source routes):

- A screen is ONE file under `src/app/routes/` — `index.*` is `/`, `about.*`
  is `/about`, `profile/[id].*` would be `/profile/:id`.
- The route registries (`src/app/routes*.ts`, `src/__generated/routes/`) are
  GENERATED from that filesystem by `bun run generate:routes`; `dev`, `build`,
  and `typecheck` run it automatically at startup. Never edit generated files
  by hand — a running dev server keeps serving the old registries until you
  restart it.
- When you add a route, also add its logical path (no extension) to the
  `CORE_PROFILE.routes` list in `src/app/routes.profiles.ts`. A route missing
  from every profile still works on web but silently renders not-found on
  native — `generate:routes` WARNS about it (set
  `REQUIRE_NATIVE_ROUTE_COVERAGE = true` in that file to make it a hard error
  once you are native-shipping).

## Native route selection

`src/app/route-modules.native.ts` is the native route selector: the generated
`src/__generated/routes/app/profiles.json` manifest names it as the
`selectorModuleId` the native host loads to pick — and lazily import — the
route registry chunk for the launch path. The starter ships a single core
profile, so every path resolves to `routes.runtime.native.core.ts`. To split a
route (or a path prefix) onto its own native chunk: add a profile name to the
`NativeRouteProfileName` union and an entry to `NATIVE_ROUTE_PROFILES` in
`routes.profiles.ts`, then add a matching literal `import()` loader to
`NATIVE_ROUTE_REGISTRY_LOADERS` in `route-modules.native.ts` (the typed record
turns a missing loader into a compile error).

## Native dev loop (macOS & iOS)

Scaffolded apps use the shared-host dev loop (LLP 0318): there is no per-app
Xcode project. `exact run macos` starts this app's dev server (or reuses one
via `--url`), locates a built ExactAppMac host binary (`--app` flag, then the
`EXACT_MAC_APP` env var, then the newest Xcode DerivedData build, then a
checksum-verified prebuilt artifact — see below), and
launches it pointed at the app via `EXACT_DEV_SERVER_URL`, with the agent
surface reachable through the dev-server relay (`<dev url>/__exact/agent/`;
opt out with `--no-agent`).

The host must actually be shared: Debug `ExactAppMac` and the published
Release shared-host channel carry `exact-shared-dev-host-v1`. Ordinary or
app-specific Release builds load their embedded HBC instead (the stock app is
Caltrain) and cannot serve either an implicit or explicit dev-server URL. The
CLI refuses incompatible prebuilt artifacts before launch. A host built from
this Exact commit or newer is required; historical unmarked Debug hosts lack
the nonce/provenance protocol and must be rebuilt. With the agent enabled, the
host must publish a new live macOS relay registration within 45 seconds. A
Hermes shared-host registration carries this launch's nonce and token
fingerprint plus successful `liveDevServer` provenance for the exact final
response URL; even a same-origin redirect is refused. Exact Native external
placement instead requires the fresh nonce-bound live registration and no fake
JS provenance. `--no-agent` is weaker by design: it has no nonce or provenance
and admits only the selected executable's exact static shared-host marker.

`exact run ios` does the same on the iOS simulator: it locates a built
simulator ExactApp.app (`--app` flag, then `EXACT_IOS_APP`, then the newest
`*-iphonesimulator` DerivedData build), picks a device (a booted simulator
wins; override with `EXACT_IOS_SIMULATOR`, a device name or UDID), boots it
if needed, and installs + launches attached to the console with the dev
server and agent wired through `SIMCTL_CHILD_*` environment forwarding.

`src/main.tsx` is the web entry; `src/main.native.tsx` is what a native host
actually evaluates (the startup pipeline resolves `/src/main.tsx` through the
shared `mac -> native -> unsuffixed` order). The native entry mounts the same
generated route registry through this scaffold's native router surface without
touching the DOM — keep DOM-only code (browser history, `document`) in
`main.tsx`.

Host binaries: with an Exact checkout, build the `ExactAppMac` scheme
(macOS) or the `ExactApp` scheme against an iPhone-simulator destination
(iOS) there once (first run `git submodule update --init vendor/ibex`, then
`bun install`). Without
a checkout, `exact run macos` falls back to a checksum-verified prebuilt
artifact: the published channel (GitHub release `host-macos-v<protocol>` on
ccheever/exact-releases; opt out with `EXACT_HOST_ARTIFACT_NO_DEFAULT=1`), or an
explicit `EXACT_HOST_ARTIFACT_MANIFEST_URL` / `EXACT_HOST_ARTIFACT_URL` +
`EXACT_HOST_ARTIFACT_SHA256` override (ENG-23311). Verified artifacts are
cached under `~/Library/Caches/exact/hosts/`; checksum verification proves
integrity, while the executable capability probe proves that the macOS
artifact is a shared host. An installable/packaged app
story is tracked by ENG-22922 (LLP 0307); the iOS prebuilt variant is not
published yet.

## Platform-suffixed route overrides

A route is single-source by default: ONE unsuffixed module renders on web and
native. A platform-suffixed sibling (`index.native.contract`, `about.web.tsx`,
`settings.mac.tsx`) shadows the unsuffixed module through the shared
resolution order (`mac -> native -> unsuffixed`, `web -> unsuffixed`) and MUST
justify itself with a header comment on its first lines:

    // @platform-split: <reason> (LLP 0154)

`bun run check:platform-splits` enforces the header (it runs automatically in
`build` and `typecheck`); a suffixed route file without one fails the check.
Both a `.contract` and a `.tsx` present for the same route slot is a generator
error, not a resolution rule. Prefer converging on one unsuffixed route; split
only when a platform genuinely needs different structure. The full conventions
(dynamic segments, layouts, sidecars) are documented in the Exact repo's
`docs/adding-a-route.md`.

## Development

- Use `bun install` to install dependencies. The `@exact/*` packages are NOT
  registry dependencies: `exact.links.json` names where they live in the
  linked Exact checkout, and the `postinstall` script
  (`scripts/link-exact.mjs`) symlinks them into `node_modules`. If the
  checkout moves, update `exact.links.json` and re-run `bun install`.
- Run `bun run dev` to start the Exact + Vite dev server.
- In another terminal, run `bun run setup-mcp` to register this app's MCP bridge
  with Claude Code. The starter keeps that command local so the setup flow is
  the same here as it is in the main Exact repo.

## Agent API (Acto)

<!-- exact-skills:acto:start -->
<!-- Generated: acto AGENTS excerpt -->
<!-- Authority: packages/exact-cli/skills/skills-manifest.json + tagged docs fragments -->
<!-- Generator: bun scripts/generate-skills-content.mjs --write -->
<!-- LLP: 0340 -->
<!-- Committed: yes -->
<!-- Input digest: 1d9f220d80f9b236049dfd317bc40cdc227f8a96eaa1d2d3a060b5d9c61086b2 -->
<!-- Source commit: 994dc6ef373f88aa956412a3a5066c017829c1ba (excluded from equality) -->

Use Acto's structured tree, layout, diagnostics, and interactions before
manual screenshots or generic automation. Capture one bundled snapshot,
preserve its `snapshotId`, and target by `ref + snapshotId`, then `testId`,
accessibility label, snapshot-scoped `viewId` (a bare `viewId` is refused under
LLP 0511 §4.4), and only then coordinates. After an action,
prefer its `observeAfter` receipt or a tree diff; refresh stale refs from a
new snapshot. Query roots for modal/multi-window work and diagnostics for
clipping or zero-size failures. For selection work, pass a `windowId` from
`exact_windows` with an omitted/zero root to choose one physical projection;
a positive `rootId` targets that logical root exactly and takes precedence.

Read `.claude/skills/exact-inspect/SKILL.md` or `.agents/skills/exact-inspect/SKILL.md` for the complete stamped scaffold workflow.

<!-- exact-skills-stamp: input=1d9f220d80f9b236049dfd317bc40cdc227f8a96eaa1d2d3a060b5d9c61086b2 content=5c69e2fbb245e3a8bd0b11eafadcf8a3f97ba574d09ef62f89fc8ea63140548c operation-consequence=882c19a9aa86f47ca8948440f112c328d9466b03fff86e379b61ef7cc19667ae -->
<!-- exact-skills:acto:end -->

## Editing notes

- Keep generated files out of hand-authored app code. If you add generated
  outputs later, make their authority and regeneration command explicit.
