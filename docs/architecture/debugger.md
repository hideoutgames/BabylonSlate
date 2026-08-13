# Debugger and console (P8)

Shared surface for the command system, Play/export console, stats HUD, and later trace recorder (engineplan §9). Implementation: `@babylonslate/debugger` (headless registry + parser). HUD/console UI stays in the editor Play overlay and a future exported player; this package must not import React or Babylon.

The organising idea: **the command system is always present; only the debugger UI and debug-tier commands are optional.** A shipped game can still `changescene` or drop render quality with no console on screen.

## Package API (`@babylonslate/debugger`)

| Export | Role |
| --- | --- |
| `createCommandRegistry({ includeDebug })` | Core commands always; debug tier only when `includeDebug` is true |
| `CommandRegistry.execute(line, host)` | Parse, coerce, run; never throws |
| `tokenize` / `parseCommandArgs` | Quoted tokens, positional and `name=value` args, type coercion |
| `CORE_COMMAND_NAMES` / `DEBUG_COMMAND_NAMES` | Stable name lists for export presets and compile-time warnings |
| `warnDebugTierConsoleCommands` | Graph lint: ExecuteConsoleCommand literals that name a debug-tier command |
| `ConsoleCommandHost` | Engine callbacks the registry calls (runtime implements this) |

Depends on `@babylonslate/core` only if needed for shared types; no React, Babylon, or Capacitor. `@babylonslate/runtime` owns the host and wires `ctx.executeConsoleCommand`.

## Command tiers

Every registered command has a tier. A non-debug registry **does not register debug implementations**; it still recognises debug names so `ExecuteConsoleCommand` can return a clear failure instead of `unknown command`.

| Tier | Ships | Commands |
| --- | --- | --- |
| **core** | Every build | `changescene`, `renderquality`, `shadowquality`, `resolutionscale`, `framecap`, `volume`, `quit`, plus user `BDebugCommand` classes (later) |
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

Core setters that the main thread does not yet apply still succeed and emit a `log` command so graphs and tests can observe them.

## ExecuteConsoleCommand

The P5 node already compiles to `ctx.executeConsoleCommand(command)` and binds `success` / `output`. Runtime delegates that call to `CommandRegistry.execute`. Editor validation (`warnDebugTierConsoleCommands`) warns when the command pin’s **literal** is a debug-tier name, so a release export failure is visible before shipping. Connected (non-literal) pins are not flagged.

## Later slices (not this package’s first commit)

Reuse what already shipped. Do not rebuild Output Log, Print, the session report, or the command registry.

| Slice | Notes |
| --- | --- |
| `p8-bdebugcommand` | `BDebugCommand` Object subclass; **expand** the existing `ParameterListEditor` in `editor-kit` (types, optional, defaults, enum, reorder; ExecuteJavaScript Outputs); registry discovery via parent chain; user commands are **core** tier |
| `p8-console-hud` | Console bottom sheet (history, autocomplete, `SelectableText`); **extend** the Play overlay FPS/`scriptMs`/`physicsMs` strip into a ~5 Hz stats HUD (render/memory/draws/bridge traffic, tick-budget flag). Editor Always Render FPS stays on the chrome Debug menu |
| `p8-trace-recorder` | Capped buffer → `.babtrace` (container format); playback tab; replay through the headless harness; fill in `snapshot start` / `snapshot stop` stubs |

Print overlay, Output Log, and the Preview session report already shipped in P4/P5. Stats overlay FPS + ms shipped in P7. This package consumes those; it does not replace them.

## Export settings (P14)

Project Settings: bundle debugger (off for release), strip Print (defaults to following it). A non-debug player still links `@babylonslate/debugger` **core** commands. Debug-tier modules are the tree-shaken part.
