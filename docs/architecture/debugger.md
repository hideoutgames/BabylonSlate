# Debugger and console (P8)

Shared surface for the command system, Play/export console, stats HUD, and trace recorder (engineplan §9). Implementation: `@babylonslate/debugger` (headless registry + parser + recorder). HUD/console UI lives in the editor Play overlay; this package must not import React or Babylon.

The organising idea: **the command system is always present; only the debugger UI and debug-tier commands are optional.** A shipped game can still `changescene` or drop render quality with no console on screen.

Engine command catalog, what actually applies today, and the follow-up pass (`resume`, `freecam`, reserved names): [console-commands.md](console-commands.md).

## Package API (`@babylonslate/debugger`)

| Export | Role |
| --- | --- |
| `createCommandRegistry({ includeDebug })` | Core commands always; debug tier only when `includeDebug` is true |
| `CommandRegistry.execute(line, host)` | Parse, coerce, run; never throws |
| `tokenize` / `parseCommandArgs` | Quoted tokens, positional and `name=value` args, type coercion |
| `CORE_COMMAND_NAMES` / `DEBUG_COMMAND_NAMES` | Stable name lists for export presets and compile-time warnings |
| `createUserCommand` | User `BDebugCommand` → **core** tier so it ships in every export |
| `suggestConsoleCompletions` | Prefix match on names, then enum values for the current argument |
| `TICK_BUDGET_MS` / `isTickOverBudget` | Combined script + physics tick vs the 8 ms budget |
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
| **core** | Every build | `changescene`, `renderquality`, `shadowquality`, `resolutionscale`, `framecap`, `volume`, `quit`, `help` (planned), plus user `BDebugCommand` classes |
| **debug** | Debugger bundled | `showfps`, `stat unit`, `stat memory`, `stat draws`, `stat threads`, `showcollision`, `showbounds`, `wireframe`, `pause`, `resume` (planned), `step`, `slomo`, `freecam` (planned), `dumplog`, `snapshot start`, `snapshot stop`, plus viz/dump names in [console-commands.md](console-commands.md) |

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
| `renderquality` / `resolutionscale` / `volume` / `framecap` | typed setters (log `key=value` until a later consumer). `renderquality` stays `low`/`medium`/`high` |
| `shadowquality` | enum `off`/`512`/`1024`/`2048` (not the render-quality ladder). Runtime emits `{ type: "setShadowQuality"; level }` and the renderer sizes the one `ShadowGenerator` (or disposes it when `off`). `2048` also warns |
| `quit` | `quit()` → runtime `stop` |
| debug pause / resume / step / slomo | `pause` / `resume` (planned) / `step` / `setTimeDilation`. Console `step` currently calls `tick()` and no-ops while paused; overlay Step already does resume→tick→pause |
| `dumplog` | `dumpLog()` from the log ring |
| overlay flags | `setShowFps`, `setStat`, `setShowCollision`, … |
| `snapshot start` / `snapshot stop` | `startSnapshot` / `stopSnapshot` → `TraceRecorder`; stop emits a `trace` command |

Core setters that the main thread does not yet apply (`renderquality`, `resolutionscale`, `volume`, `framecap`) still succeed and emit a `log` command so graphs and tests can observe them. `shadowquality` logs and applies. Wiring those setters, `resume`, and `freecam` is the engine console pass — [console-commands.md](console-commands.md).

## ExecuteConsoleCommand

The P5 node already compiles to `ctx.executeConsoleCommand(command)` and binds `success` / `output`. Runtime delegates that call to `CommandRegistry.execute`. Editor validation (`warnDebugTierConsoleCommands`) warns when the command pin’s **literal** is a debug-tier name, so a release export failure is visible before shipping. Connected (non-literal) pins are not flagged.

## BDebugCommand

`BDebugCommand` is an Object subclass in the class registry. User classes whose parent chain reaches it are discovered with `ClassRegistry.isA`. Class settings (command name, description, category, typed parameter list) live on the `Event On Command Run` node and drive generated output pins. Compiled graphs register as **core** commands via `RuntimeDriver.loadScripts` (`script.command`). They run from the Play console and from `ExecuteConsoleCommand` even when `includeDebugCommands` is false. Builtin names are reserved so a user class cannot silently replace `pause` or `changescene` — [console-commands.md](console-commands.md).

The shared `ParameterListEditor` in `editor-kit` authors those rows (types, optional, defaults, enum values, reorder) and ExecuteJavaScript Inputs/Outputs.

## Console, inspector, and stats HUD

Play overlay chrome is a labeled top bar (**Pause** / **Resume**, **Stats**, **Console**, **Inspector**, **Stop**, plus **Step** while paused) with 44px targets. `StatsHud` stays **collapsed** until Stats is tapped so the first Play frame reads as a game view. Pause calls `session.setPaused` (the same path as `attachLifecyclePause`). Close is one tap (**Stop**). Preview Build uses the same labeled **Stop** over its player iframe (the packaged player keeps its own stats HUD, which samples fps on the rAF pump; Pause / Console / Inspector stay overlay-Play-only). When Preview Build is on, the chrome launch control reads **Preview**.

**Debug menu** (next to Play) persists overlay chrome in Engine Settings `debuggerDefaults` (same store as Preview Build). Do not reuse unused `showFps` (defaults false).

| Group | Item | Default | Notes |
| --- | --- | --- | --- |
| Play Overlay | Stats, Console, Inspector | on | Hides that overlay control when off. Enabled while playing so chrome can be hidden mid-session |
| Session | Pause On Play | off | Calls `setPaused(true)` when the overlay session starts |
| Session | Preview Build | off | Disabled while playing or preparing |

`showcollision` / `showbounds` / `wireframe` still only log settings — they are not Debug-menu items until a real overlay exists.

Play overlay **extends** the existing FPS / `scriptMs` / `physicsMs` strip:

- Large console overlay (`DebugConsole`): CatalogDialog-sized (`h-[min(92vh,56rem)]` × `w-[min(96vw,80rem)]`), not a small `sm:max-w-lg` dialog. Header **Console** plus Clear / Copy Transcript. Transcript fills the body (`bg-background`, `font-mono text-sm`, success vs failure via tokens, auto-scroll). Completions are `size="touch"` chips **above** the input; Run and the 44px accessory bar stay pinned at the bottom. The input is not autofocused (iPad keyboard). Still a modal `Dialog`; Play keeps ticking. Executes through in-process `runtime.executeConsoleCommand` or worker `{ type: "console" }`.
- Read-only **Inspector** overlay: same CatalogDialog footprint (`h-[min(90vh,52rem)]` × `w-[min(96vw,64rem)]`). Left: `SearchInput` + `TreeView` (no reparent) of Game Instance, actors (`parentId` order), and components. Right: identity, transform, `Field` + `SelectableText` variables. Selection is kept across snapshots by guid. Compose from catalog only; Play overlay chrome itself stays not-kit.
- ~5 Hz `StatsHud`: tick-budget flag (`isTickOverBudget`), accounted resource-cache bytes, mesh/texture counts, last-frame draw calls (Babylon `_drawCalls.current` snapshotted after Play `scene.render()` — not `engine.drawCalls`, which is unset), bridge messages/s. Worker `stats` commands own `scriptMs` / `physicsMs`; the main-thread rAF pump only merges FPS so it cannot zero those timings. Editor viewport FPS is not shown on the Debug menu (Always Render is always on). Testids `stats-hud` and `play-fps` stay mounted while collapsed so QA can poll attributes after opening Stats.

Output Log, keyed Print, and the Preview session report are unchanged.

## Inspect protocol

Headless snapshot `createDebugInspectSnapshot(world)` in `@babylonslate/object-model` (separate type from harness `createWorldSnapshot` goldens). Nodes: Game Instance if any, then actors parent-before-child (`parentId` variable), then each actor’s components as children. Label is the `name` variable, else `classId`. Values are JSON-safe: primitives stay; `BObject` → `{ guid, classId }`; circular / non-cloneable → `formatValue()`.

Bridge: `{ type: "inspect" }` control → `{ type: "inspectSnapshot", snapshot }` command (same waiter pattern as `console` / `consoleResult`). Overlay Play polls **only while the inspector dialog is open**, ~5 Hz. In-process Play calls `runtime.inspectWorld()` directly. The inspector is read-only this pass (no `setVariable` from the UI).

## Trace recorder

`snapshot start` / `snapshot stop` fill a `TraceRecorder` (stats, logs, prints, world snapshots, input, RNG seed) with a byte budget. Stop emits a `trace` command. `@babylonslate/assets` round-trips the payload as a `Trace` document (`.babtrace` uses the `.babasset` container). Play shows a scrubbable `TracePlayback` panel. Headless replay: same seed + tick count → same `stringifyWorldSnapshot`.

## Export settings (P14)

Project Settings **Export Game** preset: **Bundle Debugger** (off for release). Release export compiles with `compileGraphDocumentsForExport` (Print defaults on; Inspector **Development Only** nodes are omitted). A non-debug player still links `@babylonslate/debugger` **core** commands; debug-tier implementations are not registered (`includeDebug: false`). **Preview Build** always bundles the debugger and keeps Development Only nodes. Draw-call ceilings (`DRAW_CALL_WARN_CEILING`) surface as HUD warnings. See [exporter.md](exporter.md).
