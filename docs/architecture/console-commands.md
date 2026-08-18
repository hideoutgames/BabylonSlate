# Console commands — engine pass

Plan for making built-in Play/export console commands actually useful, without breaking user `BDebugCommand` classes. Package overview stays in [debugger.md](debugger.md). Spec source: engineplan §9.

The organising idea does not change: **the command system is always present; only the debugger UI and debug-tier commands are optional.** What changes is that engine names must **do the thing they say**, editor Play must ship a useful debug set **by default**, and user commands stay first-class on every build.

## How it works today

| Layer | Role |
| --- | --- |
| `@babylonslate/debugger` | Parser, registry, builtin catalog, `createUserCommand`, autocomplete. No React, Babylon, or runtime. |
| `ConsoleCommandHost` | Callbacks the registry invokes. `RuntimeDriver.consoleHost()` implements it. |
| `RuntimeDriver.executeConsoleCommand` | Play, Preview, `ExecuteConsoleCommand`, and worker `{ type: "console" }` all go through this. |
| Overlay `DebugConsole` | Modal dialog; Play keeps ticking. Completions from `playConsoleCommands` (builtins + compiled `script.command`). |
| `BDebugCommand` | User class → `Event On Command Run` → compiled as **core** via `loadScripts` / `bindUserCommand`. Ships even when `includeDebug: false`. |

Parser: whitespace tokens, quoted strings, longest-name match (`stat unit`, `snapshot start`), positional or `name=value` args, coercion to string/float/int/bool/enum. Unknown names and stripped debug names return `{ success: false, output }` and never throw.

## Audit — existing builtins

**Applies** means the host mutates simulation, renderer, audio, or overlay chrome. **Log only** means `emitSetting` writes `key=value` to the log ring and nothing else happens.

### Core (every build)

| Command | Registered | Applies today | Notes |
| --- | --- | --- | --- |
| `changescene` | yes | **yes** | Loads from the Play scene library (guid or display name). Same path as `ctx.changeScene`. |
| `shadowquality` | yes | **yes** | Emits `{ type: "setShadowQuality" }`; renderer sizes or disposes the one `ShadowGenerator`. `2048` warns. |
| `quit` | yes | **yes** | `runtime.stop()`. Overlay Stop is a separate chrome path. |
| `renderquality` | yes | log only | Enum `low` / `medium` / `high`. Should drive the hardware-scaling floor / quality tier (engineplan §2.4). |
| `resolutionscale` | yes | log only | Should call `HardwareScalingController.setLevel`. |
| `framecap` | yes | log only | Play session already has `setFrameCap` → `scheduler.setFrameCap`. Console never calls it. |
| `volume` | yes | log only | Should emit existing `{ type: "setGlobalVolume" }` (P16 mixer). |

### Debug (editor Play and bundled-debugger exports)

| Command | Registered | Applies today | Notes |
| --- | --- | --- | --- |
| `pause` | yes | **sim only** | `runtime.pause()`. Overlay Pause/Resume chrome does **not** update. No `resume` command. |
| `step` | yes | **broken while paused** | Console calls `tick()`, and `tick()` returns immediately when `paused`. Overlay **Step** uses `resume` → `tick` → `pause` (worker `{ type: "step" }`). |
| `slomo` | yes | log only | Should scale tick `dt`. Runtime has no time-dilation field. |
| `showfps` | yes | log only | Stats HUD is a separate overlay toggle. Flag default is **on** (`showfps` with no arg enables). |
| `stat unit` / `memory` / `draws` / `threads` | yes | log only | `stat X` only enables; there is no off / query. HUD already shows fps, script/physics ms, memory, draws. |
| `showcollision` / `showbounds` / `wireframe` | yes | log only | debugger.md already records that no overlay exists yet. |
| `dumplog` | yes | **yes** | Returns the log-ring messages. |
| `snapshot start` / `stop` | yes | **yes** | `TraceRecorder`; stop emits `{ type: "trace" }`. |

### Overlay vs console (session control)

Play chrome already has **Pause** / **Resume** (one button) and **Step** while paused (`PlayOverlayChrome`). Those call `session.setPaused` / `session.step`, not the console registry. Typing `pause` in the console and tapping Pause are two unsynced paths.

`RuntimeDriver.resume()` exists and the worker `setPaused: false` control uses it. It is not a console command.

### User commands

- Authored on `Event On Command Run` (`commandName`, description, category, parameter list). Empty name falls back to the class id lowercased (`consoleCommandFromGraph`).
- Registered **after** builtins with `byName.set` — a user `pause` **silently overwrites** the engine command.
- Autocomplete includes them. `ExecuteConsoleCommand` runs them in release builds.
- No reserved-name lint. No `help`.

## Target behaviour

### Principles

1. **Names do what they say.** A successful result means the host applied the change (or reported the current value), not that a log line was emitted.
2. **Debug set is on by default in editor Play** (`includeDebug: true`). Release exports still strip debug implementations.
3. **User commands stay core** and keep their authored names. Do not prefix (`game.heal`) and do not move them to the debug tier.
4. **Engine names are reserved.** User `commandName` values that match a builtin (including stripped debug names) fail at edit-time and at `register` with a diagnostic. The engine command stays; the user command is not installed. Pick distinctive engine names (`freecam`, not `cam`) so this rarely bites.
5. **One pause path.** Console `pause` / `resume` / `step` and overlay Pause / Resume / Step share `RuntimeDriver.pause` / `resume` and the overlay step helper. Overlay chrome follows a worker→main `sessionPaused` command.
6. **Optional args query.** Setter commands with a required value today should accept no args and print the current value (`slomo` → `slomo 1`, `volume` → `volume 1`). Bool flags keep `on`/`off`; omitted flag still means on (existing `FLAG` default) unless the command is a toggle pair (`pause` / `resume`).
7. **Debugger package stays headless.** New work goes through `ConsoleCommandHost` + bridge commands. Render/audio/camera live in `@babylonslate/render` / the Play overlay.

### Core catalog (every build)

Keep the current seven. Add `help`. Wire the log-only setters.

| Command | Target |
| --- | --- |
| `changescene <scene>` | Unchanged. |
| `renderquality [low\|medium\|high]` | Apply scaling floor / tier on the Play (or player) `HardwareScalingController`. No arg → print current. |
| `shadowquality [off\|512\|1024\|2048]` | Unchanged apply. No arg → print current. |
| `resolutionscale [n]` | `setLevel(n)` on the Play view. No arg → print current. |
| `framecap [fps]` | Play/player `scheduler.setFrameCap`. No arg → print current. |
| `volume [0..1]` | Emit `setGlobalVolume` (same as the graph node). No arg → print current. |
| `quit` | Unchanged. |
| `help [name]` | **New, core.** No arg: names + one-line descriptions, user commands included, grouped by category (`engine` vs authored category). With a name: parameters and enum values. Stripped debug names still print “not available in this build” rather than “unknown”. |

`help` ships in release so `ExecuteConsoleCommand("help")` and a bundled-debugger player console can list what is actually registered.

### Debug catalog — session

| Command | Target |
| --- | --- |
| `pause` | Pause simulation (idempotent). Emit `sessionPaused`. Overlay button reads **Resume**. |
| `resume` | **New.** Unpause (idempotent). Alias `unpause`. Overlay button reads **Pause**. Does not stop free cam. |
| `step` | Same as overlay Step: one tick while staying paused (`resume` → `tick` → `pause`). Safe no-op if not paused (still advances one tick, then leaves running). |
| `slomo [rate]` | Store a dilation on the driver; `tick` uses `dt * rate` (rate `0` is pause-equivalent for sim, not a substitute for `pause`). Clamp to a documented range (e.g. `0..8`). No arg → print current. Default `1`. |

Do **not** make `pause` a toggle. The overlay button toggles; the console uses explicit `pause` / `resume` so graphs and typed commands stay unambiguous.

### Debug catalog — free camera

| Command | Target |
| --- | --- |
| `freecam [on\|off]` | **New.** Detach a fly/pan camera from the possessed game camera. **Simulation keeps ticking.** No arg → on (same bool-flag convention as `showfps`). `off` restores the possessed / default Play camera. |

Constraints:

- Does **not** call `pause`. Overlay Pause stays independent (free-cam a running fight, or a paused tableau).
- Worker emits `{ type: "setFreeCam"; enabled }`. Main thread owns the camera: 3D fly (`UniversalCamera` with look + WASD/stick), 2D pan/pinch on an ortho camera. Game cameras stay detached and keep receiving snapshot TRS; they are just not `scene.activeCamera`.
- While enabled, Play canvas look/move (pointer, touch, WASD) drive the debug camera and are **not** forwarded into the input ring. Gamepad can keep feeding the worker so a pad-controlled pawn still moves while the operator flies. Document that split in the command help string.
- Re-possess / `changescene` turns free cam off (new scene owns the camera, same as today’s `cameraPossessedByScript` reset).
- Touch-first: one-finger look (3D) or pan (2D), pinch zoom, 44px is not required on the canvas itself (existing Play canvas rules).

This is the missing “spectate without pausing” tool. It is not a Possess Camera graph node and must not write actor transforms.

### Debug catalog — visualization and dump

| Command | Target |
| --- | --- |
| `showfps [on\|off]` | Open/collapse the Stats HUD (same as the Stats chrome button), not a second FPS widget. |
| `stat unit` / `memory` / `draws` / `threads` | Ensure Stats HUD is open and highlight that row. `threads` means main vs worker timings (script/physics vs render), not OS threads. |
| `wireframe [on\|off]` | Force wireframe on Play scene meshes (skip helper/debug lines). |
| `showbounds [on\|off]` | AABB / selection-style bounds on spawned Play meshes. |
| `showcollision [on\|off]` | Physics collider debug draw for the active backend (Havok / Rapier / software AABB). No overlay exists yet; this slice adds one, editor-grid 2D camera bounds are unrelated. |
| `shownav [on\|off]` | **New.** Reuse `NavMeshDebugOverlay` on the Play scene when a nav chunk is loaded. |
| `dumpactors` | **New.** One line per actor: name, class, guid, world position. |
| `inspect [name\|guid]` | **New.** Print the inspect-snapshot variables for that node (same data as the Inspector overlay). No arg → print the current inspector selection if any, else usage. |
| `dumplog` / `snapshot start` / `snapshot stop` | Unchanged. |

`showcollision` / `showbounds` / `wireframe` stay debug-tier and stay off the Debug menu until the overlay exists; the console is the default way to arm them.

### Intentionally not engine commands

Game-specific cheats (`god`, `heal`, `give`, `teleport pawn`) stay **user** `BDebugCommand` classes — that is what the type is for.

Parked (do not block this pass):

- Packaged-player command **line** UI (bundled-debugger player today is a stats string only). Editor Play console is the default surface. A tiny player prompt can follow once `help` / `resume` / `freecam` exist.
- `screenshot`, `viewmode unlit`, `kill` / `spawn` from the console, `restart` as a distinct command (`changescene` of the current scene already reloads).
- Making `pause` toggle.

## Host and bridge

Extend `ConsoleCommandHost` with required-or-optional methods matching the catalog. Runtime implements them by mutating driver state and/or emitting commands. New worker→main command types (names indicative):

| Command | Direction | Purpose |
| --- | --- | --- |
| `sessionPaused` | worker → main | Overlay chrome Pause/Resume label + `userPausedRef` |
| `setRenderQuality` / `setResolutionScale` / `setFrameCap` | worker → main | Play view hardware scaling + scheduler cap |
| `setGlobalVolume` | already exists | `volume` console command reuses it |
| `setFreeCam` | worker → main | Attach/detach debug camera, input steal |
| `setWireframe` / `setShowBounds` / `setShowCollision` / `setShowNav` | worker → main | Play-scene overlays |
| `setShowFps` / `setStat` | worker → main | Stats HUD open + row |

Core setters that already succeed in tests while only logging must keep succeeding, but tests should assert the **command or driver field**, not only `log`.

`step` on the host must call the overlay helper semantics, not `tick()` while paused.

## User-command usability

Keep:

- Core tier, every export.
- Authored `commandName` / description / category / parameter list.
- Console autocomplete + `ExecuteConsoleCommand`.
- `help` listing user commands next to engine ones.

Add:

- Reserved-name set = `CORE_COMMAND_NAMES` ∪ `DEBUG_COMMAND_NAMES` (lowercase). Used by `CommandRegistry.register`, graph validation, and the Command Name field (inline error, not a silent overwrite).
- Duplicate **user** names: last compiled class wins today; keep last-wins but log once (same as two classes claiming one command). Do not invent a prefix.
- Descriptions shown in `help` and in autocomplete chips when a single command is matched (parameter hints already exist for enums).

## Implementation slices

Do not reopen P8. Land as named follow-ups. Each slice updates this doc’s audit table and [debugger.md](debugger.md) host table in the same PR.

### `p8-console-session`

Session control and registry hygiene.

- `resume` / `unpause`; `pause` stays idempotent.
- Fix `step` (resume/tick/pause).
- `sessionPaused` so overlay chrome matches the console.
- `help [name]`.
- Reserved names: register refuses overwrite; edit-time diagnostic on `commandName`.
- Getter form (no args) for `slomo` can wait for the slomo slice; `help` should still list `slomo`.

Tests: registry + `execute-console` + overlay chrome (`play-overlay-chrome` / play-session) + validation for a user class named `pause`.

### `p8-console-apply`

Core setters actually apply.

- `volume` → `setGlobalVolume`.
- `framecap` → Play/player scheduler.
- `renderquality` / `resolutionscale` → hardware scaling on the Play view (not the editor viewport). Map `low`/`medium`/`high` onto documented scaling levels (same ladder as §2.4 / Engine Settings).
- Optional-arg query prints the last applied value.

Tests: runtime emit assertions + render/player apply tests. Keep `includeDebug: false` coverage so release still runs these.

### `p8-console-slomo`

Time dilation on `RuntimeDriver.tick` (`dt * rate`) including physics, nav crowd, BT, and script `deltaSeconds`. `slomo 1` is identity. Trace replay stays on the recorded `dt` (do not bake dilation into traces unless a later trace slice says so).

### `p8-console-freecam`

`freecam` as specified above. Tests: registry; emit `setFreeCam`; render attach/detach restores possessed camera; `changescene` clears it; pause state unchanged. Playwright: optional Play overlay smoke if an existing play spec can type into the console without a new fixture.

### `p8-console-viz`

`wireframe`, `showbounds`, `showcollision`, `shownav`, `showfps`/`stat *` HUD wiring, `dumpactors`, `inspect`. Collision draw is the largest piece (physics debug primitives on the Play scene, 2D and 3D). `shownav` is the small Recast overlay reuse.

## Docs and tests

- This page is the catalog. [debugger.md](debugger.md) keeps package API, tiers, parser, HUD, and the host table (update as slices land).
- engineplan §9.1 lists the extra names; Appendix A holds the slice checkboxes.
- New behaviour in `packages/debugger`, `packages/runtime`, `packages/render`, `apps/editor` Play overlay, and graph validation needs tests in those packages. `pnpm verify` before merge.

## Suggested order

`p8-console-session` first (resume, step, help, reserved names — unblocks daily debugging with almost no render work). Then `p8-console-apply` and `p8-console-slomo` (host already has the hooks). Then `p8-console-freecam`. Visualization last (`p8-console-viz`) because collision debug draw is new rendering, not a one-line host call.
