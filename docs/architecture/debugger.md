# Debugger and console (P8)

Shared surface for the command system, Play/export console, stats HUD, and trace recorder (engineplan §9). Implementation: `@babylonslate/debugger` (headless registry + parser + recorder). HUD/console UI lives in the editor Play overlay; this package must not import React or Babylon.

The organising idea: **the command system is always present; only the debugger UI and debug-tier commands are optional.** A shipped game can still `changescene` or drop render quality with no console on screen.

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

Depends on `@babylonslate/core` only if needed for shared types; no React, Babylon, or Capacitor. `@babylonslate/runtime` owns the host and wires `ctx.executeConsoleCommand`.

## Command tiers

Every registered command has a tier. A non-debug registry **does not register debug implementations**; it still recognises debug names so `ExecuteConsoleCommand` can return a clear failure instead of `unknown command`.

| Tier | Ships | Commands |
| --- | --- | --- |
| **core** | Every build | `changescene`, `renderquality`, `shadowquality`, `resolutionscale`, `framecap`, `volume`, `quit`, plus user `BDebugCommand` classes |
| **debug** | Debugger bundled | `showfps`, `stat unit`, `stat memory`, `stat draws`, `stat threads`, `showcollision`, `showbounds`, `wireframe`, `pause`, `step`, `slomo`, `dumplog`, `snapshot start`, `snapshot stop` |

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
| debug pause / step / slomo | `pause` / `step` / `setTimeDilation` |
| `dumplog` | `dumpLog()` from the log ring |
| overlay flags | `setShowFps`, `setStat`, `setShowCollision`, … |
| `snapshot start` / `snapshot stop` | `startSnapshot` / `stopSnapshot` → `TraceRecorder`; stop emits a `trace` command |

Core setters that the main thread does not yet apply (`renderquality`, `resolutionscale`, `volume`, `framecap`) still succeed and emit a `log` command so graphs and tests can observe them. `shadowquality` logs and applies.

## ExecuteConsoleCommand

The P5 node already compiles to `ctx.executeConsoleCommand(command)` and binds `success` / `output`. Runtime delegates that call to `CommandRegistry.execute`. Editor validation (`warnDebugTierConsoleCommands`) warns when the command pin’s **literal** is a debug-tier name, so a release export failure is visible before shipping. Connected (non-literal) pins are not flagged.

## BDebugCommand

`BDebugCommand` is an Object subclass in the class registry. User classes whose parent chain reaches it are discovered with `ClassRegistry.isA`. Class settings (command name, description, category, typed parameter list) live on the `Event On Command Run` node and drive generated output pins. Compiled graphs register as **core** commands via `RuntimeDriver.loadScripts` (`script.command`). They run from the Play console and from `ExecuteConsoleCommand` even when `includeDebugCommands` is false.

The shared `ParameterListEditor` in `editor-kit` authors those rows (types, optional, defaults, enum values, reorder) and ExecuteJavaScript Inputs/Outputs.

## Console and stats HUD

Play overlay chrome is a labeled top bar (Pause / Resume, Stats, Console, Stop) with 44px targets. `StatsHud` stays **collapsed** until Stats is tapped so the first Play frame reads as a game view. Pause calls `session.setPaused` (the same path as `attachLifecyclePause`). Console remains a secondary dialog. Close is one tap (**Stop**). Preview Build uses the same labeled **Stop** over its player iframe (the packaged player keeps its own stats HUD, which samples fps on the rAF pump; Pause / Console stay overlay-Play-only). When Preview Build is on, the chrome launch control reads **Preview**.

Play overlay **extends** the existing FPS / `scriptMs` / `physicsMs` strip:

- Bottom-sheet console (`DebugConsole`): history, registry autocomplete including enum values, accessory key bar, `SelectableText` transcript. Executes through in-process `runtime.executeConsoleCommand` or worker `{ type: "console" }`.
- ~5 Hz `StatsHud`: tick-budget flag (`isTickOverBudget`), accounted resource-cache bytes, mesh/texture counts, last-frame draw calls (Babylon `_drawCalls.current` snapshotted after Play `scene.render()` — not `engine.drawCalls`, which is unset), bridge messages/s. Worker `stats` commands own `scriptMs` / `physicsMs`; the main-thread rAF pump only merges FPS so it cannot zero those timings. Editor viewport FPS is not shown on the Debug menu (Always Render is always on). Testids `stats-hud` and `play-fps` stay mounted while collapsed so QA can poll attributes after opening Stats.

Output Log, keyed Print, and the Preview session report are unchanged.

## Trace recorder

`snapshot start` / `snapshot stop` fill a `TraceRecorder` (stats, logs, prints, world snapshots, input, RNG seed) with a byte budget. Stop emits a `trace` command. `@babylonslate/assets` round-trips the payload as a `Trace` document (`.babtrace` uses the `.babasset` container). Play shows a scrubbable `TracePlayback` panel. Headless replay: same seed + tick count → same `stringifyWorldSnapshot`.

## Export settings (P14)

Project Settings **Export Game** preset: **Bundle Debugger** (off for release). Release export compiles with `compileGraphDocumentsForExport` (Print defaults on; Inspector **Development Only** nodes are omitted). A non-debug player still links `@babylonslate/debugger` **core** commands; debug-tier implementations are not registered (`includeDebug: false`). **Preview Build** always bundles the debugger and keeps Development Only nodes. Draw-call ceilings (`DRAW_CALL_WARN_CEILING`) surface as HUD warnings. See [exporter.md](exporter.md).
