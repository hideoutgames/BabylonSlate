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

Real export tree-shaking of the debug module is **P14**. P8 proves the split with `createCommandRegistry({ includeDebug: false })`.

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
| `changescene` | `changeScene(guid)` → `World.loadScene` |
| `renderquality` / `shadowquality` / `resolutionscale` / `volume` / `framecap` | typed setters (Play overlay / renderer consume later) |
| `quit` | `quit()` → runtime `stop` |
| debug pause / step / slomo | `pause` / `step` / `setTimeDilation` |
| `dumplog` | `dumpLog()` from the log ring |
| overlay flags | `setShowFps`, `setStat`, `setShowCollision`, … |
| `snapshot start` / `snapshot stop` | `startSnapshot` / `stopSnapshot` → `TraceRecorder`; stop emits a `trace` command |

Core setters that the main thread does not yet apply still succeed and emit a `log` command so graphs and tests can observe them.

## ExecuteConsoleCommand

The P5 node already compiles to `ctx.executeConsoleCommand(command)` and binds `success` / `output`. Runtime delegates that call to `CommandRegistry.execute`. Editor validation (`warnDebugTierConsoleCommands`) warns when the command pin’s **literal** is a debug-tier name, so a release export failure is visible before shipping. Connected (non-literal) pins are not flagged.

## BDebugCommand

`BDebugCommand` is an Object subclass in the class registry. User classes whose parent chain reaches it are discovered with `ClassRegistry.isA`. Class settings (command name, description, category, typed parameter list) live on the `Event On Command Run` node and drive generated output pins. Compiled graphs register as **core** commands via `RuntimeDriver.loadScripts` (`script.command`). They run from the Play console and from `ExecuteConsoleCommand` even when `includeDebugCommands` is false.

The shared `ParameterListEditor` in `editor-kit` authors those rows (types, optional, defaults, enum values, reorder) and ExecuteJavaScript Inputs/Outputs.

## Console and stats HUD

Play overlay **extends** the existing FPS / `scriptMs` / `physicsMs` strip:

- Bottom-sheet console (`DebugConsole`): history, registry autocomplete including enum values, accessory key bar, `SelectableText` transcript. Executes through in-process `runtime.executeConsoleCommand` or worker `{ type: "console" }`.
- ~5 Hz `StatsHud`: tick-budget flag (`isTickOverBudget`), accounted resource-cache bytes, mesh/texture counts, draw calls when the engine reports them, bridge messages/s. Editor Always Render FPS stays on the chrome Debug menu.

Output Log, keyed Print, and the Preview session report are unchanged.

## Trace recorder

`snapshot start` / `snapshot stop` fill a `TraceRecorder` (stats, logs, prints, world snapshots, input, RNG seed) with a byte budget. Stop emits a `trace` command. `@babylonslate/assets` round-trips the payload as a `Trace` document (`.babtrace` uses the `.babasset` container). Play shows a scrubbable `TracePlayback` panel. Headless replay: same seed + tick count → same `stringifyWorldSnapshot`.

## Export settings (P14)

Project Settings: bundle debugger (off for release), strip Print (defaults to following it). A non-debug player still links `@babylonslate/debugger` **core** commands. Debug-tier modules are the tree-shaken part.
