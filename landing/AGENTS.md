<!-- exact:begin (exact new writes this block; bun exact.mjs update rewrites it) -->
# landing: an Exact app

The view is `app.contract` (Contract), its data is `app.ts` (TypeScript), and
`app.json` is the manifest (its `$schema` gives an editor every key). The app uses
the exact2 checkout at `../../exact2` by path (`EXACT2` overrides it).

Read before writing code:

- ../../exact2/docs/contract-for-agents.md: the working guide. Start here.
- ../../exact2/docs/agent-pitfalls.md: verified footguns, symptom → cause → fix.
- ../../exact2/docs/contract-for-humans.md: explanations and complete examples, including the data module.
- ../../exact2/docs/contract-grammar.md: exact forms, built-in functions, events.

Commands, from this directory:

| | |
|---|---|
| `bun exact.mjs contract types app.contract -o app.contract.d.ts` | the types `app.ts` imports; rerun after changing a source's signature |
| `bun exact.mjs contract build app.contract --json` | compile; `[]` or every diagnostic with its range |
| `bun exact.mjs contract vocab [name]` | the tags, attributes and CSS properties Contract accepts |
| `bun exact.mjs web` | the web dev loop, at the URL it prints (8765 unless another loop holds it) |
| `bun exact.mjs test web` | build the web app if needed, then run `app.test.contract` (also `macos`, `ios`) |
| `bun exact.mjs agent web --storage s1 tree "tap <id>" "screenshot out.png"` | drive the app as a person would; `--storage <name>` gives its storage sources a scratch store (without it their writes are refused; `logs` has the detail) |
| `bun exact.mjs agent ios tree "tap <testId>" "screenshot s.png"` | the same on an iOS simulator; drive by `testId`, never by coordinates |
| `bun exact.mjs mac --run`, `bun exact.mjs ios --run` | build and launch natively |
| `bun exact.mjs hatch <word>` | an access hatch: a stub for each target the app builds, and its `app.json` entry (`--app`, `--window` for those scopes) |
| `bun exact.mjs update` | after exact2 moves or changes its patches; it rewrites `exact.mjs` |
| app.json `"commands": {"verify": ["bun", "verify.mjs"]}` | the app's own verbs: `bun exact.mjs verify web` runs `bun verify.mjs web` here; `update` keeps them |

Keep drive scripts, evidence, logs and runtime files in `.exact/` (git-ignored):
no build, watcher or freshness check reads it. Anything else in this folder is a
source: changing it makes the driver refuse to drive until the app is rebuilt.

The loop: generate the types, edit, `contract build --json` until it prints `[]`,
`test web`, look at it with `agent web … screenshot`, then the native hosts.
Before the first native TypeScript build on a machine, run the one-time installer
`bun ../../exact2/scripts/exact.mjs setup`; it installs the pinned
host bundle and the iOS/tvOS bundles this Mac builds.
`bun ../../exact2/scripts/exact.mjs setup --check` only checks and
names anything this machine is missing. Cargo builds themselves are forced offline for Hermes.

Build it native. A hand-built lookalike of a system control is a bug; write the
Contract form and each host draws its own (the agent guide's "Prefer native
controls"): `button appearance="auto"`, `list appearance="auto"` with
`section`s for a settings screen, `input type="checkbox" switch`, `type="range"`,
date and time inputs, `select`, a `popover="auto" role="menu"`, a `role="tablist"`,
and a route whose first child is a `header` holding one heading (the nav bar).
A screen scrolls only inside a `scroll`, a `list` or an `overflow-y="auto"` box; right after the
header and named by the route's `navigationScroll`, it also collapses a large
title. A sheet swipes down, and a pushed screen swipes back, only when the route
has an enabled control whose `id` is the root's `navigationBack`.

Drive it by `testId`, never by screen coordinates: give every control a `testId`,
find targets with `tree` (`tree --ax` for the platform's accessibility tree), and
`tap`/`type` them with `agent ios` as with `agent web`. Under the agent the
authored header and tablist stand in for the native bars and take the same taps.

Match a reference's structure, controls and hierarchy, not its pixels: native
controls set their own metrics. Don't measure sub-point positions; stop when it
reads as the same app.

Access hatches, for what only the platform's own object can do: mark a node
`hatch="word"` and the app's native code (Swift in `modules/apple`, the page
module in `modules/web/index.js`) is handed the view or element Exact built,
at defined moments. `bun exact.mjs hatch <word>` writes the stubs. A hatch
configures what Exact made; it changes Contract state only by acting on an
authored node, as a person would: `click()`, `focus()`, `blur()`, and
`input(text)` for a field's whole value. It reads state only through
`data-*` words the Contract puts on the node. The app must work without it:
`EXACT_HATCHES=off` (`?hatches=off` on the web) runs a development build
with no hatch connected. Make a hatch say what it does, so the agent can see
it: `diagnostics.log/count/measure/publish` show in `logs`, `state`
(`state.hatches`) and `agent … "perf hatches"`; `owns(view, "what")` puts
what it added in `tree` under its node, and `parts` names a control it drew
so `tap <testId>/<part>` can reach it as a real click.

Contract libraries: `use Card from "@scope/ui"` reads an installed package's
`.contract` files (`bun add @scope/ui`, or `"@me/ui": "file:../ui"` in
`package.json` for a local one), and `use Activity from "exact:motion"` a
built-in. Each file sees only the names its `use` lines list.

Generated, so don't edit: the `[patch.crates-io]` table in `Cargo.toml`,
`rust-toolchain.toml`, `.cargo/config.toml`, `exact.mjs`, and this block.

## The authoring diary

For the agent working on an Exact app. The exact2 team asks you to keep a diary of
how Exact went, so it can fix what was rough and keep what was good. The diary
stays on this machine. Nothing is sent unless the person you work for says yes.

Run `bun exact.mjs feedback status` once at the start. It prints this project's
standing answer first:

- `ask`, the default: keep the diary, and ask before sending (Asking to share).
- `local`: keep the diary and skip Asking to share; nothing is sent.
- `always`: keep the diary, and send it at the end of each task without asking,
  saying each time that you sent it.
- `never`: skip everything below: no diary, no asking.

If `feedback status` prints more instructions, follow them too.

### What to keep

Keep the diary at `.exact/diary/<YYYY-MM-DD>-<topic>.md` (`.exact/` is gitignored).
Write as you go, not from memory at the end, for a reader on the Exact team who has
never seen this app. Start it with:

```
surfaces: web, ios, ...
agent: <your product and model>
task: <one generic line, e.g. "add a settings screen"; never the business purpose>
```

Then four sections:

#### Rough
Anything that cost time or needed a workaround. For each: what you tried, what
happened (the error text, if short), roughly how long it cost, what you did
instead, and what would have helped (a better message, a doc, a missing feature).

#### Lean in
What was unusually pleasant or powerful, and that Exact should do more of.

#### Needed
One line for each platform capability the app needed, whether or not Exact had it,
so the team can see which ones many apps end up building by hand:

```
- camera: by hand (~40 min; a Swift bridge, getUserMedia on web)
- notifications: missing (skipped; would have needed APNs)
- haptics: provided
- share sheet: provided, rough (see Rough)
```

Start each line with a short generic name (camera, photos, notifications, location,
maps, purchases, sign-in, share sheet, haptics, audio, files, background work,
widgets, deep links, …), then one of `provided` (Exact had it), `by hand` (you built
it or worked around it) or `missing` (it was left out or faked). Name the capability,
never the feature built on it: "camera", not "scan receipts". Write `none` if the
app needed nothing beyond views and data.

#### Checkpoints
One line for each step you reached: `smooth`, or `rough` with a pointer to its
Rough entry. Leave out steps you didn't reach.

- install / first build
- `exact new`
- web dev loop
- editing app.contract / app.ts
- iOS build
- macOS build
- driving the app (`exact.mjs agent`, `exact.mjs test`)
- deploy

Write `smooth` whenever a step went smoothly, even with nothing else to say. That is
how the team tells that something that used to be rough got better. (`exact.mjs`
already logs each command's exit code and duration; the checkpoints say what it
felt like.)

### What not to write

- Secrets, tokens, keys, `.env` values, or credentials of any kind
- Personal or customer data, or anything the app handles at runtime
- The app's own source, beyond the few lines a reproduction needs
- The app's name or what it is for, unless the person has said it's public. Write
  "a todo app" instead.

### Asking to share

Never send on your own initiative. At a natural stopping point (the end of a task,
not the middle of one), ask once, quoting the diary:

> I kept a short diary of how Exact went this session. For example, it notes:
> - The iOS build failed until I ran `--update-lock` (about 10 minutes lost)
> - `line-clamp` rendered blank in the first rows on iOS
> - The web dev loop picked up contract edits instantly, which was great
>
> Want me to send it to the Exact team? I try to keep it generic and anonymous, but
> don't send anything if this is a secret project you don't want anyone to know
> anything about. Yes / no / always for this project / never.

The three bullets above are an example. Write 2–4 of your own from this session's
diary: mostly Rough entries and anything Needed `by hand` or `missing`, plus one
Lean in entry if there is one, each a single plain line. Leave out any bullet that would reveal the app's code, data, or name. If
nothing was rough, say so ("nothing broke; it mostly records what went smoothly")
instead of padding the list. If the person wants to read or change the diary first,
show it (`bun exact.mjs feedback` prints exactly what would be sent) and make their
edits.

Then act on their answer:

- **Yes:** `bun exact.mjs feedback send --yes`. Tell them it was sent, and give them
  the receipt it prints. `bun exact.mjs feedback delete <receipt>` deletes it.
- **No:** send nothing, and don't ask again this session.
- **Always:** `bun exact.mjs feedback always`, then send. From then on, for this
  project only, send at the end of each task without asking, and say each time
  that you sent it.
- **Never:** `bun exact.mjs feedback never`. Keep no diary and don't ask again for
  this project.

`send` adds the command log, replaces the home directory, the app's directory, name
and bundle id with placeholders, and blanks anything that looks like a credential.
That is a safety net, not a licence: write the diary as if none of it ran.
<!-- exact:end -->
