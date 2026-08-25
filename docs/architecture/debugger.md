# Debugger and console (P8)

Shared surface for the command system, Play/export console, stats HUD, and trace recorder (engineplan §9). Implementation: `@babylonslate/debugger` (headless registry + parser + recorder). HUD/console UI lives in the editor Play overlay; this package must not import React or Babylon.

The organising idea: **the command system is always present; only the debugger UI and debug-tier commands are optional.** A shipped game can still `changescene` or drop render quality with no console on screen.

Engine command catalog (what applies, autocomplete, reserved names): [console-commands.md](console-commands.md).

## Package API (`@babylonslate/debugger`)

| Export | Role |
| --- | --- |
| `createCommandRegistry({ includeDebug })` | Core commands always; debug tier only when `includeDebug` is true |
| `CommandRegistry.execute(line, host)` | Parse, coerce, run; never throws |
| `tokenize` / `parseCommandArgs` | Quoted tokens, positional and `name=value` args, type coercion |
| `CORE_COMMAND_NAMES` / `DEBUG_COMMAND_NAMES` | Stable name lists for export presets and compile-time warnings |
| `createUserCommand` | User `BDebugCommand` → **core** tier so it ships in every export |
| `suggestConsoleCompletions` / `applyConsoleCompletion` | Prefix match on names, then the current token: enum values, `on`/`off`, `param=` chips, defaults, and Play context lists (`scenes` / `actors` / `commands`). Chips and Tab replace that token in place (command hits become `name `). |
| `TICK_BUDGET_MS` / `isTickOverBudget` | Combined script + physics tick vs the 8 ms budget |
| `STATS_COMMAND_INTERVAL_MS` / `shouldEmitStatsCommand` | Worker `stats` command cadence (**200 ms**, ~5 Hz). First sample always; then at most one command per interval |
| `TraceRecorder` | Capped in-memory session capture (`snapshot start` / `stop`) |
| `warnDebugTierConsoleCommands` | Graph lint: ExecuteConsoleCommand literals that name a debug-tier command |
| `ConsoleCommandHost` | Engine callbacks the registry calls (runtime implements this) |
| `createInfiniteLoopGuard` / `InfiniteLoopError` / `instrumentJsLoops` | Per-tick iteration cap for editor Play; rewriter for `while` / `for` / `do` |

Depends on nothing (no React, Babylon, Capacitor, or scripting). `@babylonslate/runtime` owns the host and wires `ctx.executeConsoleCommand` and `ctx.checkInfiniteLoop`. `@babylonslate/scripting` may import `instrumentJsLoops` only.

## Infinite loop detection

Unreal-style **per-tick** cap, editor-only. Project Settings **General**: **Infinite Loop Detection** (default on) and **Loop Count** (default 1_000_000, min 1). Play reads live settings on session start — `loopCount` is not baked into generated JS.

- `createInfiniteLoopGuard({ enabled, loopCount })` increments on `check()` and throws `InfiniteLoopError` (`name: "InfiniteLoopError"`, message **Infinite loop detected**) when `count > loopCount`. `reset()` at the start of each script phase / tick. Disabled and release (`includeDebugCommands: false`) no-op.
- Diagnostic code `runtime.infinite_loop`. Overlay Play and Preview Build treat that code as **session-fatal**: stop immediately (same path as Stop), then the Preview session report shows the row (navigable node / ExecuteJavaScript `bodyLine`). Ordinary `runtime.uncaught` throws do not auto-close Play.
- There is no time-based worker watchdog. Cooperative `check()` is the recovery path; uninstrumented JS from a timer cannot be interrupted in-process.

See [scripting.md](scripting.md) for codegen and [exporter.md](exporter.md) for manifest fields.

## Command tiers

Every registered command has a tier. A non-debug registry **does not register debug implementations**; it still recognises debug names so `ExecuteConsoleCommand` can return a clear failure instead of `unknown command`.

| Tier | Ships | Commands |
| --- | --- | --- |
| **core** | Every build | `changescene`, `renderquality`, `shadowquality`, `resolutionscale`, `framecap`, `volume`, `quit`, `help`, plus user `BDebugCommand` classes |
| **debug** | Debugger bundled | `showfps`, `stat unit`, `stat memory`, `stat draws`, `stat threads`, `showcollision`, `showbounds`, `actorboundingbox`, `wireframe`, `pause`, `resume` (alias `unpause`), `step`, `slomo`, `freecam`, `shownav`, `showaudiodebug`, `dumpactors`, `inspect`, `dumplog`, `snapshot start`, `snapshot stop` |

Real export tree-shaking of the debug module is landed: the release player calls `createCommandRegistry({ includeDebug: false })` via `includeDebugCommands: manifest.bundleDebugger`. Preview Build and a **Bundle Debugger** export preset keep the debug tier. See [exporter.md](exporter.md).

`ExecuteConsoleCommand` targeting a stripped command returns `{ success: false, output }` with a message that names the command. Unknown names return `unknown command: …`. Neither path throws.

## Parser

- Tokenize on whitespace; `"quoted strings"` keep spaces.
- Command names may contain spaces (`stat unit`, `snapshot start`). Match the longest registered (or stripped) name.
- Remaining tokens fill parameters in order, or as `name=value` / `name:value`.
- Coerce to `string` / `float` / `int` / `bool` / `enum`. Bool accepts `true`/`false`/`1`/`0`/`on`/`off`/`yes`/`no`.
- Missing required args or bad coercion → `{ success: false, output }` describing the parameter. Optional args use `defaultValue`.

## Host (`ConsoleCommandHost`)

The registry does not touch the world or renderer. Runtime implements:

| Command | Host |
| --- | --- |
| `changescene` | `changeScene(guid)` → load that guid from the Play scene library into the World (same as `ctx.changeScene`) |
| `renderquality` / `resolutionscale` / `volume` / `framecap` | Typed setters. Optional arg prints the last value. Play applies `{ type: "setRenderQuality" \| "setResolutionScale" \| "setGlobalVolume" \| "setFrameCap" }` (`high=1`, `medium=1.5`, `low=2` hardware scale on the Play view only). `resolutionscale` clamps `1..2` on the host so print matches apply |
| `shadowquality` | enum `off`/`512`/`1024`/`2048`. Runtime emits `{ type: "setShadowQuality"; level }` and the renderer sizes the one `ShadowGenerator` (or disposes it when `off`). `2048` also warns |
| `quit` | `quit()` → runtime `stop` |
| `help [name]` | Core. Lists registered commands (user included) or one command’s parameters. Stripped debug names print “not available in this build” |
| `pause` / `resume` / `unpause` / `step` | `pause` / `resume` / overlay-style `resume`→`tick`→`pause`. Console pause/resume emit `{ type: "sessionPaused" }` so overlay chrome matches |
| `slomo [rate]` | `setTimeDilation` / `getTimeDilation`. `tick` uses `dt * rate` (clamp `0..8`) for script, physics, nav crowd, and BT. Trace header and frame snapshots keep recorded (undilated) `dt` |
| `freecam [on\|off]` | `{ type: "setFreeCam" }`. Detached fly/pan camera; simulation keeps ticking. Pointer/WASD stay off the game ring; 2D pinch zooms ortho; gamepad still forwards. Overlay Play shows a fly stick while on. |
| `showfps` / `stat *` | `{ type: "setShowFps" }` / `{ type: "setStat" }`. Opens Stats HUD; `stat` highlights unit (timings), memory, draws, or threads (main vs worker) |
| `wireframe` / `showbounds` / `actorboundingbox` / `showcollision` / `shownav` | Play-scene overlays. Collision / nav meshes use `RENDERING_GROUP.world` with depth test (not a group-0 underlay). Collision uses `PhysicsBackend.listDebugColliders()` (boxes/spheres/circles/capsules/polylines; body rotation of local offsets and polyline points). `actorboundingbox` calls the same `setShowBounds` host as `showbounds`. Separate from per-collider **Render In Game** world dashes. |
| `showaudiodebug` | `{ type: "setShowAudioDebug" }`. DOM overlay of playing AudioV2 voices (applies; not log-only) |
| `dumpactors` / `inspect [name\|guid]` | Format `inspectWorld()`. Bare `inspect` uses overlay Inspector selection when known, else prints usage |
| `dumplog` | `dumpLog()` from the log ring |
| `snapshot start` / `snapshot stop` | `startSnapshot` / `stopSnapshot` → `TraceRecorder`; stop emits a `trace` command |

Catalog and apply details: [console-commands.md](console-commands.md).

## ExecuteConsoleCommand

The P5 node already compiles to `ctx.executeConsoleCommand(command)` and binds `success` / `output`. Runtime delegates that call to `CommandRegistry.execute`. Editor validation (`warnDebugTierConsoleCommands`) warns when the command pin’s **literal** is a debug-tier name, so a release export failure is visible before shipping. Connected (non-literal) pins are not flagged.

## BDebugCommand

`BDebugCommand` is an Object subclass in the class registry. User classes whose parent chain reaches it are discovered with `ClassRegistry.isA`. Class settings (command name, description, category, typed parameter list) live on the `Event On Command Run` node and drive generated output pins. Compiled graphs register as **core** commands via `RuntimeDriver.loadScripts` (`script.command`). They run from the Play console and from `ExecuteConsoleCommand` even when `includeDebugCommands` is false. Builtin names are reserved so a user class cannot silently replace `pause` or `changescene` — [console-commands.md](console-commands.md).

The shared `ParameterListEditor` in `editor-kit` authors those rows (types, optional, defaults, enum values, reorder) and ExecuteJavaScript Inputs/Outputs.

## Console, inspector, and stats HUD

Play overlay chrome is a labeled top bar (**Pause** / **Resume**, **Stats**, **Console**, **Inspector**, **Stop**, plus **Step** while paused) with 44px targets. `StatsHud` stays **collapsed** until Stats is tapped so the first Play frame reads as a game view. Pause calls `session.setPaused` (the same path as `attachLifecyclePause`), which pauses the render scheduler **and** live AudioV2 voices. Close is one tap (**Stop**). Preview Build uses the same labeled **Stop** over its player iframe (the packaged player keeps its own stats HUD, which samples fps on the rAF pump; Pause / Console / Inspector stay overlay-Play-only). When Preview Build is on, the chrome launch control reads **Preview**.

**Debug menu** (next to Play) persists overlay chrome in Engine Settings `debuggerDefaults` (same store as Preview Build). Do not reuse unused `showFps` (defaults false).

| Group | Item | Default | Notes |
| --- | --- | --- | --- |
| Play Overlay | Stats, Console, Inspector | on | Hides that overlay control when off. Checkboxes stay enabled while playing, but the Play overlay is `z-50` full-screen so the toolbar Debug menu is not reachable mid-session — toggle before Play, or hide via overlay chrome. Unchecking Inspector also closes the dialog (it does not reopen when checked again). |
| Session | Pause On Play | off | After Play boot, `setPaused(true)` via `createPlayPauseGate` so `boot.play`'s `resume()` cannot undo it. `start()` / Begin Play may still run; the first tick after that waits for Resume / Step. Overlay boot also posts `{ type: "setPaused", paused: true }` after `{ type: "play" }`. |
| Session | Preview Build | off | Disabled while playing or preparing |
| Session | Play from Scene | on | Overlay Play and Preview Build seed the open scene tab; off seeds project startup. Disabled while playing or preparing. Export Game ignores this. |

`showcollision` / `showbounds` / `actorboundingbox` / `wireframe` / `shownav` / `showaudiodebug` apply from the console (not Debug-menu items). Audio debug is a DOM overlay that keeps drawing while Pause freezes the sim.

Play overlay **extends** the existing FPS / `scriptMs` / `physicsMs` strip:

- Large console overlay (`DebugConsole`): CatalogDialog-sized (`h-[min(92vh,56rem)]` × `w-[min(96vw,80rem)]`), not a small `sm:max-w-lg` dialog. Header **Console** plus Clear / Copy Transcript. Transcript fills the body (`bg-background`, `font-mono text-sm`, `whitespace-pre-wrap` on command output so `help` / `dumpactors` / `inspect` keep line breaks, success vs failure via tokens, auto-scroll). Completions are `size="touch"` chips **above** the input; tapping a chip or Tab runs `applyConsoleCompletion` so the **current token** is replaced (a command-name hit becomes `name ` ready for args). The old chip path that called `setDraft(name)` and wiped `renderquality high` down to `high` is gone. Run and the 44px accessory bar stay pinned at the bottom. The input is not autofocused (iPad keyboard). Still a modal `Dialog`; Play keeps ticking. Executes through in-process `runtime.executeConsoleCommand` or worker `{ type: "console" }`. Bare `inspect` is rewritten with the Inspector selection when one is known.
- Read-only **Inspector** overlay: same CatalogDialog footprint (`h-[min(90vh,52rem)]` × `w-[min(96vw,64rem)]`). Left: `SearchInput` + `TreeView` (no reparent) of Game Instance, actors (`parentId` order), and components. Right: three `PropertyGrid`s (`orientation="horizontal"`) for identity, transform, and variables. Rows are **disabled** catalog controls (checkbox / `NumericDragField` / vector XYZ(W) / `ColorField` / `PickerIdentity` / text); there is no `setVariable`. Types come from snapshot `variableTypes` (ClassRegistry) when known, otherwise inferred. Enums without member lists render as disabled text. Selection is kept across snapshots by guid. Compose from catalog only; Play overlay chrome itself stays not-kit.
- ~5 Hz `StatsHud`: tick-budget flag (`isTickOverBudget`), accounted resource-cache bytes, mesh/texture counts, last-frame draw calls (Babylon `_drawCalls.current` snapshotted after Play `scene.render()` — not `engine.drawCalls`, which is unset), bridge messages/s. The worker **emits** `{ type: "stats" }` at `STATS_COMMAND_INTERVAL_MS` (200 ms, ~5 Hz) — it is not a per-tick command. Latest `scriptMs` / `physicsMs` / `tickIndex` also live on the **snapshot header** every tick. Overlay Play and the packaged player `setState` / HUD text from those ~5 Hz `stats` commands plus a **1 Hz** rAF FPS sample; they must not React-update chrome at 60 Hz. Worker `stats` commands own `scriptMs` / `physicsMs`; the main-thread rAF pump only merges FPS so it cannot zero those timings. Editor viewport FPS is not shown on the Debug menu (Always Render is always on). Testids `stats-hud` and `play-fps` stay mounted while collapsed so QA can poll attributes after opening Stats.

Output Log, keyed Print, and the Preview session report are unchanged. Print HUD and Draw Debug wireframes are **not** debugger chrome: overlay Play and the packed player apply `{ type: "print" }` / `{ type: "debugDraw" }` even when `bundleDebugger` is false. Stats HUD, console, and inspect stay debugger-bundled. Print / Print String / Draw Debug still default to Inspector **Development Only**, so a release compile omits them unless the author unchecks the flag.

## Inspect protocol

Headless snapshot `createDebugInspectSnapshot(world)` in `@babylonslate/object-model` (separate type from harness `createWorldSnapshot` goldens). Nodes: Game Instance if any, then actors parent-before-child (`parentId` variable), then each actor’s components as children. Label is the `name` variable, else `classId`. Values are JSON-safe: primitives stay; `BObject` → `{ guid, classId }`; circular / non-cloneable → `formatValue()`. Optional `variableTypes` maps variable keys to ClassRegistry types (`inheritedVariables`) for keys that exist; keys without a class def stay untyped so the editor can infer.

Bridge: `{ type: "inspect" }` control → `{ type: "inspectSnapshot", snapshot }` command (same waiter pattern as `console` / `consoleResult`; worker `applyInspectControl`). Overlay Play polls **while the inspector dialog or the console is open**, ~5 Hz, and skips a tick when a previous inspect RPC is still in flight (actor name completions stay live). In-process Play calls `runtime.inspectWorld()` directly. The inspector is read-only this pass (no `setVariable` from the UI). Identity labels use Title Case acronyms (**GUID**). Transform uses XYZ (position/scale) and XYZW (rotation quaternion). Object refs show class identity (`PickerIdentity`: classId + guid), not `Class(guid)` text.

## Trace recorder

`snapshot start` / `snapshot stop` fill a `TraceRecorder` (stats, logs, prints, world snapshots, input, RNG seed) with a byte budget. Stop emits a `trace` command. Runtime `stop()` also finalizes an in-flight recording. `@babylonslate/assets` writes the payload as a `Trace` document under app-private derived data (`derived/{projectGuid}/traces/*.babtrace`, same root as thumbnails/journal — not `assets/` / Content Browser). Overlay Play does not show a playback card. When Play ends with a payload, the editor opens a read-only DockView **Trace** tab: Timeline graphs (script/physics ms vs tick) + scrubber, Snapshot of the selected frame, and Log filtered to a window of ticks around the scrubber (logs **and** prints). Headless replay: seed + ticks **or** feeding each frame’s `inputEvents` then `tick()` → same `stringifyWorldSnapshot`.

## Export settings (P14)

Project Settings **Export Game** preset: **Bundle Debugger** (off for release). Release export compiles with `compileGraphDocumentsForExport` (Print / Print String / Draw Debug default on; Inspector **Development Only** nodes are omitted). A non-debug player still links `@babylonslate/debugger` **core** commands; debug-tier implementations are not registered (`includeDebug: false`). Opted-in Print and Draw Debug still render. **Preview Build** always bundles the debugger and keeps Development Only nodes. Draw-call ceilings (`DRAW_CALL_WARN_CEILING`) surface as HUD warnings. See [exporter.md](exporter.md).
