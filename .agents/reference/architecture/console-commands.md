# Console Commands

Built-in Play/export console command catalog, its principles, host wiring and user command rules. Registry, tiers and parser: [debugger.md](debugger.md).

## Wiring

| Layer | Role |
| --- | --- |
| [`packages/debugger/src/commands.ts`](../../../packages/debugger/src/commands.ts) | `builtinCommands()`, `CORE_COMMAND_NAMES`, `DEBUG_COMMAND_NAMES`, `MAX_TIME_DILATION` (8) |
| [`packages/debugger/src/autocomplete.ts`](../../../packages/debugger/src/autocomplete.ts) | `suggestConsoleCompletions` / `applyConsoleCompletion` |
| [`packages/debugger/src/validation.ts`](../../../packages/debugger/src/validation.ts) | `console.reserved_name`, debug-tier literal warnings |
| [`packages/runtime/src/runtime-console.ts`](../../../packages/runtime/src/runtime-console.ts) | `RuntimeConsole` implements `ConsoleCommandHost` |
| `RuntimeDriver.executeConsoleCommand` | Single entry for console, Preview, `ExecuteConsoleCommand` and worker `{ type: "console" }`. After Stop it refuses every command ("The runtime session has ended") |
| [`apps/editor/src/lib/play-console.ts`](../../../apps/editor/src/lib/play-console.ts) | `playConsoleCommands`: builtins + compiled `script.command` for completion |
| [`apps/editor/src/services/script-compiler.ts`](../../../apps/editor/src/services/script-compiler.ts) | `consoleCommandFromGraph` (user command metadata) |

## Principles

1. Names do what they say: success means the host applied the change or reported the current value, not that a log line was written.
2. Editor Play includes the debug set by default; release exports strip debug implementations.
3. User `BDebugCommand` commands stay core and keep their authored names. Do not prefix them or move them to debug.
4. Engine names are reserved (`CORE_COMMAND_NAMES ∪ DEBUG_COMMAND_NAMES`, lowercase, stripped names included). `register` refuses overwrite and the Command Name field shows an inline error. Duplicate user names: last compiled wins.
5. One pause path: console `pause` / `resume` / `step` and overlay buttons share `RuntimeDriver.pause` / `resume` and the overlay step helper. Overlay chrome follows the worker → main `sessionPaused` command.
6. Optional arguments query: setters print the current value when called bare. Bool flags default to on when omitted, except explicit pairs (`pause` / `resume`).
7. `help` is registry-driven. Registering a builtin (plus its name list) or a user class is enough; do not duplicate help strings.

## Core tier (every build)

| Command | Behavior |
| --- | --- |
| `changescene <scene>` | Same path as `ctx.changeScene`; guid or display name from the Play scene library |
| `quality [tier\|reset]` and `quality shadows\|resolution\|textures\|geometry\|water\|postprocessing\|lighting …` | Shared `RenderingQualitySession`; session overrides via `setScalability`; water fields from `WATER_QUALITY_FIELDS`; cleared at next Play |
| `renderpath [auto\|forward\|clusteredForward\|reset]` | Session-only render path request, never persisted |
| `framecap [fps]` | Render cap only; fixed simulation step and input polling unchanged. Initial value from project `playFrameCap` |
| `volume [0..1]` | `setGlobalVolume` (same as the graph node) |
| `quit` | `runtime.stop()`, then a `sessionEnded` command: editor Play ends its session through the Stop path, Preview Build closes, a standalone player stops itself. Also runs from `ExecuteConsoleCommand` |
| `help [name]` | Lists registered commands, user commands included |

## Debug tier

| Command | Behavior |
| --- | --- |
| `pause`, `resume` / `unpause`, `step` | Idempotent; `pause` is never a toggle. `step` = resume → tick → pause |
| `slomo [rate]` | `0..8`; every per-tick system uses the step captured at tick start, so a change applies next tick. Traces keep undilated `dt` plus per-frame `timeDilation` |
| `freecam [on\|off]` | Detached debug camera; simulation keeps ticking; pointer/WASD stop feeding the input ring, gamepad still forwards. Off, `changescene` or possess restore. Never writes actor transforms |
| `showfps`, `stat unit\|memory\|draws\|threads`, `lightsdebug` | Open Stats HUD / highlight row; `threads` means bridge traffic, not OS threads |
| `wireframe`, `showbounds` / `actorboundingbox`, `showcollision` / `debugphysics` | Play-scene overlays in the world rendering group (depth-tested). Collision uses `listDebugColliders()`; each physics-enabled Scene Layer draws in its own overlay scene |
| `shownav` / `shownavdebug`, `showpathfinding`, `shownavagent` | Navmesh, crowd paths and agent telemetry from live crowd state |
| `behaviourtreedebug`, `showaudiodebug` | Live BT inspector; DOM voice overlay (not Babylon GUI) that keeps drawing while paused |
| `dumpactors`, `inspect [name\|guid]`, `possess`, `destroyactor`, `dumplog`, `snapshot start\|stop` | Inspect data; possess/destroy by GUID or unique name (ambiguous names fail); trace recording |

The visualization commands stay off the Debug menu; the console arms them.

## Worker → main commands

`sessionPaused`, `setScalability`, `setGlobalVolume`, `setFreeCam`, `setWireframe` / `setShowBounds` / `setShowCollision` / `setShowNav` / `setShowAudioDebug`, `debugColliders` (one per physics world, tagged `layerId` for layers), `setShowFps` / `setStat`.

## Autocomplete

- Ranks command names exact → prefix → interior → subsequence, then enum values, `on` / `off`, `param=`, defaults, and context lists from `CommandParameter.complete` (`scenes`, `actors`, `commands`).
- Completion replaces the current token and preserves quoting. The debugger stays headless; Play supplies scene keys and live actor names.

## Not engine commands

- Game cheats (`god`, `heal`, `give`, `teleport`) belong in user `BDebugCommand` classes.
- Parked: a standalone exported-player command line, `screenshot`, `viewmode`, console `spawn` / `kill`, `restart` (`changescene` of the current scene reloads), a toggling `pause`.
