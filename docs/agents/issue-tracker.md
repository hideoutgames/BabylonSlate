# Agent issue tracker

Workflow for autonomous agents and the code-review skill.

## Spec source order

1. GitHub issue / PR reference in commit messages — fetch via `gh issue view` or PR description.
2. Path passed by the user.
3. `docs/engineplan.md` Appendix A checklist item (e.g. `p0-foundation`).
4. Feature doc under `docs/`.

## Recording review findings

When the code-review skill reports Standards or Spec findings:

1. Add a row to the table below (or fix in the same session).
2. Link the PR branch and checklist id.
3. Mark resolved when fixed.

| Date | Branch | Checklist / issue | Axis | Finding | Status |
| --- | --- | --- | --- | --- | --- |
| 2026-08-11 | cursor/p3-object-model-e177 / cursor/p3-spawn-deferral-e177 | p3-object-model | Standards | `spawnActorNow` ignored mid-tick and committed immediately (doc requires deferral) | Resolved |
| 2026-08-11 | cursor/p3-object-model-e177 / cursor/p3-spawn-deferral-e177 | p3-object-model | Standards | Doc listed `TickScheduler`; exports are `TickClock` / `TICK_PHASES` | Resolved |
| 2026-08-11 | cursor/p3-object-model-e177 | p3-object-model / p3-harness | Spec | Acceptance (120-tick golden) met; remaining notes are intentional P3 scope (registry not wired into spawn, World-owned spawn API, flat components, VFS fixture decoupled from scenario) | Accepted |
| 2026-08-11 | cursor/p4-bridge-play-2497 | p4-play-overlay | Spec | Play used in-process only; Worker host deferred | Resolved |
| 2026-08-11 | cursor/p4-harden-2497 | p4-play-overlay | Spec | Play prefers `worker-entry` via `createGameWorkerHost`; falls back in-process with warning; texture leak + runtimeMode logged on stop | Resolved |
| 2026-08-11 | cursor/p4-harden-2497 | p4-resource-cache | Spec | `ResourceCache.getTexture` + sampling-key path; idle zero-frame + encode pause reason-set; tap picking | Resolved |
| 2026-08-11 | cursor/p4-bridge-play-2497 | p4-render-sync | Standards | Per-frame ActorSlot/Set alloc in snapshot sync — fixed to reuse scratch | Resolved |
| 2026-08-11 | cursor/p4-bridge-play-2497 | p4-bridge | Spec | Multi-transport parity harness now exercises SAB + transferable against in-process snapshot payload | Resolved |
| 2026-08-11 | cursor/p4-bridge-play-2497 | p4-preview-report | Spec | Navigate focuses fixture node id (full graph/bodyLine navigation waits on P5 compiler) | Accepted |
| 2026-08-11 | cursor/p4-bridge-play-2497 | p4-input-capture | Spec | Synthetic encode/decode tested; full harness replay-through-runtime deferred with action mappings to P6 | Resolved (P6 `p6-input-mappings`) |
| 2026-08-12 | cursor/p4-implementation-review-79b7 | p4-preview-report | Spec | Worker-mode Play never populated the session report (`play-session.ts` `onCommand` used an ad hoc type missing `code`/`assetGuid`/`nodeId`/`stack`, so real worker `diagnostic` commands were logged but never aggregated — only the injected fixture-throw path faked report entries) | Resolved |
| 2026-08-12 | cursor/p4-implementation-review-79b7 | p4-render-on-demand | Standards | `create-engine.ts` fed the hardware-scaling valve the wall-clock gap since the last rendered frame instead of render cost; render-on-demand's idle gaps (by design, seconds) would read as a catastrophic frame and drop resolution quality for no reason | Resolved |
| 2026-08-12 | cursor/p4-implementation-review-79b7 | p4-bridge / p4-runtime-worker | Standards | `worker-entry.ts` allocated a fresh Float32Array/ArrayBuffer every rAF frame for the snapshot transfer instead of using `TransferablePingPong`; wired a `recycleSnapshot` host message so the host hands the consumed buffer back once its synchronous consumer is done, eliminating the per-frame allocation | Resolved |
| 2026-08-12 | cursor/p4-implementation-review-79b7 | p4-bridge | Spec | True zero-copy SAB (main thread reading a shared buffer directly, no per-frame `postMessage`) is not wired into the live game-worker path — `worker-entry.ts` always uses the transferable-copy pattern regardless of `crossOriginIsolated`; primitives (`SeqLockSnapshotPair`) are implemented and unit-tested but unused end-to-end. Transferables are the CI-mandatory, always-correct path per `docs/architecture/testing.md`, so this is a performance follow-up, not a correctness gap | Accepted |
| 2026-08-12 | cursor/p7-play-scene-load-7208 | p7-play-scene-load / p8-command-system | Standards | `CODING_STANDARDS.md` package list omitted `debugger` after the new package landed | Resolved |
| 2026-08-12 | cursor/p7-play-scene-load-7208 | p7-play-scene-load / p8-command-system | Standards | Two Appendix A slices in one PR (`p7-play-scene-load` then `p8-command-system`); assigned plan required both | Accepted |
| 2026-08-12 | cursor/p7-play-scene-load-7208 | p7-play-scene-load | Spec | E2E asserts Play spawn guid `actor-1` rather than reading the snapshot buffer; spawn is how snapshot slots are assigned | Accepted |
| 2026-08-12 | cursor/p7-play-scene-load-7208 | p8-command-system | Spec | `changescene` still only fires `GameInstance.onSceneLoaded`; core quality/volume/framecap setters emit console logs until the HUD/renderer consume them | Resolved (scene library load in foundation wave; quality setters still log) |
| 2026-08-13 | cursor/foundation-harden-e9a2 | pre-P11 foundation | Spec | Play/scripting contracts that catalogs marked Done were host stubs (ScriptHost input, Delay wall-clock, closed-tab prefab/scene, GameInstance picker, untextured sprites, ignored GLB, HUD button no-ops, silent `playSound`) | Resolved |
| 2026-08-13 | cursor/p9-acceptance-gaps-8c7a | p9-fonts / p9-ui-system | Spec | Play HUD did not `FontRegistry.registerAll` project Font assets; Font e2e uses New Asset (no `source` bytes) | Resolved (`cursor/babylon-native-ui-138e` registers `source` bytes on Play + designer ADT) |
| 2026-08-13 | cursor/p9-acceptance-gaps-8c7a | p9-ui-anchoring | Spec | Play e2e asserts `data-preset` / `data-safe-top` per project viewport, not widget inset deltas; `previewRect` tables cover pin / percent / stretch-padding / safe-area | Accepted |
| 2026-08-13 | cursor/p9-acceptance-gaps-8c7a | p9-ui-system | Standards | Play HUD `borderRadius: 999` (stick) pre-existed; widget style passthrough still uses a numeric fallback | Accepted |
| 2026-08-13 | cursor/startup-scene-play-cleanup-ebf7 | p14-export / Play | Spec | Unused `collectPlayStartupScene` still loaded `scenes[0]` / `main.scene.babasset` when no scene tab was open | Resolved |

## PR checklist

- [ ] Spec identified (engineplan slice or issue).
- [ ] `pnpm verify` green.
- [ ] `docs/` updated if behaviour or APIs changed.
- [ ] Code-review skill run against merge-base; findings recorded here or fixed.
- [ ] Tests added/updated for new behaviour.

## Parallel agents

Operating model (engineplan §16.1):

- **One slice, one PR, one owner** per package set. Two agents never hold the same package at once — this is why the package boundaries are drawn narrowly.
- **API before implementation.** A slice others depend on lands its types and a failing test suite first, so downstream agents can start against a stable signature instead of guessing.
- **Design notes for shared surfaces.** Shared surfaces (bridge protocol, container formats) get a design note in `docs/architecture/` before parallel implementation starts.

## Subagent model preference

When a parent agent launches Task / subagents and chooses a model:

- Prefer **Composer 2.5** (`composer-2.5`) or **Grok 4.6** at any effort level (e.g. high / extra-high). These are equal preferred options.
- Do **not** use Fast variants: `composer-2.5-fast`, `cursor-grok-4.6-high-fast`, or any other `*-fast` slug for these families.
- Soft preference only — do not hard-require an explicit model on every Task call. Omitting `model` (inherit parent) is fine.
- Honor an explicit user or task request for another model.
- See [.cursor/rules/agent-workflow.mdc](../../.cursor/rules/agent-workflow.mdc) (Subagent models).

## P1 slice ownership

| Slice | Checklist | Packages | Depends on |
| --- | --- | --- | --- |
| Design notes | — | `docs/architecture/` | — |
| Binary VFS | `p1-vfs` | `core`, `vfs` | Design notes |
| App settings | `p1-app-settings` | `vfs` | Design notes |
| Containers + migration | `p1-babasset`, `p1-schema-migration` | `assets`, `test-kit` | `p1-vfs` |
| Project codec | `p1-babproject` | `assets` | babasset |
| Homepage | `p1-homepage` | `apps/editor`, thin `ui`/`editor-kit` | vfs + settings + babproject |

Design notes: [containers.md](../architecture/containers.md), [vfs.md](../architecture/vfs.md).

## P2 slice ownership

| Slice | Checklist | Packages | Depends on |
| --- | --- | --- | --- |
| Design notes | — | `docs/architecture/` | — |
| Registry + importers | `p2-registry` | `assets`, `core`, `test-kit` | Design notes |
| Edit / undo | `p2-edit-undo` | `edit`, `apps/editor`, `graph-ui` | Design notes |
| Texture pipeline | `p2-texture-compression` | `assets`, `render`, `test-kit`, `apps/editor/public` | Registry API |
| Content Browser | `p2-content-browser` | `apps/editor`, `editor-kit`, `ui` | Registry |
| Destructive + journal | `p2-destructive-guard` | `assets`, `edit`, `apps/editor`, `ui` | Registry + edit + CB |

Design notes: [command-layer.md](../architecture/command-layer.md), [asset-registry.md](../architecture/asset-registry.md).

## P3 slice ownership

| Slice | Checklist | Packages | Depends on |
| --- | --- | --- | --- |
| Design notes | — | `docs/architecture/` | — |
| Core foundations | — | `core` | Design notes |
| Object model | `p3-object-model` | `object-model`, `core` | Design notes + core foundations |
| Deterministic harness | `p3-harness` | `test-kit`, `object-model`, `vfs` | Object model |

Design notes: [object-model.md](../architecture/object-model.md).

## P4 slice ownership

| Slice | Checklist | Packages | Depends on |
| --- | --- | --- | --- |
| Design notes | — | `docs/architecture/bridge.md`, `render.md` | — |
| Bridge | `p4-bridge` | `bridge`, `apps/editor` (COI) | Design notes |
| Runtime | `p4-runtime-worker` | `runtime`, `test-kit` | Bridge |
| Input | `p4-input-capture` | `input`, `apps/editor` | Bridge |
| Render | `p4-render-sync`, `p4-render-on-demand`, `p4-resource-cache` | `render` | Bridge |
| Play + report | `p4-play-overlay`, `p4-preview-report` | `apps/editor`, `runtime` | Runtime + Render + Input |

Design notes: [bridge.md](../architecture/bridge.md), [render.md](../architecture/render.md).

## P5 slice ownership

| Slice | Checklist | Packages | Depends on |
| --- | --- | --- | --- |
| Design notes | — | `docs/architecture/scripting.md` | P4 complete |
| Scripting core | `p5-scripting-core` | `scripting`, `core` (IR/diagnostic types as needed), ESLint boundaries | Design notes |
| Wildcard + formatValue | `p5-wildcard` | `scripting`, `core` | Scripting core types API |
| Node catalog | `p5-node-catalog` | `scripting-nodes` (one agent per category) | Scripting core registry + codegen API |
| ExecuteJavaScript | `p5-execute-js` | `scripting-nodes`, `editor-kit`, `apps/editor` | Core + parameter-list editor |
| Log / Print | `p5-log-print` | `scripting-nodes`, `runtime`, `core` (`formatValue`), thin editor HUD hook | Core + wildcard |
| Graph UI shell | `p5-graph-ui` | `graph-ui`, `ui` (type tokens), `apps/editor` | IR serialisation stable |
| Type assets | `p5-types` | `assets` (schemas), `object-model` (FunctionLibrary base), `apps/editor`, `editor-kit` | Pin type system |
| Validation UX | `p5-graph-validation` | `apps/editor`, `graph-ui`, `scripting` fixtures, Content Browser overlay | Validator + Compiler Results UI |

Design notes: [scripting.md](../architecture/scripting.md).

**Parallelism:** after `p5-scripting-core` lands its types and a failing/passing golden harness, catalog categories may run as separate PRs (one package ownership set per agent). Do not start `p5-graph-ui` and `p5-scripting-core` against competing IR shapes — core owns the IR contract first.

**P5 status:** all checklist slices (`p5-*`) are landed. Canvas pin hydration, palette pin embedding, Begin Play/Tick defaults, and Add/Remove node undo commands are landed (authoring loop fix). Residual work is polish and phase-owned stubs below. Do **not** reopen a parallel "build visual scripting" phase ahead of P8; schedule polish opportunistically or after the debugger console lands.

### P5 follow-ups / open deferrals

| Item | Owner | Notes |
| --- | --- | --- |
| Pin flash on tap-to-navigate | later polish (`graph-ui`, editor) | Selects + fits node; pins carry `data-error` but no flash yet |
| Full Enum / Structure / ScriptInterface row editors | `apps/editor`, `editor-kit` | DockView member tables, ScriptInterface method preview, `PinListEditor` / `PinTypePicker` |
| Project-wide pre-Preview validation sweep | later polish (`apps/editor`, `scripting`) | Play now validates the compiled project graph set (`collectPlayPreviewScripts`); startup-map / GameInstance / plugin EUO sweep still deferred |
| Latent nodes as async generator state machines | later polish (`scripting`) | Host promises today; Delay / async ExecuteJavaScript still run |
| ExecuteConsoleCommand registry + debug-tier warnings | P8 | Landed (`p8-command-system`) |
| BDebugCommand + parameter list | P8 | Landed (`p8-bdebugcommand`) |
| Play console + stats HUD | P8 | Landed (`p8-console-hud`) |
| Trace recorder / `.babtrace` | P8 | Landed (`p8-trace-recorder`) |
| Keyed Print HUD polish + strip-on-export preset UI | P8 / export | Print works; export strip preset + HUD polish deferred |
| AI / navigation scripting nodes | P11 | Catalog categories wait for behaviour trees + navmesh |
| Audio / UI node runtime helpers beyond stubs | P9 | `setWidgetVisible` / `applyUserInterface` / `removeUserInterface` emit UI commands; audio helpers still stubs |

**Closed (authoring loop):** host `__pins` hydration + palette pin payload; `AddNodeCommand` / `RemoveNodeCommand`; new graphs seed Begin Play + Tick via `createDefaultLogicGraphSerialized`; **drag-to-connect** (`onConnect` / connect-end palette) plus tap-to-connect; **Format** (selection tidy / then-chain); **hold-to-marquee** (`attachGraphPaneMarquee`).

**Closed (class-owned graphs):** logic graphs live on Class assets (`.class.babasset`); New Asset is authored-only; Prefab/Components are Actor-lineage only; Enum/Structure/ScriptInterface open DockView documents (import data types stay compact `asset-settings` tabs). Legacy Graph files still load.

## P6 slice ownership

| Slice | Checklist | Packages | Depends on |
| --- | --- | --- | --- |
| Design notes | — | `docs/architecture/scene-editing.md`, `input.md` | P5 complete |
| Scene schema | — | `core` (`SerializedScene` v2) | Design notes |
| Editor kit | `p6-editor-kit` | `editor-kit`, `apps/editor` (gallery route) | Design notes |
| Scene editing | `p6-scene-editing` | `edit` (scene commands), `apps/editor` (viewport, outliner, details, mini asset browser, actor prefab) | Scene schema + editor-kit + command layer |
| 2D viewport | `p6-2d-viewport` | `render` (editor-camera, gizmo-host, editor-grid, viewport-gestures) | Scene editing |
| 2D units + sorting | `p6-2d-units-sorting` | `core` (project `twoD` settings), `render` (sorting, pixel-perfect) | 2D viewport |
| Input mappings | `p6-input-mappings` | `input`, `runtime`, `scripting-nodes`, `apps/editor` (Project Settings Input tab) | P4 input capture |
| E2E + docs | — | `e2e/`, `docs/` | All P6 slices |

Design notes: [scene-editing.md](../architecture/scene-editing.md), [input.md](../architecture/input.md).

**Closed deferrals:** P2 "scene document commands on the edit layer → P6" (`p6-scene-editing`); P4 "action mappings deferred to P6" (`p6-input-mappings`).

### P6 follow-ups / open deferrals

| Item | Owner | Notes |
| --- | --- | --- |
| Actor Prefab tab → class document persistence | Done | `SerializedGraph.components` + `graph.setComponents`; Place Actors copies prefabs from the open tab or the disk class graph |
| Non-mesh component visualization (sprite quads, light/camera gizmos) | Done (foundation wave) | Sprite/tilemap quads bind `ResourceCache` textures; `LightComponent` / `CameraComponent` create authored lights/cameras (editor keeps the orbit camera); light/camera/audio actors use editor billboard icons; selected camera frustum + 1 Hz RTT preview; selected light dashed range/cone/arrow |
| Lighting and cameras (direction, Play color/intensity, `shadowquality` → one ShadowGenerator, game camera) | `p-lighting-camera` | Authored lights, range/kind/angle, and editor debug overlays shipped. Spec: [engineplan §2.5](../engineplan.md). Directional/spot still `(0,-1,0)`; Play lights are white; editor sync dispose+recreates; Play cameras are `FreeCamera`; active camera is first in the list. Remaining: **Default Camera** via kit `SceneComponentPicker` (`CameraComponent` only), **Possess Camera** node (global Play camera), `UniversalCamera`, shadows/IBL. May run beside P11. |
| Place Actors drag-to-viewport / raycast drop | later polish | Outliner **+** click-to-spawn shipped; drag from catalog is out of scope |
| Gamepad rumble (`setGamepadRumble`) | P9 / input polish | Runtime logs only; no `vibrationActuator` yet |
| Structured Input mappings editor (vs raw JSON) | Done | Project Settings Input is `InputMappingEditor` (listen-to-bind); no JSON textarea |
| Multi-select gizmo (transform all selected) | later polish | Outline covers all; gizmo attaches to first pickable |

## P7 slice ownership

Backends, Play scene load, and character-controller scripting have landed (`p7-physics`, `p7-2d-physics`, `p7-play-scene-load`, `p7-character-controller`).

| Slice | Checklist | Packages | Depends on |
| --- | --- | --- | --- |
| Design notes | — | `docs/architecture/physics.md` | P6 complete |
| Physics package + Havok V2 | `p7-physics` (done) | `physics`, `core` (scene `physicsWorld`), `object-model`, `runtime`, `scripting-nodes`, `bridge`, `test-kit`, `apps/editor` (Play overlay ms, Add Component, vendored wasm) | Design notes |
| Rapier 2D | `p7-2d-physics` (done) | `physics`, `scripting-nodes`, `test-kit` | `p7-physics` interface + scene world field |
| Play loads `SerializedScene` | `p7-play-scene-load` (done) | `runtime`, `object-model`, `bridge`, `render`, `apps/editor` | P6 scene docs + P7 backends |
| Character-controller scripting | `p7-character-controller` (done) | `scripting-nodes`, `runtime` | Play scene load |

Design notes: [physics.md](../architecture/physics.md).

## P8 slice ownership

`p8-command-system`, `p8-bdebugcommand`, `p8-console-hud`, and `p8-trace-recorder` have landed. P8 does not depend on further physics work.

| Slice | Checklist | Packages | Depends on |
| --- | --- | --- | --- |
| Design notes | — | `docs/architecture/debugger.md` | Play scene load |
| Command registry | `p8-command-system` (done) | `debugger`, `runtime`, `apps/editor` (graph validation) | Design notes |
| BDebugCommand + parameter list | `p8-bdebugcommand` (done) | `object-model`, `editor-kit`, `debugger`, `apps/editor` | Command registry |
| Console + stats HUD | `p8-console-hud` (done) | `debugger`, `apps/editor`, `render` | Command registry |
| Trace recorder | `p8-trace-recorder` (done) | `debugger`, `assets` (container), `runtime` | Command registry |

Design notes: [debugger.md](../architecture/debugger.md).

### P8 follow-ups / open deferrals

P8 phase acceptance is met at the blocking level (`p8-command-system`, `p8-bdebugcommand`, `p8-console-hud`, `p8-trace-recorder`). Do **not** rebuild P8; residual HUD/trace/settings polish is later work.

| Gap vs engineplan §9 | Reality | Owner |
| --- | --- | --- |
| Core quality commands “mutate real engine settings” | `consoleHost` still `emitSetting` logs ([debugger.md](../architecture/debugger.md) already says this) | Later polish / P14 player |
| §9.4 HUD (render ms, invalidations/s, HW scale, texture/geometry/compressed bytes, LRU evictions, actors, per-channel bytes) | `StatsHud` shows fps, script/physics ms, tick-budget flag, one accounted-byte total, mesh/texture counts, draws, aggregate bridge msgs/s | `p8-hud-polish` |
| Trace as document tab + graphs + derived-data `.babtrace` spill | In-memory + overlay `TracePlayback`; `encodeTraceDocument` exists, editor does not write it | `p8-trace-playback` (P11 needs real input replay) |
| `PinListEditor` on Class / ScriptInterface | Done (Class Inspector function pins + ScriptInterface method Details; ExecuteJavaScript / OnCommandRun keep the `ParameterListEditor` wrapper) | — |

## P9 slice ownership

P9 content systems have landed (`p9-ui-anchoring`, `p9-fonts`, `p9-ui-system`, `p9-widget-library`, `p9-sprite`, `p9-anim-graph`, `p9-shader-graph`). Do **not** rebuild P9 packages. Authoring-surface hosts (canvas gestures, Logic palette, Sprite Texture picker, `NodeMaterial.Parse` preview) landed on `cursor/authoring-surface-8678`. Residual ADT mesh HUD / CustomBlock GLSL IDE stays later polish.

| Slice | Checklist | Packages | Depends on |
| --- | --- | --- | --- |
| Design notes | — | `docs/architecture/ui-runtime.md`, `fonts.md`, `sprites.md`, `anim-graph.md`, `shader-graph.md` | P8 complete |
| Anchoring + layout | `p9-ui-anchoring` (done) | `ui-runtime` | Design notes |
| Font payload + registry | `p9-fonts` (done) | `assets`, `core`, `render`, `ui-runtime`, `apps/editor` | Design notes |
| UserInterface + designer | `p9-ui-system` (done) | `ui-runtime`, `render`, `bridge`, `runtime`, `apps/editor`, `edit` | Anchoring + fonts |
| Widget library + touch axis | `p9-widget-library` (done) | `ui-runtime`, `input`, `apps/editor` | UI system |
| Sprite packer + quad | `p9-sprite` (done) | `assets`, `render`, `apps/editor` | Design notes |
| AnimationGraph | `p9-anim-graph` (done) | `anim-graph`, `runtime`, `render`, `graph-ui`, `apps/editor` | Sprite (clips) + graph-ui host with Parameters / States / Details |
| Shader graph | `p9-shader-graph` (done) | `shader-graph`, `render`, `graph-ui`, `apps/editor` | Design notes + graph-ui host |

Design notes: [ui-runtime.md](../architecture/ui-runtime.md), [fonts.md](../architecture/fonts.md), [sprites.md](../architecture/sprites.md), [anim-graph.md](../architecture/anim-graph.md), [shader-graph.md](../architecture/shader-graph.md).

### P9 Play-path residuals (do not rebuild P8/P9)

Chrome polish (pin flash, multi-select gizmo) stays parked. Remaining Play/scripting holes were closed by the pre-P11 foundation wave on `cursor/foundation-harden-e9a2` (do not rebuild P8/P9 packages).

| Item | Status |
| --- | --- |
| Sprite `animState` UVs in Play | Done |
| Worker HUD `scriptMs` / `physicsMs` not clobbered by rAF | Done |
| Play loads anim graphs / sprites from scene refs | Done |
| `ctx.changeScene` / `changescene` loads a scene from the Play scene library | Done (foundation wave) |
| Catalog honesty (Tilemap / BT / Nav / Widget / AudioComponent) | Done (Tilemap addable; BT/Nav gated; Widget hidden; AudioComponent not in Search/Add) |
| Enum / Structure / ScriptInterface editors | DockView Members / Methods / Preview / Details |
| Prefab → class document persistence | Done (open tab **or** disk graph) |
| Map nodes | Done (`map.get` / `set` / `has` / `remove` / `size` / `keys`) |
| ScriptHost input / tick Delay / spawn / addComponent / GameInstance | Done (foundation wave; worker Play applies queued input each tick — host wall-clock stamps must not drop GetAxis) |
| Play startup scene with no scene tab open | Superseded — Play is **disabled** until a scene tab is open; `startupSceneGuid` is packaged/export only |
| Sprite/tilemap `ResourceCache` textures + GLB `assetGuid` | Done (foundation wave) |
| HUD TouchButton / TouchDPad → input | Done (foundation wave) |
| `playSound` command (log, not a mixer), `.babtrace` tab, §9.4 HUD | Command landed; mixer / trace tab parked. ADT HUD done |

### Authoring-surface wave (before P11)

Fill **hosts** in `apps/editor` (and bind helpers already in `render` / `runtime`). Do **not** rebuild `@babylonslate/ui-runtime`, `@babylonslate/shader-graph`, `@babylonslate/anim-graph`, or `@babylonslate/scripting`. Do not start P11 `behaviour-tree` / `navigation` from leftover chrome polish.

| Wave | Status |
| --- | --- |
| A — UI design canvas pan/zoom/drag + alignment / left / top PropertyGrid | Done (`cursor/authoring-surface-8678`; Babylon-native fields on `cursor/babylon-native-ui-138e`) |
| B — UI Logic palette + Play compile + Class `flow.event.custom` | Done (`cursor/authoring-surface-8678`) |
| C — Sprite Texture picker | Done (`cursor/authoring-surface-8678`) |
| D — Shader `NodeMaterial.Parse` preview + shader/anim catalog pin hydration | Done (`cursor/authoring-surface-8678`) |
| E — Touch-first Input / asset / class authoring | Done (`cursor/touch-authoring-controls-c4cd`) |
| F — Anim Graph Parameters / States / Details host | Done (`cursor/anim-graph-authoring-6e70`) |

Parked with this wave: pin flash, multi-select gizmo, `WidgetComponent` `CreateForMesh`, per-function graphs, FunctionLibrary palette, CustomBlock GLSL IDE, assigning a shader to a live scene mesh.

### P9 follow-ups / open deferrals

| Gap vs engineplan §11–§14 | Reality | Owner |
| --- | --- | --- |
| Viewport-layer HUD as Babylon `AdvancedDynamicTexture` | `BabylonUiApplyHost` + `attachFullscreenGui` (Play scene Layer). Designer uses the same host on a standalone ADT copied onto the document canvas (not `registerView`). DOM testid markers remain for jsdom / Playwright | Done (`cursor/ui-designer-rework-138e`) |
| Every UserInterface in the asset registry auto-hosted in Play | Play does **not** auto-apply UI. Class graphs call `ui.applyToViewport` / `ui.removeFromViewport`; the host loads a guid-keyed library of all UserInterface assets | Done (`cursor/ui-apply-nested-8c7a`) |
| `NodeMaterial.Parse` + live Babylon preview | `applyShaderGraphPreview` throttles `compileShaderGraphForRender` then `NodeMaterial.Parse` (injected `forceCompilationAsync` / parser in tests). Shader tab hosts a preview canvas; catalog `__pins` hydrated | Done (`cursor/authoring-surface-8678`) |
| Thin-instance / merged-static sprite batching | Out of v1 (measure later, §13.2) | After a profile on device |
| Play engine applies sprite-clip UVs from `animState` | `applyAnimStateToScene` calls `applySpriteAnimFrame` when `clipKind === "sprite"`; Play loads sprite payloads from scene `SpriteComponent` guids | Done (`cursor/play-path-harden-8678`) |
| World-space `WidgetComponent` (`CreateForMesh`) | Class id stays in the object model; Add Component and Search no longer advertise it until `CreateForMesh` exists | Later polish |
| Designer nested-UI guid field + cycle check UI | `UserInterface` widget kind + Details `AssetPicker`; `nestedUiPickableGuids` excludes self and cycle partners | Done (`cursor/ui-apply-nested-8c7a`) |
| Play HUD `FontRegistry.registerAll` from project Font assets | Play overlay and the UserInterface designer `registerAll` Font `source` bytes then `markAsDirty()` on the HUD/designer ADT | Done (`cursor/babylon-native-ui-138e`) |

## P10 tilemaps

Design note: [tilemaps.md](../architecture/tilemaps.md). Codecs first, then Rapier chains + Play, then painting / 2D template / acceptance e2e.

| Item | Status |
| --- | --- |
| Tileset / Tilemap payloads, UV math, golden chunk VertexData, document tabs | Done (`cursor/play-path-harden-8678`) |
| Merged chain colliders + `TilemapComponent` Play load | Done (`cursor/play-path-harden-8678`) |
| Touch painting, one undo per stroke, 2D Create Project card, acceptance e2e | Done (`cursor/play-path-harden-8678`) |
| Play asserts a falling actor settles on painted tiles | Done (foundation wave; keep in-process `tilemap-physics.test.ts`) |
| Autotile / terrain | Deferred |
| A16 alpha-test vs blend profile | Record in tilemaps.md; do not lock a new default without numbers |

## Pre-P11 foundation hardening

Do **not** rebuild `@babylonslate/ui-runtime`, `shader-graph`, `anim-graph`, `scripting`, `physics`, or `debugger`. Host wiring + runtime bindings + honest e2e. P11 (`behaviour-tree` / `navigation`) starts only after this wave is on `main`.

| Item | Status |
| --- | --- |
| ScriptHost `TickContext` input, tick Delay, spawn, addComponent, interface handlers | Done |
| Play loads startup/main scene + `gameInstanceClass` with no scene tab | Superseded — Play uses the open scene tab only; disabled otherwise. `collectPlayStartupScene` path fallback removed. `startupSceneGuid` is packaged/export boot (`p14-export`) |
| Place Actors copies closed-tab class prefab components from disk | Done |
| `changescene` / `ctx.changeScene` instantiates a library scene | Done |
| Sprite/tilemap textures via `ResourceCache`; GLB `assetGuid`; authored lights/cameras | Done (full lighting/camera contract is §2.5 / `p-lighting-camera`, not P11) |
| Play HUD TouchButton / TouchDPad / default Jump+dpad mappings | Done |
| `playSound` command (logged; no mixer) | Done |
| FunctionLibrary palette nodes | Parked (base class exists) |

## Lighting and cameras (`p-lighting-camera`)

Spec: [engineplan.md](../engineplan.md) §2.5. Named slice; may run beside P11 (owns `render` / `core` / `runtime` / `editor`, not AI packages).

| Slice | Checklist | Packages |
| --- | --- | --- |
| Schema + Details | `p-lighting-camera` | `core` SceneSettings Default Camera (actor+component ids); kit `SceneComponentPicker` with `allowedClassIds`; `apps/editor` Details enums and scene-settings rows |
| Renderer | same | `render` incremental `scene-illumination`, detached UniversalCamera, one ShadowGenerator, fog/IBL/clear, dir/spot gizmos |
| Play | same | `runtime` assign payload; named Default Camera as `activeCamera`; `render` snapshot-apply parity |
| Scripting | same | `scripting-nodes` **Possess Camera** (global `activeCamera`); get/set FOV, ortho size, light enabled/color/intensity |

## P11 behaviour trees / navigation

Do not start until the foundation-hardening wave above is merged. Chrome polish (pin flash, multi-select gizmo) is not a reason to skip P11, and is not P11 work. Lighting and cameras are section 2.5 / `p-lighting-camera` — parallel to P11, not P11 work.


