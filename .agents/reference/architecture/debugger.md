# Debugger

Haptic's headless command registry, infinite-loop guard, trace recorder, inspect protocol, Play overlay diagnostics and Simulation Play contracts. Command catalog: [console-commands.md](console-commands.md).

## Core rule

The command system is always present; only the debugger UI and debug-tier commands are optional. A shipped game can still `changescene` or change quality with no console on screen.

## Ownership

| Area | Source |
| --- | --- |
| Registry, parser, tiers, autocomplete, stats cadence, loop guard, `TraceRecorder`, performance/session diagnostics | [`packages/debugger/src/`](../../../packages/debugger/src/) |
| `ConsoleCommandHost` implementation, tick/trace wiring | [`packages/runtime/src/`](../../../packages/runtime/src/) (`runtime-console.ts`, `driver.ts`) |
| Inspect snapshot (`createDebugInspectSnapshot`) | [`packages/object-model/src/`](../../../packages/object-model/src/) |
| Trace documents (`.babtrace` under `derived/{projectGuid}/traces/`, [containers.md](containers.md)) | [`packages/assets/src/trace.ts`](../../../packages/assets/src/trace.ts) |
| GL error trace (`installGlErrorTrace`) | [`packages/render/src/gl-error-trace.ts`](../../../packages/render/src/gl-error-trace.ts) |
| Host memory (`getHostMemoryStats`) | [`packages/vfs/src/device-memory.ts`](../../../packages/vfs/src/device-memory.ts) |
| Play overlay, console, Inspector, Stats HUD, probes, load reports | [`apps/editor/src/components/`](../../../apps/editor/src/components/), [`services/runtime-probes.ts`](../../../apps/editor/src/services/runtime-probes.ts), [`lib/scene-load-report.ts`](../../../apps/editor/src/lib/scene-load-report.ts) |

## Package boundary

- `@babylonslate/debugger` imports nothing: no React, Babylon, Capacitor or scripting. New behavior goes through `ConsoleCommandHost` plus bridge commands; rendering, audio and camera stay in render / the Play overlay.
- `@babylonslate/scripting` may import only `instrumentJsLoops` from it.
- `CommandRegistry.execute` never throws: parse/coercion failures, unknown names and stripped names return `{ success: false, output }`.

## Tiers

- `createCommandRegistry({ includeDebug })`. Core commands always register; debug implementations register only with `includeDebug: true`, but debug names are still recognized so a release build reports "not available in this build" instead of "unknown command".
- Names live in `CORE_COMMAND_NAMES` / `DEBUG_COMMAND_NAMES` ([`commands.ts`](../../../packages/debugger/src/commands.ts)). Editor Play and Preview Build include debug; release exports pass `includeDebugCommands: manifest.bundleDebugger`.
- User `BDebugCommand` classes register as core, so they ship in every export.
- `warnDebugTierConsoleCommands` warns when an `ExecuteConsoleCommand` literal names a debug command; connected pins are not flagged.

## Parser

- Whitespace tokens; quoted tokens are always values (even `"a=b"`). Multi-word names (`stat unit`, `snapshot start`) match longest first.
- Positional or `name=value` / `name:value` arguments; undeclared names fail. A `rest` parameter takes the remaining tokens.
- Coercion to string / float / int / bool / enum; bool accepts true/false/1/0/on/off/yes/no.

## Infinite loop guard

- Editor-only, per-tick iteration cap (Project Settings, default on, `DEFAULT_INFINITE_LOOP_COUNT = 1_000_000`). Play reads live settings; the count is never baked into generated JS.
- `instrumentJsLoops` rewrites `while` / `for` / `do` bodies with a check carrying asset/graph/node identity; it must not rewrite strings, comments, templates, regexes or property names.
- `runtime.infinite_loop` is session-fatal in overlay Play and Preview Build; ordinary `runtime.uncaught` is not. There is no time-based worker watchdog.

## Stats and overlay

- Worker emits `{ type: "stats" }` every `STATS_COMMAND_INTERVAL_MS` (200 ms), not per tick. `isTickOverBudget` sums script + physics against `TICK_BUDGET_MS` (8); `publishMs` is excluded.
- Chrome must not React-update at 60 Hz. Stats HUD starts collapsed; while hidden, the overlay skips HUD-only reads (render diagnostics, memory, draw calls). Test-mode attributes are polled only when `isTestModeEnabled()`.
- Draw calls come from Babylon `_drawCalls.current` after Play `scene.render()`, not `engine.drawCalls`.
- Every runtime `log` command (Log nodes, driver and captured console logs; never `print` or the `diagnostic` an error log also raises) reaches the editor Output Log once through `onRuntimeLog` / `formatRuntimeLogLine` (`[Category] Warning: message`), in Play and Preview Build, besides the overlay console.
- Output Log and live BT state live in an isolated diagnostics provider; log lines commit once per animation frame (250 ms timer while hidden). The console transcript caps at 500 rows.
- Inspector is read-only (no `setVariable`); Use Camera / Destroy Actor send the debug commands with the selected GUID. Compose it from catalog components only.
- Print HUD and Draw Debug are not debugger chrome: they apply even without `bundleDebugger`. Stats, console and inspect are debugger-bundled.
- Debug Mode (Engine Settings, off) gates copyable diagnostics. Put new copyable diagnostics behind `useDebugMode()`; copy handlers build text synchronously so iPad Safari keeps the clipboard write in the tap. Reports never include project files.

## Inspect protocol

- `{ type: "inspect" }` control → `{ type: "inspectSnapshot" }` command ([bridge.md](bridge.md)). Overlay polls ~5 Hz only while the Inspector or console is open, skips while a request is in flight (abandoned after 3 s), and drops equal snapshots in `inspect-world-store.ts`.
- Snapshot order: Game Instance, subsystems, actors parent-before-child, components. Values are JSON-safe: `BObject` → `{ guid, classId }`, cycles → `formatValue()`; recording a reference never traverses its World.

## Trace recorder

- `snapshot start` / `stop` fill a byte-budgeted `TraceRecorder` (default `DEFAULT_TRACE_BYTE_BUDGET`, 128 MiB; Engine Settings 1–256). The budget counts UTF-8 JSON bytes, not heap; oldest complete frames evict, an oversized frame stops recording. `retention` metadata is required.
- Frames record `timeDilation`, BT, audio voices, sprite clips and anim-graph state. `restoreFromTrace` order is fixed: dilation, BT, Animation Graph, sprite clips, stop missing voices, replay recorded voices with their offsets and rolls.
- Editor Stop waits at most 2 s for the trace reply. Trace opens as a read-only DockView tab; the file format is unchanged by inspection features.

## Simulation Play

- Runs the game runtime in the open Scene viewport on a separate game Scene of the shared Engine. Authoring is locked (read-only editors, central write locks); Save Game writes are dropped on Stop.
- Keep Simulation Changes (default off) applies one **Apply Simulation Changes** command from a complete capture or fails with Retry / Discard; never partial. Streamed Scenes, SceneLayers and generated resources cannot be kept.
- Trace, performance recording and Frame Capture are refused in Simulation.
- Session controls live in the global toolbar's Play island: Simulate becomes a red **Stop** (accessible name says keep or discard), with **Pause**, **Game | Edit** input and, when another document is active, **Return To Scene**. `PlayOverlay` owns pause and input mode and publishes them through `SimulationControlsProvider` (an external store, so a pause re-renders only its readers). Controls marked `data-simulation-control` act without first releasing game input. The viewport keeps only Stats / Console and, in Edit, the icon-only Move / Rotate / Scale island; authored documents show a one-line read-only strip.

## Performance and Frame Capture

- `SessionDiagnostics` admits one expensive recording or frame capture at a time; viewing results never records. Defaults: 10 s, 16 MiB accounted buffers. GPU timing is an engine-aggregate query, unaligned to frames; unsupported backends report `unavailable`.
- Preview's diagnostics entry (`player-preview-diagnostics.js`) loads only after an origin-checked handshake and is omitted from ordinary exports. Transfer failures are explicit; never substitute partial or earlier profiles.
- Per-pass GPU timing, WebGPU capture, Spector integration and pixel readbacks are not provided.
