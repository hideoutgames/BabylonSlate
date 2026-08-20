# Console commands — engine pass

Plan for making built-in Play/export console commands actually useful, without breaking user `BDebugCommand` classes. Package overview stays in [debugger.md](debugger.md). Spec source: engineplan §9.

The organising idea does not change: **the command system is always present; only the debugger UI and debug-tier commands are optional.** What changes is that engine names must **do the thing they say**, editor Play must ship a useful debug set **by default**, and user commands stay first-class on every build.

## How it works

| Layer | Role |
| --- | --- |
| `@babylonslate/debugger` | Parser, registry, builtin catalog, `createUserCommand`, autocomplete. No React, Babylon, or runtime. |
| `ConsoleCommandHost` | Callbacks the registry invokes. `RuntimeDriver.consoleHost()` implements it. |
| `RuntimeDriver.executeConsoleCommand` | Play, Preview, `ExecuteConsoleCommand`, and worker `{ type: "console" }` all go through this. |
| Overlay `DebugConsole` | Modal dialog; Play keeps ticking. Completions from `playConsoleCommands` (builtins + compiled `script.command`). |
| `BDebugCommand` | User class → `Event On Command Run` → compiled as **core** via `loadScripts` / `bindUserCommand`. Ships even when `includeDebug: false`. |

Parser: whitespace tokens, quoted strings, longest-name match (`stat unit`, `snapshot start`), positional or `name=value` args, coercion to string/float/int/bool/enum. Unknown names and stripped debug names return `{ success: false, output }` and never throw.

## Audit — builtins

**Applies** means the host mutates simulation, renderer, audio, or overlay chrome.

### Core (every build)

| Command | Registered | Applies | Notes |
| --- | --- | --- | --- |
| `changescene` | yes | **yes** | Loads from the Play scene library (guid or display name). Same path as `ctx.changeScene`. |
| `shadowquality` | yes | **yes** | Emits `{ type: "setShadowQuality" }`; renderer sizes or disposes the one `ShadowGenerator`. `2048` warns. No arg → print current. |
| `quit` | yes | **yes** | `runtime.stop()`. Overlay Stop is a separate chrome path. |
| `renderquality` | yes | **yes** | `{ type: "setRenderQuality" }` → Play `HardwareScalingController` (`high=1`, `medium=1.5`, `low=2`). No arg → print current. |
| `resolutionscale` | yes | **yes** | `{ type: "setResolutionScale" }` → Play `setLevel`, clamped `1..2` (Play valve max may be 4). Host stores and prints the clamped value. No arg → print current. Play canvas only. |
| `framecap` | yes | **yes** | `{ type: "setFrameCap" }` → Play/player `scheduler.setFrameCap`. No arg → print current. |
| `volume` | yes | **yes** | `{ type: "setGlobalVolume" }` (P16 mixer). No arg → print current. |
| `help` | yes | **yes** | Core. Lists registered names or one command’s parameters. Stripped debug names print “not available in this build”. |

### Debug (editor Play and bundled-debugger exports)

| Command | Registered | Applies | Notes |
| --- | --- | --- | --- |
| `pause` | yes | **yes** | Idempotent. Emits `{ type: "sessionPaused"; paused: true }`. Overlay button reads Resume. |
| `resume` / `unpause` | yes | **yes** | Idempotent. Emits `sessionPaused: false`. Does not stop free cam. |
| `step` | yes | **yes** | Overlay Step: `resume()` → `tick()` → `pause()` if it was paused. |
| `slomo` | yes | **yes** | `RuntimeDriver.timeDilation` clamp `0..8`. `tick` uses `dt * rate` for script, physics, nav, BT. Trace header and frame snapshots store undilated `dt`. No arg → print current. |
| `freecam` | yes | **yes** | `{ type: "setFreeCam" }`. Detached fly/pan camera; simulation keeps ticking. Pointer/WASD stolen; 2D pinch zooms ortho; gamepad still forwards (`help freecam` documents that split). Overlay Play shows a touch fly stick while on. Off / `changescene` / `possessCamera` restore. FPS look (drag right looks right). |
| `showfps` | yes | **yes** | Opens/collapses Stats HUD (`setShowFps`). Flag default is **on**. |
| `stat unit` / `memory` / `draws` / `threads` | yes | **yes** | Opens Stats HUD and highlights that row. `threads` is main vs worker timings (fps vs script/physics), not OS threads. |
| `showcollision` / `showbounds` / `actorboundingbox` / `wireframe` | yes | **yes** | Play-scene overlays. Collision uses `listDebugColliders()` (boxes/spheres/circles/capsules/polylines, including body rotation of local offsets and polyline points). Overlay meshes sit in `RENDERING_GROUP.world` (depth-tested, not a group-0 underlay). Reuse by id when pose changes. Skip helper/debug meshes. `actorboundingbox` is an alias of `showbounds`. |
| `shownav` | yes | **yes** | `NavMeshDebugOverlay` on the Play scene (`RENDERING_GROUP.world`) with the session navmesh bytes **and** NavMesh Blocker volumes. Blocking Volumes are physics, not nav, and stay off this overlay. |
| `showaudiodebug` | yes | **yes** | DOM voice overlay from `AudioService` `debugVoices` (`setShowAudioDebug`). Flag default is **on**. |
| `dumpactors` | yes | **yes** | One line per actor from `inspectWorld()` (name, class, guid, position). |
| `inspect` | yes | **yes** | Prints inspect-snapshot variables. No arg uses overlay Inspector selection when known, else usage. |
| `dumplog` | yes | **yes** | Returns the log-ring messages. |
| `snapshot start` / `stop` | yes | **yes** | `TraceRecorder`; stop emits `{ type: "trace" }`. |

### Overlay vs console (session control)

Play chrome **Pause** / **Resume** and **Step** share `RuntimeDriver.pause` / `resume` and the overlay step helper. Console pause/resume emit `sessionPaused` so the chrome label matches. Overlay Pause still toggles via `session.setPaused`.

### Autocomplete

`suggestConsoleCompletions(line, commands, context?)` completes:

- Command names (prefix)
- Enum values
- Bool flags: `on` / `off`
- `param=` chips when the next arg is empty
- Default / example values when `defaultValue` is set
- Context lists from `CommandParameter.complete`: `scenes` (`changescene`), `actors` (`inspect`), `commands` (`help`)

Play passes scene keys and live actor names (inspect snapshots while the **console or inspector** is open). Debugger stays headless.

`applyConsoleCompletion(line, suggestion, commands)` replaces the **current token** (or appends after a trailing space). Command-name hits become `name `. DebugConsole chips and Tab call this helper; history stays ArrowUp/Down.

### User commands

- Authored on `Event On Command Run` (`commandName`, description, category, parameter list). Empty name falls back to the class id lowercased (`consoleCommandFromGraph`).
- Registered **after** builtins. Engine names are reserved: `register` refuses overwrite; edit-time `console.reserved_name` on `commandName`.
- Autocomplete includes them. `ExecuteConsoleCommand` runs them in release builds (`includeDebug: false`).
- Duplicate **user** names: last compiled class wins; keep last-wins.

## Landed spec

### Principles

1. **Names do what they say.** A successful result means the host applied the change (or reported the current value), not that a log line was emitted.
2. **Debug set is on by default in editor Play** (`includeDebug: true`). Release exports still strip debug implementations.
3. **User commands stay core** and keep their authored names. Do not prefix (`game.heal`) and do not move them to the debug tier.
4. **Engine names are reserved.** User `commandName` values that match a builtin (including stripped debug names) fail at edit-time and at `register` with a diagnostic. The engine command stays; the user command is not installed. Pick distinctive engine names (`freecam`, not `cam`) so this rarely bites.
5. **One pause path.** Console `pause` / `resume` / `step` and overlay Pause / Resume / Step share `RuntimeDriver.pause` / `resume` and the overlay step helper. Overlay chrome follows a worker→main `sessionPaused` command.
6. **Optional args query.** Setter commands with a required value today should accept no args and print the current value (`slomo` → `slomo 1`, `volume` → `volume 1`). Bool flags keep `on`/`off`; omitted flag still means on (existing `FLAG` default) unless the command is a toggle pair (`pause` / `resume`).
7. **Debugger package stays headless.** New work goes through `ConsoleCommandHost` + bridge commands. Render/audio/camera live in `@babylonslate/render` / the Play overlay.

### Core catalog (every build)

Seven core setters plus `help`. Optional args print the current value.

| Command | Target |
| --- | --- |
| `changescene <scene>` | Unchanged. |
| `renderquality [low\|medium\|high]` | Apply scaling floor / tier on the Play (or player) `HardwareScalingController`. No arg → print current. |
| `shadowquality [off\|512\|1024\|2048]` | Unchanged apply. No arg → print current. |
| `resolutionscale [n]` | Play `setLevel`, clamped `1..2` (print and emit the clamped value). No arg → print current. |
| `framecap [fps]` | Play/player `scheduler.setFrameCap`. No arg → print current. |
| `volume [0..1]` | Emit `setGlobalVolume` (same as the graph node). No arg → print current. |
| `quit` | Unchanged. |
| `help [name]` | Core. No arg: names + one-line descriptions, user commands included, grouped by category (`engine` vs authored category). With a name: parameters and enum values. Stripped debug names still print “not available in this build” rather than “unknown”. `help` is **registry-driven**: registering a builtin in `builtinCommands()` (plus `CORE_COMMAND_NAMES` / `DEBUG_COMMAND_NAMES`) or a user `BDebugCommand` is enough — do not duplicate a help string. |

`help` ships in release so `ExecuteConsoleCommand("help")` and a bundled-debugger player console can list what is actually registered.

### Debug catalog — session

| Command | Target |
| --- | --- |
| `pause` | Pause simulation (idempotent). Emit `sessionPaused`. Overlay button reads **Resume**. |
| `resume` | Unpause (idempotent). Alias `unpause`. Overlay button reads **Pause**. Does not stop free cam. |
| `step` | Same as overlay Step: one tick while staying paused (`resume` → `tick` → `pause`). Safe no-op if not paused (still advances one tick, then leaves running). |
| `slomo [rate]` | Store a dilation on the driver; `tick` uses `dt * rate` (rate `0` is pause-equivalent for sim, not a substitute for `pause`). Clamp to a documented range (e.g. `0..8`). No arg → print current. Default `1`. |

Do **not** make `pause` a toggle. The overlay button toggles; the console uses explicit `pause` / `resume` so graphs and typed commands stay unambiguous.

### Debug catalog — free camera

| Command | Target |
| --- | --- |
| `freecam [on\|off]` | Detach a fly/pan camera from the possessed game camera. **Simulation keeps ticking.** No arg → on (same bool-flag convention as `showfps`). `off` restores the possessed / default Play camera. |

Constraints:

- Does **not** call `pause`. Overlay Pause stays independent (free-cam a running fight, or a paused tableau).
- Worker emits `{ type: "setFreeCam"; enabled }`. Main thread owns the camera: 3D fly (`UniversalCamera` with look + WASD/stick), 2D pan/pinch on an ortho camera. Game cameras stay detached and keep receiving snapshot TRS; they are just not `scene.activeCamera`.
- While enabled, Play canvas look/move (pointer, touch, WASD) drive the debug camera and are **not** forwarded into the input ring. Gamepad can keep feeding the worker so a pad-controlled pawn still moves while the operator flies. Overlay Play mounts the editor fly stick (`ViewportJoystick`) while free cam is on. Document that split in the command help string.
- Re-possess / `changescene` turns free cam off (new scene owns the camera, same as today’s `cameraPossessedByScript` reset).
- Touch-first: one-finger look (3D) or pan (2D), pinch zoom, on-screen fly stick in overlay Play. 44px is not required on the canvas itself (existing Play canvas rules). Drag right looks right; drag up looks up.

This is the missing “spectate without pausing” tool. It is not a Possess Camera graph node and must not write actor transforms.

### Debug catalog — visualization and dump

| Command | Target |
| --- | --- |
| `showfps [on\|off]` | Open/collapse the Stats HUD (same as the Stats chrome button), not a second FPS widget. |
| `stat unit` / `memory` / `draws` / `threads` | Ensure Stats HUD is open and highlight that row. `threads` means main vs worker timings (script/physics vs render), not OS threads. |
| `wireframe [on\|off]` | Force wireframe on Play scene meshes (skip helper/debug lines). |
| `showbounds [on\|off]` | AABB / selection-style bounds on spawned Play meshes. |
| `actorboundingbox [on\|off]` | Same host as `showbounds` (`setShowBounds`). Keep `showbounds` as the existing alias. |
| `showcollision [on\|off]` | Physics collider debug draw for the active backend (Havok / Rapier / software AABB). Boxes/spheres/circles/capsules/polylines from `listDebugColliders()`; local collider offsets and polyline points use body world rotation. Capsule total height is `2 * halfHeight + 2 * radius`. World-group depth-tested overlay, not a group-0 underlay. Not full convex mesh authorship. Editor-grid 2D camera bounds are unrelated. Does **not** replace per-collider **Render In Game** (world dashes when that property is on). |
| `shownav [on\|off]` | Reuse `NavMeshDebugOverlay` on the Play scene (baked nav chunk when present, plus NavMesh Blocker volumes). Same world rendering group as Play meshes. |
| `showaudiodebug [on\|off]` | DOM overlay of playing voices (guid, clip, gain, pitch, loop, spatial, distance, radii, inside radius). Empty list: `No playing voices`. Off unmounts the overlay. Polls with `requestAnimationFrame` so it still draws while sim is paused. |
| `dumpactors` | One line per actor: name, class, guid, world position. |
| `inspect [name\|guid]` | Print the inspect-snapshot variables for that node (same data as the Inspector overlay). No arg → print the current inspector selection if any, else usage. |
| `dumplog` / `snapshot start` / `snapshot stop` | Unchanged. |

`showcollision` / `showbounds` / `actorboundingbox` / `wireframe` / `shownav` / `showaudiodebug` stay debug-tier and stay off the Debug menu; the console is the default way to arm them.

### Intentionally not engine commands

Game-specific cheats (`god`, `heal`, `give`, `teleport pawn`) stay **user** `BDebugCommand` classes — that is what the type is for.

Parked (do not block this pass):

- Packaged-player command **line** UI (bundled-debugger player today is a stats string only). Editor Play console is the default surface. A tiny player prompt can follow once `help` / `resume` / `freecam` exist.
- `screenshot`, `viewmode unlit`, `kill` / `spawn` from the console, `restart` as a distinct command (`changescene` of the current scene already reloads).
- Making `pause` toggle.

## Host and bridge

Worker→main commands:

| Command | Direction | Purpose |
| --- | --- | --- |
| `sessionPaused` | worker → main | Overlay chrome Pause/Resume label + `userPausedRef` |
| `setRenderQuality` / `setResolutionScale` / `setFrameCap` | worker → main | Play view hardware scaling + scheduler cap |
| `setGlobalVolume` | already existed | `volume` console command reuses it |
| `setFreeCam` | worker → main | Attach/detach debug camera, input steal |
| `setWireframe` / `setShowBounds` / `setShowCollision` / `setShowNav` / `setShowAudioDebug` | worker → main | Play-scene overlays; audio debug is a DOM overlay, not Babylon GUI |
| `debugColliders` | worker → main | Collision primitives while `showcollision` is on |
| `setShowFps` / `setStat` | worker → main | Stats HUD open + row |

## User-command usability

- Core tier, every export.
- Authored `commandName` / description / category / parameter list.
- Console autocomplete + `ExecuteConsoleCommand`.
- `help` listing user commands next to engine ones.
- Reserved-name set = `CORE_COMMAND_NAMES` ∪ `DEBUG_COMMAND_NAMES` (lowercase). Used by `CommandRegistry.register`, graph validation, and the Command Name field (inline error, not a silent overwrite).
- Duplicate **user** names: last compiled class wins; keep last-wins. Do not invent a prefix.

## Implementation slices

Landed on this pass (do not reopen P8). Spec above matches the code.

- [x] **p8-console-session** — `resume` / `unpause`; `step` resume→tick→pause; `sessionPaused`; `help [name]`; reserved names
- [x] **p8-console-apply** — `volume` / `framecap` / `renderquality` / `resolutionscale` apply; omitted args print current
- [x] **p8-console-slomo** — `tick` uses `dt * rate` (script, physics, nav, BT); traces keep recorded `dt`
- [x] **p8-console-freecam** — detached fly/pan; no pause; restore on off / `changescene` / possess; pointer/WASD steal, gamepad still forwards
- [x] **p8-console-viz** — Stats HUD, wireframe/bounds/collision/nav, `dumpactors` / `inspect`

Parked (unchanged): packaged-player command **line** UI, `god`/`give` as engine commands, making `pause` a toggle.

## Docs and tests

- This page is the catalog. [debugger.md](debugger.md) keeps package API, tiers, parser, HUD, and the host table.
- engineplan §9.1 lists the extra names; Appendix A holds the slice checkboxes.
- New behaviour in `packages/debugger`, `packages/runtime`, `packages/render`, `apps/editor` Play overlay, and graph validation is covered by unit tests in those packages.
