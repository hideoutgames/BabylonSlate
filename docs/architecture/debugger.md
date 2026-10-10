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
| `suggestConsoleCompletions` / `applyConsoleCompletion` | Ranked exact/prefix/interior/subsequence command matching, then enum values, `on`/`off`, `param=`, defaults, and Play context (`scenes` / `actors` / `commands`). Named arguments resolve by name. Selection replaces the current token and preserves quoting; command hits become `name `. |
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
- Instrumented checks carry the asset, graph and node identity, so loop reports remain navigable even if a browser omits source-URL stack frames. The runtime contains the loop sentinel at startup and across tick phases; shutdown continues owner cleanup if On End loops.
- Diagnostic code `runtime.infinite_loop`. Overlay Play and Preview Build treat that code as **session-fatal**: stop immediately (same path as Stop), then the Preview session report shows the row (navigable node / ExecuteJavaScript `bodyLine`). Ordinary `runtime.uncaught` throws do not auto-close Play.
- There is no time-based worker watchdog. Cooperative `check()` is the recovery path; uninstrumented JS from a timer cannot be interrupted in-process.

See [scripting.md](scripting.md) for codegen and [exporter.md](exporter.md) for manifest fields.

## Command tiers

Every registered command has a tier. A non-debug registry **does not register debug implementations**; it still recognises debug names so `ExecuteConsoleCommand` can return a clear failure instead of `unknown command`.

| Tier | Ships | Commands |
| --- | --- | --- |
| **core** | Every build | `changescene`, `quality` and its rendering groups, `framecap`, `volume`, `quit`, `help`, plus user `BDebugCommand` classes |
| **debug** | Debugger bundled | `showfps`, `stat unit`, `stat memory`, `stat draws`, `stat threads`, `showcollision`, `debugphysics`, `showbounds`, `actorboundingbox`, `wireframe`, `pause`, `resume` (alias `unpause`), `step`, `slomo`, `freecam`, `shownav`, `shownavdebug`, `showpathfinding`, `shownavagent`, `behaviourtreedebug`, `showaudiodebug`, `dumpactors`, `inspect`, `dumplog`, `snapshot start`, `snapshot stop` |

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
| `quality` / `quality shadows` / `quality resolution` / `quality textures` / `quality geometry` / `quality water` / `quality postprocessing` / `quality lighting` | Shared `RenderingQualitySession` resolver; emits a `setScalability` transaction with session overrides. Optional arguments query effective values. Tiers are Low, Medium, High and Ultra; individual groups and all overrides can reset. `quality water <field> <value>` completes every Water setting name. |
| `volume` / `framecap` | Typed setters emit `setGlobalVolume` / a `setScalability` frame-cap patch; optional arguments query current values. |
| `quit` | `quit()` → runtime `stop` |
| `help [name]` | Core. Lists registered commands (user included) or one command’s parameters. Stripped debug names print “not available in this build” |
| `pause` / `resume` / `unpause` / `step` | `pause` / `resume` / overlay-style `resume`→`tick`→`pause`. Console pause/resume emit `{ type: "sessionPaused" }` so overlay chrome matches |
| `slomo [rate]` | `setTimeDilation` / `getTimeDilation`. `tick` uses `dt * rate` (clamp `0..8`) for script, physics, nav crowd, and BT. Trace header and frame snapshots keep recorded (undilated) `dt`; each trace frame records the tick's `timeDilation` |
| `freecam [on\|off]` | `{ type: "setFreeCam" }`. Detached fly/pan camera; simulation keeps ticking. Pointer/WASD stay off the game ring; 2D pinch zooms ortho; gamepad still forwards. Overlay Play shows a fly stick while on. |
| `lightsdebug on/off` | `setLightsDebug` controls a separate light allocation overlay, independent of Stats and off by default. |
| `showfps` / `stat *` | `{ type: "setShowFps" }` / `{ type: "setStat" }`. Opens Stats HUD; `stat` highlights unit (timings), memory, draws, or threads (main vs worker) |
| `wireframe` / `showbounds` / `actorboundingbox` / `showcollision` / `shownav` | Play-scene overlays. Collision / nav meshes use `RENDERING_GROUP.world` with depth test (not a group-0 underlay). Collision uses `PhysicsBackend.listDebugColliders()` (boxes/spheres/circles/capsules/polylines/convex hulls; body rotation of local offsets and polyline points). `actorboundingbox` calls the same `setShowBounds` host as `showbounds`. Separate from per-collider **Render In Game** world dashes. |
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

Editor Output Log lines and live behaviour-tree snapshots live in an isolated diagnostics provider. `useOutputLog` and `useLiveBtState` subscribe independently; the broad Play context exposes only stable write callbacks alongside session controls. Writers that need nothing else (the editor utility ScriptHost) use `usePlayDiagnosticsActions`, which never changes with Play state. Diagnostic updates do not rerender the session owner, its overlays, or unrelated Play consumers. Logs retain their existing bounded history, and stopping Play clears the live BT snapshot.

Play overlay chrome is a labeled top bar (**Pause** / **Resume**, **Stats**, **Console**, **Inspector**, **Stop**, plus **Step** while paused) with 44px targets. **Stats** and **Inspector** stay filled in both states; the primary outline marks their pressed state. `StatsHud` stays **collapsed** until Stats is tapped so the first Play frame reads as a game view. User and lifecycle pause requests wait for a correlated completed-boundary acknowledgement, then freeze render-owned game time and live AudioV2 voices. A requested supported redraw or Frame Capture can present without a new game tick. Console pause/resume reflects the effective boundary and cannot clear another owner's hold. Close is one tap (**Stop**). Preview Build uses the same labeled **Stop** over its player iframe (the packaged player keeps its own stats HUD, which samples completed renders per elapsed second; the shared Console button also controls Preview Build; the separate Pause / Inspector buttons remain in overlay Play). When Preview Build is on, the chrome launch control reads **Preview**.

**Debug menu** (next to Play) uses the same content-sized, minimum 14rem width as the viewport settings island so labels stay on one line. It persists overlay chrome in Engine Settings `debuggerDefaults` (same store as Preview Build). Retired `showFps` / `logLevel` keys in older saved settings are dropped on load; do not reuse those names.

Stats keeps the measured timings and **Over Budget** warning; normal ticks no longer add a **Tick OK** label.

| Group | Item | Default | Notes |
| --- | --- | --- | --- |
| Play Overlay | Stats Button, Console Button, Inspector Button | on | Hides that overlay control when off. Checkboxes stay enabled while playing, but the Play overlay is `z-50` full-screen so the toolbar Debug menu is not reachable mid-session — toggle before Play, or hide via overlay chrome. Unchecking Inspector also closes the dialog (it does not reopen when checked again). |
| Session | Pause On Play | off | Shared by Play and Simulation. After Play boot, `setPaused(true)` via `createPlayPauseGate` so `boot.play`'s `resume()` cannot undo it. `start()` / Begin Play may still run; the first tick after that waits for Resume / Step. Overlay boot also posts `{ type: "setPaused", paused: true }` after `{ type: "play" }`. |
| Session | Preview Build | off | Disabled while playing or preparing |
| Session | Play from Scene | on | Overlay Play and Preview Build seed the open scene tab; off seeds project startup. Disabled while playing or preparing. Export Game ignores this. |
| Feature Test | Run Feature Test Check… | — | Debug Mode and Feature Test projects only (all check scenes present). Opens the on-device check / benchmark ([FeatureTest doc](../development/feature-test.md#on-device-check-and-benchmark)). Disabled while playing or preparing. |

**Debug Mode** (Engine Settings → Debugger → Diagnostics, `debugMode`, off by default) is the switch for developer diagnostics that a user copies and sends. It currently:

- lists the **Feature Test** starter in Create Project; existing Feature Test projects open regardless;
- enables **Run Feature Test Check…** in the Debug menu;
- adds a copy action to the Scene Loading dialog in the editor viewport, Play and scene document loading. A failed load shows **Copy Error**, and a load still in progress shows **Copy Details** next to Stop.

The copied text (`apps/editor/src/lib/scene-load-report.ts`) names the surface, scene, phase, progress and elapsed time. It adds app version, device, browser and GPU adapter (`engineAdapterInfo`), the project rendering path/backend/quality, the error with its stack and `cause` chain, and Play log errors where present. It ends with the newest console errors and warnings. Debug Mode starts recording those (`installDiagnosticLog`, 60 entries, uncaught errors included; the original console still prints). Reports carry no project files. Copy handlers build their text synchronously so iPad Safari keeps the clipboard write inside the tap (`copyText` falls back to a selected textarea). Put future copyable diagnostics behind `useDebugMode()`, using these helpers.

**Trace Graphics Errors** (`traceGraphicsErrors`, effective only in Debug Mode) installs `installGlErrorTrace` from `@babylonslate/render`. It wraps the WebGL and WebGL2 context prototypes and calls `getError` after every call. A failing call is recorded with its arguments, the eight calls before it, and its stack. The wrapped `getError` hands the recorded codes back in order, so engine checks such as scene presentation behave exactly as untraced. Copy Error then lists the failing calls. Every call adds a synchronous query, so it is off by default and meant only for collecting a report.

In-app diagnostics read the session through `apps/editor/src/services/runtime-probes.ts`, not the test-mode globals. The Play overlay registers a `PlayProbe`: loading phase, tick, runtime fps, a render/resource snapshot, error and warning logs, console commands and Stop. Each Scene viewport registers a `ViewportProbe` (ready, failed, phase) under its document id. `PlayProvider` publishes every closing `PlaySessionResult`. While `holdAutomatedSessionReporting()` is held, the Preview Session Report dialog stays closed so an automated run can record its entries.

`showcollision` / `showbounds` / `actorboundingbox` / `wireframe` / `shownav` / `showaudiodebug` apply from the console (not Debug-menu items). Audio debug is a DOM overlay that keeps drawing while Pause freezes the sim.

Play overlay **extends** the existing FPS / `scriptMs` / `physicsMs` / `publishMs` strip:

- `DebugConsole` is a flat, full-width bottom Sheet (58dvh, capped at 38rem) over the running view. The compact header has **Console**, **Clear**, **Copy Transcript**, and Close; coarse pointers get 44px controls and an accessory key row. The selectable monospaced transcript combines timestamp-ordered command results with session logs, prints, warnings, and errors, capped at 500 rows. Both streams are already in time order, so the newest rows come from a tail merge (commands ahead of logs at equal timestamps) rather than a sort per log; log rows keep their identity and rows are memoized, so stats, inspect polls, and typing do not re-render the transcript. New output follows the bottom unless the user scrolls back. A scrollable list above the input shows command names, argument types, and descriptions; ArrowUp/Down selects, Tab or tap completes, and Enter runs. History remains available without suggestions. Keyboard opening focuses input; touch opening preserves the keyboard-free transcript. Play keeps ticking. `logs` accepts `DebugConsoleLogEntry` values (`id`, `timestamp`, `severity`, `message`); IDs increase throughout the session so Clear hides existing messages while future messages remain visible. Both hosts feed `logs` through `useDebugConsoleLogs` (`apps/editor/src/lib`): each line gets its id and timestamp on arrival, and a burst commits once per animation frame (a 250 ms timer flushes while frames are paused in a hidden tab), keeping the newest 500 lines. A line that arrived in the same frame as a Clear click shows after it. Bare `inspect` uses the Inspector selection when one is known.
- Read-only **Inspector** overlay: same CatalogDialog footprint (`h-[min(90vh,52rem)]` × `w-[min(96vw,64rem)]`). Left: `SearchInput` + `TreeView` (no reparent) of Game Instance, subsystems (GameSubsystems then SceneSubsystems, each with its base glyph from `ancestry`), actors (`parentId` order), and components. Right: three titled `PropertyGrid`s (`orientation="horizontal"`, `readOnly`) for **Identity**, **Transform**, and **Variables**. All sections share stable label/value columns and readable contrast. Narrow property containers stack labels above controls; phones stack the searchable tree above the details with independent scrolling. Rows are **disabled** catalog controls (checkbox / `NumericDragField` / vector XYZ(W) / `ColorField` / `PickerIdentity` / text); there is no `setVariable`. Types come from snapshot `variableTypes` (ClassRegistry) when known, otherwise inferred. Enums without member lists render as disabled text. Selection is kept across snapshots by guid. Compose from catalog only; Play overlay chrome itself stays not-kit.
- ~5 Hz `StatsHud`: tick-budget flag (`isTickOverBudget`), accounted resource-cache texture bytes, accounted Scene GLB geometry bytes (**Geo High** at `GEOMETRY_BYTE_CEILING`), mesh/texture counts, last-frame draw calls (Babylon `_drawCalls.current` snapshotted after Play `scene.render()` — not `engine.drawCalls`, which is unset), bridge messages/s. The worker **emits** `{ type: "stats" }` at `STATS_COMMAND_INTERVAL_MS` (200 ms, ~5 Hz) — it is not a per-tick command. The **snapshot header** also carries the `scriptMs` / `physicsMs` / `tickIndex` of the last publishing tick, written once per `advance()` burst and on every bare `tick()` or explicit publish. Overlay Play and the packaged player `setState` / HUD text from those ~5 Hz `stats` commands plus a **1 Hz** rendered-FPS sample; they must not React-update chrome at 60 Hz. `publishMs` (**publish** in the strip, testid `play-publish-ms`) is the most recent snapshot publish — per-tick SceneLayer overlay layout and removal pass, plus world composition and buffer write once per `advance()` burst — and is not part of the `isTickOverBudget` script + physics sum. Worker `stats` commands own `scriptMs` / `physicsMs` / `publishMs`; the main-thread pump samples the Play scheduler for actual rendered FPS; neither source overwrites the other. Editor viewport FPS is not shown on the Debug menu (Always Render is always on). Testids `stats-hud` and `play-fps` stay mounted while collapsed so QA can poll attributes after opening Stats.
- Host memory: `getHostMemoryStats()` in `@babylonslate/vfs` merges whatever the platform exposes. Chromium/Electron report the real JS heap (`performance.memory` → `js`); iOS bridges `BabylonSlateMemory` to app-process `phys_footprint` (`app`), bytes before jetsam would kill the app (`headroom`, `os_proc_available_memory`), and device-wide free+inactive+purgeable (`free`, `host_statistics64`). WKWebView renders in a separate WebContent process whose memory is not exposed to JS or the host app, so `app`/`headroom`/`free` are never a full page-RAM figure — labels distinguish them from engine-accounted `mem`/`geo`. The editor overlay polls it on the existing 200 ms stats tick; the packaged player polls at 1 Hz and merges it into `PlayerHudStats`.

Output Log, keyed Print, and the Preview session report are unchanged. Print HUD and Draw Debug wireframes are **not** debugger chrome: overlay Play and the packed player apply `{ type: "print" }` / `{ type: "debugDraw" }` even when `bundleDebugger` is false. Stats HUD, console, and inspect stay debugger-bundled. Print / Print String / Draw Debug still default to Inspector **Development Only**, so a release compile omits them unless the author unchecks the flag.

## Simulation Play

Simulation hosts the normal game runtime in the open world Scene Viewport, using
its prepared in-memory Scene and a separate game Scene on the shared Engine.
Class/asset previews are not Simulation targets, and Play From Scene/startup
preferences do not select a different root. Public launch qualification is tracked
in [engineplan §9.8](../engineplan.md); the contracts here are not completed browser or device acceptance.

Start in **Game Input**. **Edit** releases game input and enables runtime selection,
the existing Inspector/Outliner and transform tools; **Return To Game** restores
routing after a fresh input transition. Entering Edit does not pause gameplay.
**Pause** waits for a completed runtime boundary; editor camera and supported
render-only redraws remain available without advancing game time. Gameplay can
write a value again on its next tick, so Pause is the reliable placement/inspection
mode. User pause survives background/loading holds, and Resume does not accumulate
the paused interval. Stop remains available outside hidden document tabs.

| Live edit | Current owner/capability |
| --- | --- |
| Actor/local component pose | Validated transform/physics boundary; teleports preserve velocity and reset interpolation; unsafe owners report restart required |
| Exposed Class scalar/vector/reference values | Reflected typed setter when supported; Maps/structures and unsupported types remain inspection-only |
| Existing Mesh shadows/material assignment, camera/light/outline, rigid body/collider/navigation fields, audio volume | Explicit runtime descriptors; colliders use their owner rebuild boundary; other asset replacements/rebuilds may require restart |
| Surface float/color/texture parameters | Session-owned `MaterialObject` parameters with staged asset preparation; no shared source-material writes |
| IDs, computed/native fields, actor/component structure, source assets and logic | Read-only; gameplay may still spawn/delete runtime objects |

Selection uses generation, scene-instance identity, runtime GUID and lifetime
token. Destroyed targets become unavailable rather than selecting a recycled slot.
Only visible consumers poll, at most 5 Hz, with bounded value pages and no
concurrent selection read. Continuous writes coalesce per target; focused drafts
remain separate from acknowledged values. See [the bridge](bridge.md) for bounds.

**Engine Settings → Debugger → Simulation → Keep Simulation Changes** defaults
off and applies to the next launch. The viewport shows the effective session
value. Off discards gameplay and deliberate live edits without a document command,
dirty change or loss of earlier history. On captures the complete final persistable
root scene before cleanup and applies one **Apply Simulation Changes** command.
Undo restores the baseline; Redo restores the captured document without rerunning
Begin Play. Save remains explicit. Failure offers **Retry** or **Discard** and
never applies a partial scene or a command that cannot fit its inverse in history.

Keep cannot represent independent streamed Scenes, SceneLayers, scene transitions
or native/generated resources without an authored representation. Known cases
are labeled before launch; runtime topology changes are latched when they occur,
even if later removed. Material owners or typed values without a lossless capture
codec fail with their exact reason. Simulation can continue with discard.

Logic, Class, prefab and asset editors show **Read-only During Simulation Play**;
navigation, copying and source-linked errors remain useful. Authoring commands,
global Undo/Redo, file writes and engine-managed utilities obey central locks.
Already-admitted safe saves finish before the baseline is taken; later authoring
saves defer. Save Game reads see selected Preview data through a copy-on-write
overlay; writes/deletes, including wipe-on-start, are dropped on Stop even with
Keep on. Arbitrary custom JavaScript timers and external network/file effects are
outside this scene rollback and cooperative game-clock boundary.

Performance recording, Frame Capture and `snapshot start` are rejected in
Simulation with **Use Play Or Preview Build**. Existing basic Stats, source-linked
errors and bounded inspection remain available. Selected-graph observation, watched
pin activity, node breakpoints/stepping, shader readbacks and advanced Spector
capture are not delivered; JavaScript debugging remains in browser developer tools.

## Live Play debugging

- Both Play modes feed Log, Print, diagnostics, native console messages, uncaught window errors, and unhandled rejections into a capped console transcript, coalesced per frame so a script printing every tick, or many lines per tick, re-renders the overlay at most once per frame. The Print HUD keeps its own state in a `PrintHud` leaf and applies each print at once (a duration-0 print still shows for one frame) without re-rendering the Play overlay. Native capture is removed when the session ends. `RuntimeDriver.reportLog` records native script messages in the runtime ring as well as forwarding them, so `dumplog` includes them.
- Preview Build uses source-and-origin-checked iframe requests with correlated command replies, request timeouts, and pending-request cleanup. Its console includes the packed user commands and live actor completion context. While open, it requests context immediately and every 500 ms using `PREVIEW_CONSOLE_CONTEXT_MESSAGE`; the player coalesces in-flight `inspect` requests and returns actor-only catalog updates without replacing command or scene metadata.
- `debugphysics` shares `showcollision`; `shownavdebug` shares `shownav`. `showpathfinding` and `shownavagent` consume actual crowd telemetry at 5 Hz, with immediate updates when enabled. Shapes, paths, and labels are disposable runtime geometry.
- `behaviourtreedebug on` opens the live inspector with `Actor Name (Tree Name)` choices. It shows active nodes, last results, child order, decorators/services, execution stack, and blackboard values. Full snapshots at 5 Hz replace old state; removed actors and stopped trees disappear. Closing the modal sends `behaviourtreedebug off`.
- Console pause survives app background/foreground transitions in both modes. `showfps off` stays hidden after new samples; `stat <name> off` removes its highlight. Shared-material wireframe state is restored when disabled.

## Inspect protocol

Snapshot nodes include their ClassRegistry `ancestry`, most-specific class first. The Play Inspector uses it for class glyphs, so attached custom ActorComponents keep the same icon and Class color as their assets, including nested subclasses.

Headless snapshot `createDebugInspectSnapshot(world)` in `@babylonslate/object-model` (separate type from harness `createWorldSnapshot` goldens). Nodes: Game Instance if any, then subsystems (kind `"subsystem"`, `parentId: null`; GameSubsystems, then the main Scene's SceneSubsystems), then actors parent-before-child (`parentId` variable), then each actor’s components as children. The bridge `inspectSnapshot` node kind union includes `"subsystem"`. Label is the `name` variable, else `classId`. Values are JSON-safe: primitives stay; `BObject` → `{ guid, classId }`; circular / non-cloneable → `formatValue()`. Optional `variableTypes` maps variable keys to ClassRegistry types (`inheritedVariables`) for keys that exist; keys without a class def stay untyped so the editor can infer.

Bridge: `{ type: "inspect" }` control → `{ type: "inspectSnapshot", snapshot }` command (same waiter pattern as `console` / `consoleResult`; worker `applyInspectControl`). Overlay Play polls **while the inspector dialog or the console is open**, ~5 Hz, and skips a tick when a previous inspect RPC is still in flight (actor name completions stay live). In-process Play calls `runtime.inspectWorld()` directly. Property values remain read-only (no `setVariable` from the UI). Selected actors expose session-only **Destroy Actor**, plus **Use Camera** when they contain a CameraComponent; both use the debug console transport and report their result. Identity labels use Title Case acronyms (**GUID**). Transform uses XYZ (position/scale) and XYZW (rotation quaternion). Object refs show class identity (`PickerIdentity`: classId + guid), not `Class(guid)` text.

## Trace recorder

Tick logs, including script error messages, are collected using the completed simulation frame's ID before the published snapshot advances to its next ID. Each recorded frame contains its own tick's messages.

Engine Settings → **Debugger → Trace Memory Budget (MiB)** sets the budget for new Play sessions in both Worker and in-process modes, and for Preview Build sessions. It defaults to **128 MiB** (previously 2 MiB), accepts **1–256 MiB**, and is stored locally per user. Preview passes it through its temporary session handoff; exported game files do not contain the preference. Runtime callers can pass `traceByteBudget` in bytes; omitted values use the same default. Recording allocates data as frames arrive, rather than reserving the whole budget up front.

The limit accounts for the payload's UTF-8 JSON bytes, including snapshots, events, and reserved terminal metadata; it is not a JavaScript heap limit. Oldest complete frames are discarded when the recording fills up. An incoming frame that cannot fit by itself stops recording before changing the retained frames; no truncated or oversized frame is retained. The runtime immediately publishes the available trace and a warning while gameplay continues. Optional `retention` metadata records the configured `byteBudget`, `droppedFrames` (evictions plus a rejected oversized frame), `complete` (no omitted frames), and `stopReason` (`requested`, `session-ended`, or `oversized-frame`). Older `.babtrace` documents remain readable without this metadata. Retained duration depends on scene size and tick rate. Each incoming frame is measured once, avoiding repeated serialization of the entire history as the budget grows.

World snapshot variables use the same JSON-safe values as Inspect: live object references retain `{ guid, classId }`, Maps retain their entries, and other circular/non-cloneable values use their formatted representation. Recording a reference never traverses its live World or owner.

In normal Play/Preview, `snapshot start` / `snapshot stop` fill a `TraceRecorder` (stats, logs, prints, world snapshots, input, RNG seed) with a byte budget. Stop emits a `trace` command. Runtime `stop()` also finalizes an in-flight recording. Editor Stop waits at most two seconds for the Worker trace reply before terminating the session, so an unavailable Worker cannot trap the user in Play or Scene Loading; a payload that has already arrived is retained. `@babylonslate/assets` writes the payload as a `Trace` document under app-private derived data (`derived/{projectGuid}/traces/*.babtrace`, same root as thumbnails/journal — not `assets/` / Content Browser). Overlay Play does not show a playback card. When Play ends with a payload, the editor opens a read-only DockView **Trace** tab: Timeline graphs (script/physics ms vs tick) + scrubber, Snapshot of the selected frame, and Log filtered to the selected and preceding 29 recorded frames (logs **and** prints). Headless replay: seed + ticks **or** `replayTracePayload`, which feeds each frame’s `inputEvents` and `timeDilation` then `tick()` → same `stringifyWorldSnapshot`.

Trace restore (`RuntimeDriver.restoreFromTrace(frame)`) resumes a frame on the live World so the replay sounds and looks like the recorded run:

- Each frame records `timeDilation`: the dilation its tick's step used (step = undilated `dt` × dilation). A `slomo` change made during a tick takes effect from the next tick and first appears on that tick's frame. Absent reads as `1`. Replay sets it before each tick; restore applies it first (`RuntimeDriver.setTimeDilation`, clamp `0..8`).
- Each frame records `bt` (see [behaviour-tree.md](behaviour-tree.md)), `audio` (`voices` in start order — `voiceId`, `assetGuid`, play-call `volume` after `setVoiceGain`, optional `loop` / `emitterActorGuid`, `elapsedSeconds` — plus `nextScriptVoice`), `sprites` (each actor's Sprite Animation clip: `actorGuid`, `stateId`, `assetGuid`, `clipName`, `normalisedTime`) and `animGraphs` (per-component evaluation state, graph guid and pending Jump To State).
- Voice age counts undilated fixed steps (audio plays in real time; `slomo` does not slow it). A voice leaves the record on `stopSound` (including an Audio component's Stop), `audioVoiceEnded`, or an active Scene change. A Play Sound without an asset starts no voice and is not recorded.
- Restore order is fixed: time dilation; BT evaluation and ownership; Animation Graph evaluation (restored graphs do not re-run On Initialize Animation); each live actor's sprite clip in World order (an `animState` at the recorded frame, or the collider clip cleared when the frame has none); `stopSound` for live voices the frame lacks (start order); `playSound` with `startOffsetSeconds` for each recorded voice (recorded order). Actors match by guid and BT rows by render slot.
- `restoreBtFromTrace(states)` still restores only BT evaluation and its Play Animation / Play Sound ownership.
- Not reproduced: an Audio asset's weighted clip choice and random pitch, which the host picks again.

## Export settings (P14)

Project Settings **Export Game** preset: **Bundle Debugger** (off for release). Release export compiles with `compileGraphDocuments` and `stripDevelopmentOnly` (Print / Print String / Draw Debug default on; Inspector **Development Only** nodes are omitted). A non-debug player still links `@babylonslate/debugger` **core** commands; debug-tier implementations are not registered (`includeDebug: false`). Opted-in Print and Draw Debug still render. **Preview Build** always bundles the debugger and keeps Development Only nodes. Draw-call ceilings (`DRAW_CALL_WARN_CEILING`) and geometry (`GEOMETRY_BYTE_CEILING`) surface as HUD warnings. See [exporter.md](exporter.md).

### Trace Inspection

- **Timeline:** orange marks the exact selected frame, including over-budget ticks. Script/Physics stacks share a spike-preserving scale and a budget line; warning and recorded-event markers remain separate. Long ranges show each group's slowest tick with bounded bar counts. Zoom follows selection; Previous/Next Frame, Previous/Next Over Budget, the keyboard scrubber and integer Frame Index remain exact. Readouts separate retained frame index from recorded tick. Fixed Delta is undilated simulation configuration, not wall-clock duration. The header shows completeness, the configured serialized-data budget, dropped frames and the stop reason, including when an oversized first frame leaves no retained frames. Legacy traces report that retention details are unavailable.
- **Snapshot:** a searchable, windowed TreeView groups Game Instance, Subsystems (expanded by default, labelled by class without a GUID prefix), Actors, Local Transform, Variables and Components, followed by recorded Input Events and Behaviour Trees. GUID/property-path identities preserve selection and expansion while scrubbing; names prefer recorded variables. Current scene state is never substituted. Arrays/objects expand recursively, null/empty values stay distinct, rotations retain quaternion X/Y/Z/W, and selected values expose exact JSON and copyable paths. Search reveals ancestors without replacing expansion choices. Values beyond the tree's 64-level display guard remain available in the value area and Raw Snapshot. Missing/legacy malformed snapshots have explicit states and retain raw text.
- **Changes:** compares world snapshots with the previous retained frame, matching subsystems/actors/components by GUID and showing Added, Removed and Changed values. Entity array reordering alone is not a change; tick/delta metadata is excluded. Select a row for full before/after values. The first frame or missing/unreadable snapshots cannot be compared.
- **Log:** includes the selected frame and up to 29 preceding recorded frames (30 total), with an explicit tick range. Search covers message, category, severity, print key and tick; severity filtering distinguishes logs and prints. Selecting a row navigates to its frame and reveals the full selectable/copyable message. Current-tick rows have an orange start edge.
- Each Trace document owns inspection/search/zoom state, including when a dock closes and reopens. Snapshot supports arrows, Home/End and Enter/Space. Touch targets adapt without enlarging desktop controls. The file format is unchanged; input details and behaviour-tree mappings remain limited to fields actually recorded.

## Explicit performance collection

`SessionDiagnostics` coordinates profile and frame requests through correlated
runtime admission. The runtime excludes overlapping trace/profile/frame work and
refuses recording in Simulation. Performance recordings default to 10 seconds
and 16 MiB of accounted numeric buffers and metadata; this is not a browser heap
or JSON export limit. Deadlines also run while the game is paused. Stop drains the
accepted runtime tick chunk before finalizing; a failed admission or lost chunk
is reported instead of substituting HUD samples.

Completed-frame intervals come from the actual coherent canvas-copy boundary,
including asynchronous RTT presentation. Held attempts never enter that
population. Preparation, submission and copy are main-thread wall measurements;
driver waits can contribute, and asynchronous copy can overlap submission. Tick
script, physics, publish and other measured phases have their own runtime clock
and population. Neither clock is subtracted from the other. Summaries report
count, median, nearest-rank p95/p99, maximum and over-budget count with missing
values excluded. The first completed frame has no interval. Loading flags,
dimensions, resolution scale, frame/tick IDs and scene generations remain in
individual rows. With **GPU Timing** on, a recording also leases Babylon's engine
GPU frame-time query (shared with the renderer's Stats lease) and keeps a third
`gpu` population of fresh, valid query results: delivery time, duration, query
sequence and coalesced count, labelled `engine-aggregate`. It is not aligned to
frames or passes. WebGPU, missing timer-query support or a lost context report
`unavailable` with a reason; a recording without the option reports `disabled`.

The packaged Preview player collects the same streams inside its own runtime.
Its diagnostics entry is loaded only after an explicit, source/origin-checked
handshake. Requests and bounded transferable chunks also match client/session
identities; replacing the iframe retires the client. Player source/build identity
is unavailable when the packaged artifact has no embedded identity, rather than
borrowing the editor's identity. The independently built
`player-preview-diagnostics.js` entry is omitted from ordinary exported games,
including games that bundle existing debug commands. The player keeps its
existing single-file runtime build.

Preview's labeled **Profiler** and **Capture Frame** controls use the editor's
shared diagnostic results surface. Opening the surface does not record. Stop
settles an already-requested recording start and receives its final bounded
transfer before detaching the iframe; a Preview with no diagnostic request does
not load the diagnostics entry merely to stop. Transfer failures leave an
explicit error and never substitute a partial profile.

Preview's Profiler, Console and behaviour-tree surfaces share the exclusive DOM
input owner. Opening one neutralizes keyboard, pointer, touch, virtual-stick and
gamepad state; returning requires a fresh input transition. Ownership requests
never start recording. Preview console pause reads the actual correlated input
reset/pause boundary, and lifecycle pause owns a separate reason. Frame Capture
waits for that acknowledgement before requesting a render-only frame; failure
keeps the hold and displays the error.


### Profiler and Frame Debugger use

Open **Profiler** from Debug or session chrome, then explicitly start a Performance
recording or **Capture Frame**. Viewing old results does not collect new data.
Summary, paged Timeline and selected-sample details share one lazy diagnostic
surface with Copy/Export and a visible Stop Session action. One recent result is
retained; a finite recording stops on its duration, data budget or session end and
reports the reason/dropped records. Only one expensive recording or frame capture
may be active; full-world Trace remains a separate explicit workflow.

Engine Settings → Debugger keeps these preferences local and searchable:

| Setting | Default/range | Effective use |
| --- | --- | --- |
| Recording Duration | 10 seconds / 1–60 | Next explicit Play/Preview recording |
| Profile Retained Data Budget | 16 MiB / 4–64, Advanced | Timing buffers/metadata; separate from Trace and browser heap |
| GPU Timing | off | Next recording also collects engine-aggregate GPU query results where WebGL2 timer queries exist |
| Trace Memory Budget | 128 MiB / 1–256 | Existing saved values preserved; serialized-data retention, allocated as records arrive |

Capture Frame waits for the next coherent completed game presentation, with a
finite timeout; held/loading images cannot become successful captures. Paused
capture requests a supported render-only presentation without a physics tick.
Reports distinguish actual executed stages from public FrameGraph task/pass
metadata, include graph generation and exposed resource dimensions/formats/samples,
and report measured draw-call deltas and inclusive submission wall times. Native
rendering reports its owned stages rather than an empty graph. Missing attribution
or backend detail is labeled unavailable; nested stage times must not be added.

No target thumbnails, pixel readbacks, allocation-optimization changes, pass enable
toggles or replay are introduced. Actor/material links appear only when their
render owner supplies the identity; batching is not guessed. Per-pass GPU timing,
WebGPU command capture and Spector integration remain unavailable.
The CPU recording overhead, repeated-release counts, sustained route and real
browser/device matrix remain qualification gates in [engineplan §9.8](../engineplan.md).

Compiler diagnostics and the Play error badge reset when the active document changes. Late results from an earlier document visit cannot repopulate the current document’s errors or focus. Explicit Compiler Results, blocked Play, project search, and session-report navigation carries its node and script body line into the destination document without carrying the previous document’s error badge.
