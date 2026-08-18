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
| 2026-08-18 | cursor/play-debugger-review-f6e8 | Play debugger overlay / inspector / console | Standards | Inspector identity labeled `Guid` instead of Title Case `GUID` | Resolved |
| 2026-08-18 | cursor/play-debugger-review-f6e8 | Play debugger overlay / inspector / console | Standards | Console `DialogHeader` used `space-y-0`; repo spacing is `flex` + `gap-*` | Resolved |
| 2026-08-18 | cursor/play-debugger-review-f6e8 | Play debugger overlay / inspector / console | Standards | Package API docs omitted `createDebugInspectSnapshot`; bridge Channels omitted `inspect` / `inspectSnapshot` (and `console` / `consoleResult`) | Resolved |
| 2026-08-18 | cursor/play-debugger-review-f6e8 | Play debugger overlay / inspector / console | Spec | Worker `{ type: "inspect" }` → `inspectSnapshot` had no unit test (`worker-entry` is coverage-excluded); extracted `applyInspectControl` | Resolved |
| 2026-08-18 | cursor/play-debugger-review-f6e8 | Play debugger overlay / inspector / console | Spec | Pause On Play posted `setPaused` while `boot.play` was still loading, then `resume()` undid the pause; `createPlayPauseGate` holds pause until boot finishes | Resolved |
| 2026-08-18 | cursor/play-debugger-review-f6e8 | Play debugger overlay / inspector / console | Spec | Inspect poll could overlap worker RPCs; now skips while a pull is in flight | Resolved |
| 2026-08-18 | cursor/play-debugger-review-f6e8 | Play debugger overlay / inspector / console | Spec | Unchecking Debug Overlay Inspector hid the dialog without clearing `inspectorOpen`, so checking it again reopened the modal | Resolved |
| 2026-08-18 | cursor/play-debugger-review-f6e8 | Play debugger overlay / inspector / console | Spec | Debug Overlay checkboxes stay enabled while playing, but the Play overlay covers the toolbar; e2e toggles before Play. Accepted — hide via overlay chrome mid-session | Accepted |
| 2026-08-18 | cursor/play-debugger-review-f6e8 | Play debugger overlay / inspector / console | Spec | Inspector live-update e2e asserts header `tickIndex` (spec: “tick counter or similar”), not an actor variable | Accepted |
| 2026-08-18 | cursor/animgraph-spec-audit-c687 | AnimGraph Sprite Animation | Spec | Sprite Animation physics/render used `frame.width ?? 100` while Texture pick did not stamp pixels; Play/player now hydrate missing sizes from PNG IHDR | Resolved |
| 2026-08-18 | cursor/animgraph-spec-audit-c687 | AnimGraph Sprite Animation | Spec | Sprite Animation Preview overlay covered the letterbox, not the `object-contain` image | Resolved |
| 2026-08-18 | cursor/animgraph-spec-audit-c687 | AnimGraph Sprite Animation | Spec | Leaving a sprite clip never called `setActorSpriteClip(null)`, so a later Model state kept the last Sprite Animation AABB | Resolved |
| 2026-08-18 | cursor/animgraph-spec-audit-c687 | AnimGraph Sprite Animation | Standards | Sprite Animation Details duplicated the DockView tab title; checkerboard used raw hex; collision handle labels were sentence case | Resolved |
| 2026-08-16 | cursor/bt-editor-ux-review-ed63 | p-bt-editor-ux | Spec | Consecutive finished node moves reused `mergeKey` `"bt-node-move"`, so two completed drags undid as one. Position commits now call `applyNodePositions` with no merge key (`commitPositionsOnDragEnd` already emits once) | Resolved |
| 2026-08-16 | cursor/bt-editor-ux-review-ed63 | p-bt-editor-ux | Spec | `serializedToBehaviourTree` X-sorted siblings without a previous-`children[]` tie-break; canvas round-trip could flip equal-X order. Graph position path now uses `applyNodePositions` | Resolved |
| 2026-08-16 | cursor/bt-editor-ux-review-ed63 | p-bt-editor-ux | Spec | Drag-off-handle e2e only asserted Wait Details, not a parent→child edge | Resolved |
| 2026-08-16 | cursor/bt-editor-ux-review-ed63 | p-bt-editor-ux | Standards | Compiler Results severity badge rendered `error` / `warning` instead of Title Case | Resolved |
| 2026-08-16 | cursor/material-shader-review-fa96 | material shader improvements | Spec | Packaged player packed Material JSON but never hydrated documents, the scene stack, or `assignMaterial`, so exported games could not run authored materials | Resolved |
| 2026-08-16 | cursor/material-shader-review-fa96 | material shader improvements | Spec | Scene Depth did not enable/release a linearized depth renderer; missing buffers were unanchored strings and `deviceBuffers` omitted counted as present | Resolved |
| 2026-08-16 | cursor/material-shader-review-fa96 | material shader improvements | Spec | Preview e2e covered orbit/wheel only; pinch was missing from p9 and GraphEditor `commitPositionsOnDragEnd` was absent from the components catalog | Resolved |
| 2026-08-16 | cursor/p15-review-fixes-419b | p15-lock-provider | Spec | Git LFS create mapped every HTTP 409 as theirs (`parseLock(..., false)`), so a lock we already held flipped to unlocked until the next poll. Create now verifies and treats the path as held when it is in `ours` | Resolved |
| 2026-08-16 | cursor/p15-review-fixes-419b | p15-lock-ux | Spec | Asset rename and folder rename/move skipped lock refuse/transfer; folder delete now also unions contained asset paths. Content Browser uses `source-control-file-ops` for all path-keyed ops | Resolved |
| 2026-08-16 | cursor/p15-review-fixes-419b | p15-lock-provider | Spec | `BabylonSlateSecretsPlugin.swift` existed but was not in the iOS App Sources phase or Capacitor `packageClassList`, so Keychain never registered | Resolved |
| 2026-08-16 | cursor/p15-review-fixes-419b | p15-lock-ux | Standards | Token status and Locks empty copy were sentence case; external-change path lists were not `SelectableText` | Resolved |
| 2026-08-16 | cursor/p15-review-fixes-419b | p15-lock-provider | Spec | Electron `secrets:set` stores the PAT unencrypted when `safeStorage.isEncryptionAvailable()` is false (Linux without a keyring) | Accepted |
| 2026-08-16 | cursor/p15-source-control-gaps-44b6 | p15-lock-ux | Spec | Auto-lock still called create after a restart verify already listed the path as ours; skip create when held locally | Resolved |
| 2026-08-16 | cursor/p15-source-control-gaps-44b6 | p15-lock-ux | Spec | Deleting an asset we held did not unlock the old LFS path | Resolved |
| 2026-08-15 | cursor/p14-implementation-review-c2d5 | p14-export / p14-platforms | Spec | Packaged player booted an empty Engine: no sprite/tilemap/navmesh hydrate, no UI-logic compile, no in-process rAF `advance` or canvas input | Resolved |
| 2026-08-15 | cursor/p14-implementation-review-c2d5 | p14-packed-mode | Spec | `game.json` omitted `pixelsPerUnit` / `pixelPerfect`; Font index entries had no authored family `name` | Resolved |
| 2026-08-15 | cursor/p14-implementation-review-c2d5 | p14-platforms | Spec | Packaged player compiles UserInterface logic and packs UI JSON; Babylon GUI widget mount stays overlay Play (`PlayHudOverlay`) | Accepted |
| 2026-08-15 | cursor/p14-implementation-review-c2d5 | p14-export | Spec | Export e2e still asserts boot + ticks on the cube fixture; packed sprite/tilemap/navmesh/UI-logic coverage is unit-tested | Accepted |
| 2026-08-15 | cursor/p13-implementation-review-4e26 | p13-plugin-model / Play | Spec | `collectPlaySceneLibrary` walked `project.json` `scenes` only, so enabled plugin Scenes never reached Play `changescene` | Resolved |
| 2026-08-15 | cursor/p13-implementation-review-4e26 | p13-engine-plugin | Spec | Engine Memory `ProjectStorage` stayed writable after unpack; now wrapped with `createReadOnlyProjectStorage` | Resolved |
| 2026-08-15 | cursor/p13-implementation-review-4e26 | p13-engine-plugin | Spec | New-project copies kept engine `enabledByDefault: true` when authored that way; copies now force `false` | Resolved |
| 2026-08-15 | cursor/p13-implementation-review-4e26 | p13-plugin-settings-ui | Spec | Engine Class/Scene `apply*Change` and `writeSceneNavmeshChunk` did not honor read-only (only PluginSettings UI + `saveDocument`) | Resolved |
| 2026-08-15 | cursor/p13-implementation-review-4e26 | p13-babplugin | Spec | engineplan §10.6 / appendix claimed packed tree-shake in P13; wording now matches the accepted P14 deferral | Resolved |
| 2026-08-15 | cursor/p13-plugins-4e26 | p13-plugin-settings-ui | Standards | PluginSettings Details used `Guid` (not Title Case `GUID`); identity omitted the plugin guid | Resolved |
| 2026-08-15 | cursor/p13-plugins-4e26 | p13-plugin-settings-ui | Standards | Project Settings dependency status was lowercase (`missing` / `cycle` / `engine`) | Resolved |
| 2026-08-15 | cursor/p13-plugins-4e26 | p13-plugin-model | Spec | Any dependency cycle returned `order: []`, unmounting independent plugins | Resolved |
| 2026-08-15 | cursor/p13-plugins-4e26 | p13-plugin-model | Spec | `pluginOverrides` guids were always indexed as Unresolved, including discovered plugins (PluginSettings lives outside the mounted `assets/` root) | Resolved |
| 2026-08-15 | cursor/p13-plugins-4e26 | p13-plugin-settings-ui | Standards | Open / Export / Delete plugin row buttons were `size="sm"` without a 44px min touch target | Resolved |
| 2026-08-15 | cursor/p13-plugins-4e26 | p13-babplugin / p13-plugin-settings-ui | Spec | Game-export packing and export-preset layer-3 consumption deferred to P14 (`collectEnabledPluginAssets` + empty `exportPresets` only) | Accepted |
| 2026-08-15 | cursor/p13-plugins-4e26 | p13-engine-plugin | Spec | Missing-plugin e2e seeds an override on an open project rather than cold-loading a project whose plugin folder is absent; unit tests cover remount replacing placeholders | Accepted |
| 2026-08-15 | cursor/p13-plugins-4e26 | p13-babplugin | Spec | Import e2e asserts the class guid in Place Actors after discard, not a scene actor edge (the scene lives in the project, not the `.babplugin`) | Accepted |
| 2026-08-15 | cursor/p13-plugins-4e26 | p13-babplugin | Spec | Same guid + different version updates in place; Keep/Replace is same guid+version (locked design). Spec §10.5 “version conflict” prompt is the identical-version case | Accepted |
| 2026-08-15 | cursor/p4-followups-55e8 | p4-preview-report | Spec | Log Error never entered the session report; ExecuteJavaScript `bodyLine` was not compiled, not on the worker diagnostic command, and navigate did not set CodeMirror focus | Resolved |
| 2026-08-15 | cursor/p3-spawn-wiring-14d8 | p3-object-model | Spec | ClassRegistry unused at spawn; Play `callInterface` skipped `dispatchInterface` so scene actors never received class-declared interface guids | Resolved |
| 2026-08-15 | cursor/p3-spawn-wiring-14d8 | p3-object-model | Standards | Engine components and BT builtins were reparentable (`MeshComponent` → `Actor`) | Resolved |
| 2026-08-15 | cursor/p3-spawn-wiring-14d8 | p3-object-model / p3-harness | Spec | Remaining accepted P3 cuts: World-owned spawn API (spec wording), flat runtime components (`SerializedComponent.parentId` dropped at Play), VFS fixtures decoupled from the 120-tick golden | Accepted |
| 2026-08-14 | cursor/scene-open-old-project-crash-82b9 | scene-open crash | Standards | Alert catalog “Used for” omitted `WorkspaceErrorBoundary` | Resolved |
| 2026-08-14 | cursor/p11-p12-quality-b945 | p11-behaviour-tree | Spec | Empty-stack restart ran in the same tick as root TimeLimit/abort; Parallel starved nested siblings and skipped abort/TimeLimit/services on yielded children; Loop ignored failure; self-abort skipped Cooldown | Resolved |
| 2026-08-14 | cursor/p11-p12-quality-b945 | p12-editor-extensions | Spec | Saving EditorUtilityInterface `dockKind` wrote the header but did not reindex `AssetRegistry`, so Windows → Editor Utilities kept the stale filter until remount | Resolved |
| 2026-08-14 | cursor/p11-p12-quality-b945 | p11-acceptance / p12-editor-extensions | Spec | Tree restart kept Wait/MoveTo/custom `nodeMemory` (instant re-success); MoveTo abort did not `stopNavAgent`; EUO ScriptHost rebooted on any `projectDocument` identity change | Resolved |
| 2026-08-14 | cursor/p11-p12-quality-b945 | p12-ui-editors / p11-nav-editor-host | Spec | Live EUI present failures were silent (e2e asserted a missing `ui-gui-preview-error`); `isHardUiPresentFailure` treated a throw that production never emits; Auto Bake On Save Details toggle was unwired | Resolved |
| 2026-08-11 | cursor/p3-object-model-e177 / cursor/p3-spawn-deferral-e177 | p3-object-model | Standards | `spawnActorNow` ignored mid-tick and committed immediately (doc requires deferral) | Resolved |
| 2026-08-11 | cursor/p3-object-model-e177 / cursor/p3-spawn-deferral-e177 | p3-object-model | Standards | Doc listed `TickScheduler`; exports are `TickClock` / `TICK_PHASES` | Resolved |
| 2026-08-11 | cursor/p3-object-model-e177 | p3-object-model / p3-harness | Spec | Acceptance (120-tick golden) met; remaining notes are intentional P3 scope (registry not wired into spawn, World-owned spawn API, flat components, VFS fixture decoupled from scenario) | Accepted |
| 2026-08-11 | cursor/p4-bridge-play-2497 | p4-play-overlay | Spec | Play used in-process only; Worker host deferred | Resolved |
| 2026-08-11 | cursor/p4-harden-2497 | p4-play-overlay | Spec | Play prefers `worker-entry` via `createGameWorkerHost`; falls back in-process with warning; texture leak + runtimeMode logged on stop | Resolved |
| 2026-08-11 | cursor/p4-harden-2497 | p4-resource-cache | Spec | `ResourceCache.getTexture` + sampling-key path; idle zero-frame + encode pause reason-set; tap picking | Resolved |
| 2026-08-11 | cursor/p4-bridge-play-2497 | p4-render-sync | Standards | Per-frame ActorSlot/Set alloc in snapshot sync — fixed to reuse scratch | Resolved |
| 2026-08-11 | cursor/p4-bridge-play-2497 | p4-bridge | Spec | Multi-transport parity harness now exercises SAB + transferable against in-process snapshot payload | Resolved |
| 2026-08-11 | cursor/p4-bridge-play-2497 | p4-preview-report | Spec | Navigate focuses fixture node id (full graph/bodyLine navigation waits on P5 compiler) | Resolved (`bodyLine` compile → diagnostic → CodeMirror) |
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
| 2026-08-16 | cursor/class-variables-review-6916 | class variables | Spec | Bound Get/Set data pins used generic `value` / `out` labels instead of the variable name; canvas showed Value. Pin **ids** stay `value` / `out`; **names** are the variable. Set now assigns the pass-through output slot | Resolved |
| 2026-08-16 | cursor/class-variables-review-6916 | class variables | Spec | Selecting an interface while a function graph is open was untested; Local Variables must stay visible | Resolved |
| 2026-08-16 | cursor/class-variables-review-6916 | class variables | Spec | Class Inspector string/text Default row for variables was untested | Resolved |
| 2026-08-16 | cursor/class-variables-review-6916 | class variables | Standards | Palette injector named class members `localVars` / `localNames` next to real function locals | Resolved |
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

## Subagent model allowlist

When a parent agent launches Task / subagents, the model is a **hard allowlist**, not a preference:

- **Allowed:** omit `model` (inherit parent); **Composer 2.5** (`composer-2.5`); **Grok 4.5** or **Grok 4.6** at **low, medium, high, or extra-high** (e.g. `cursor-grok-4.5-high`). These are equal options.
- **Forbidden:** Fast variants (`composer-2.5-fast`, `cursor-grok-4.5-high-fast`, `cursor-grok-4.6-high-fast`, or any other `*-fast` slug); Claude (Sonnet, Opus, Fable, Haiku); GPT; Gemini; and any other family. Do not pass those slugs even if the Task tool lists them.
- Omitting `model` is allowed. Do not require an explicit slug on every Task call.
- Honor a different model only if the human user explicitly names it in this conversation. A parent agent must not pick Sonnet or any other forbidden family because a task “would benefit.”
- See [.cursor/rules/agent-workflow.mdc](../../.cursor/rules/agent-workflow.mdc) (Subagent models).

## No AI-generated artwork

Agents must never create visual or spatial media with AI (images, video, icons, logos, textures, sprites, 3D art assets). The ban is absolute — placeholders, tests, docs, and user requests do not override it.

- **Forbidden:** `GenerateImage` (and equivalents); invented PNG/SVG/WebP/MP4/GLB (and similar) as product or placeholder art.
- **Allowed:** Lucide / project `iconLibrary`; existing `engine-logos/` and `public/branding/` copies; engine primitives (`CreateBox`, debug overlays) as product features; solid-color test fixtures; captures of the real running app.
- If artwork is missing, stop and ask a human. Do not generate a stand-in.
- Rule: [.cursor/rules/no-ai-artwork.mdc](../../.cursor/rules/no-ai-artwork.mdc).

## BabylonJS skill

Agents must read [`.cursor/skills/BabylonJS/SKILL.md`](../../.cursor/skills/BabylonJS/SKILL.md) before engine or scene work, and before **UserInterface** or **EditorUtilityInterface** work. Both asset types are Babylon GUI (`@babylonjs/gui` / `AdvancedDynamicTexture`), not React chrome.

- **UserInterface** — game HUD, viewport-layer apply, designer canvas ([ui-runtime.md](../architecture/ui-runtime.md)).
- **EditorUtilityInterface** — widgets opened from **Windows → Editor Utilities** (P12).
- React editor chrome (Dockview, shadcn, editor-kit) still uses the editor-ui-components and shadcn skills.
- Rule: [.cursor/rules/agent-workflow.mdc](../../.cursor/rules/agent-workflow.mdc) (BabylonJS).

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

`World.createActor` / `createComponent` / `createGameInstance` apply `ClassRegistry.inheritedVariables` and `inheritedInterfaces` (caller overrides win). `RuntimeDriver.loadScripts` registers session class ids from `ScriptBundleEntry` metadata. Play `ctx.callInterface` uses `dispatchInterface` (pin defaults on miss). Nested runtime component `parentId` and VFS-backed 120-tick fixtures stay out of this wiring.

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

Appendix A `p4-*` checkboxes are landed as a vertical Play path. Leftovers below are **not** implied done.

### P4 follow-ups / open deferrals

| Item | Owner | Notes |
| --- | --- | --- |
| Live SAB zero-copy (main thread reads shared buffer, no per-frame `postMessage`) | later polish (`runtime` worker-entry) | `SeqLockSnapshotPair` unit-tested; Play always uses `TransferablePingPong`. Accepted 2026-08-12 |
| Multi-transport parity as three hosts | later polish (`test-kit`) | `transport-parity.test.ts` republishes one in-process buffer through SAB/transferable; not three independent runtimes |
| Typed RPC on the live worker path | later polish (`bridge`, `runtime`) | Types + unit test only; Play uses control/command/input/snapshot |
| `remap` command | later polish (`bridge`) | Docs mention guid↔slotId via spawn/despawn/remap; types have spawn/despawn only |
| Play 60fps on A16 iPad | `p14-perf-smoke` / `p1-device-spikes` | CI does not prove device frame rate |
| WKWebView `Error.stack` parse | `p1-device-spikes` | V8 + WebKit-shaped strings unit-tested; hardware WKWebView unconfirmed |
| Capacitor app-state pause | later polish (`vfs`) | Editor listens for `babylonslate:appstate`; no vfs emitter yet. `visibilitychange` works |
| `renderquality` / Engine Settings `hardwareScalingLevel` → Engine | Done (`cursor/material-shader-improvements-fa96`) | Engine Settings `hardwareScalingLevel` is applied at viewport/Play start and on change. Console `renderquality` still logs. |
| §2.4 editor idle freezes + scene-load shader warm | later polish (`render`) | No `freezeActiveMeshes` / `material.freeze` / `useGeometryUniqueIdsMap`; `forceCompilationAsync` is shader-graph only |
| Context-loss user notify | later polish (`render`, editor) | Restore drops a quality tier and flushes LRU; no one-shot toast |
| Mesh live-object assert on Play close | later polish (`play-session`) | Texture-cache growth is logged; mesh counts are captured unused |
| Snapshot interpolation α in the live loop | documented | `SnapshotInterpolator` can lerp; Play samples α=1 (latest) while render and tick share the 60 Hz cap. Time-based α waits on a render/tick mismatch |
| Log Error → session report | Done (this branch) | `ctx.log(..., "error")` pushes `runtime.log` diagnostics |
| ExecuteJavaScript `bodyLine` navigation | Done (this branch) | Hoisted body lines carry `bodyLine`; session report focuses CodeMirror |

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
| Type assets | `p5-types` | `assets` (schemas), `object-model` (FunctionLibrary / EditorFunctionLibrary bases), `apps/editor`, `editor-kit` | Pin type system |
| Validation UX | `p5-graph-validation` | `apps/editor`, `graph-ui`, `scripting` fixtures, Content Browser overlay | Validator + Compiler Results UI |

Design notes: [scripting.md](../architecture/scripting.md).

**Parallelism:** after `p5-scripting-core` lands its types and a failing/passing golden harness, catalog categories may run as separate PRs (one package ownership set per agent). Do not start `p5-graph-ui` and `p5-scripting-core` against competing IR shapes — core owns the IR contract first.

**P5 status:** all checklist slices (`p5-*`) are landed. Canvas pin hydration, palette pin embedding, Begin Play/Tick defaults, and Add/Remove node undo commands are landed (authoring loop fix). Residual work is polish and phase-owned stubs below. Do **not** reopen a parallel "build visual scripting" phase ahead of P8; schedule polish opportunistically or after the debugger console lands.

### P5 follow-ups / open deferrals

| Item | Owner | Notes |
| --- | --- | --- |
| Pin flash on tap-to-navigate | later polish (`graph-ui`, editor) | Selects + fits node; pins carry `data-error` but no flash yet |
| Class re-parent UX | later polish (`apps/editor`, object-model) | `ClassRegistry.reparent` exists; Class panel has no change-parent UI |
| ExecuteJavaScript editor gaps | later polish (`apps/editor`) | Identifier uniqueness / `execJs_` prefix, Inspector async toggle, lazy CodeMirror chunk, import disclosure of JS bodies |
| Engine Settings “don’t ask again” | later polish (`apps/editor`) | Play Anyway exists; no permanent skip preference |
| Class / outliner validation icons | later polish (`apps/editor`) | `hasError` on Class members is never set |
| Project-wide pre-Preview validation sweep | later polish (`apps/editor`, `scripting`) | Play now validates the compiled project graph set (`collectPlayPreviewScripts`); startup-map / GameInstance / plugin EUO sweep still deferred |
| Validator fixture per diagnostic code | later polish (`scripting`) | CI has `type.mismatch` and `js.parse` fixtures; other codes are unit-tested |
| Latent nodes as async generator state machines | later polish (`scripting`) | Host promises today; Delay / async ExecuteJavaScript still run |
| ExecuteConsoleCommand registry + debug-tier warnings | P8 | Landed (`p8-command-system`) |
| BDebugCommand + parameter list | P8 | Landed (`p8-bdebugcommand`) |
| Play console + stats HUD | P8 | Landed (`p8-console-hud`) |
| Trace recorder / `.babtrace` | P8 | Landed (`p8-trace-recorder`) |
| Keyed Print HUD polish | P8 / export | Print works; HUD polish deferred |
| Development Only node flag | Done | Inspector checkbox; Print defaults on; `compileGraphDocumentsForExport` skips the node and continues exec (`then` / Sequence `then_*`). P14 release export must call that helper |
| AI / navigation scripting nodes | P11 | Catalog categories wait for behaviour trees + navmesh |
| Audio / UI node runtime helpers beyond stubs | P9 / P16 | `setWidgetVisible` / `applyUserInterface` / `removeUserInterface` emit UI commands; Play Sound / Set Channel Volume / Set Global Volume emit audio commands (P16 Done) |

**Closed (authoring loop):** host `__pins` hydration + palette pin payload; `AddNodeCommand` / `RemoveNodeCommand`; new graphs seed Begin Play + Tick via `createDefaultLogicGraphSerialized`; **drag-to-connect** (`onConnect` / connect-end palette) plus tap-to-connect; **Format** (exec highway / independent chain roots); **hold-to-marquee** (`attachGraphPaneMarquee`).

**Closed (class-owned graphs):** logic graphs live on Class assets (`.class.babasset`); New Asset is authored-only; Prefab/Components are Actor-lineage only; Enum/Structure/ScriptInterface open DockView documents (import data types stay compact `asset-settings` tabs). Legacy Graph files still load.

**Closed (`cursor/ui-logic-graph-pass-2e3e`):** FunctionLibrary static Call Function palette (open docs + `header.payload.functions`); EditorFunctionLibrary engine base; UI Designer | Logic mode bar with Class docks on `payload.logic`; `NodeDefinition.editorOnly` + Editor Only tape; Add Node Context Sensitive (host-legal catalog; pin filter only when on).

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
| Lighting and cameras (direction, Play color/intensity, `shadowquality` → one ShadowGenerator, game camera) | Done (`p-lighting-camera` + default skybox) | Incremental `authoredLight`/`authoredCamera`; direction from actor rotation × `(0,0,1)`; Play color/intensity/range/cone; detached `UniversalCamera`; named Default Camera (`SceneComponentPicker`); Possess Camera; one `ShadowGenerator` from `shadowquality` (`off`/`512`/`1024`/`2048`); fog/IBL; `environmentColor` clear; **SkyboxComponent** mesh (not IBL) + 3D default locked Skybox and daylight directional light. Spec: [engineplan §2.5](../engineplan.md). |
| Place Actors drag-to-viewport / raycast drop | later polish | Outliner **+** click-to-spawn shipped; drag from catalog is out of scope |
| Gamepad rumble (`setGamepadRumble`) | P9 / input polish | Runtime logs only; no `vibrationActuator` yet |
| Structured Input mappings editor (vs raw JSON) | Done | Project Settings Input is `InputMappingEditor` (searchable code picker); no JSON textarea |
| Multi-select gizmo (transform all selected) | Done | Outline covers all; gizmo attaches to the first pickable selection root; world-space TRS delta follows onto the other roots; `SetActorsTransformsCommand` is one undo |

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

P9 content systems have landed (`p9-ui-anchoring`, `p9-fonts`, `p9-ui-system`, `p9-widget-library`, `p9-sprite`, `p9-anim-graph`, `p9-shader-graph`). Do **not** rebuild P9 packages. Authoring-surface hosts (canvas gestures, Logic palette, Sprite Texture picker, `NodeMaterial.Parse` preview) landed on `cursor/authoring-surface-8678`. Expression-only Custom GLSL (`CustomBlock`) landed on `cursor/material-shader-improvements-fa96`. Residual ADT mesh HUD / a richer GLSL IDE stays later polish.

| Slice | Checklist | Packages | Depends on |
| --- | --- | --- | --- |
| Design notes | — | `docs/architecture/ui-runtime.md`, `fonts.md`, `sprites.md`, `anim-graph.md`, `shader-graph.md` | P8 complete |
| Anchoring + layout | `p9-ui-anchoring` (done) | `ui-runtime` | Design notes |
| Font payload + registry | `p9-fonts` (done) | `assets`, `core`, `render`, `ui-runtime`, `apps/editor` | Design notes |
| UserInterface + designer | `p9-ui-system` (done) | `ui-runtime`, `render`, `bridge`, `runtime`, `apps/editor`, `edit` | Anchoring + fonts |
| Widget library + touch axis | `p9-widget-library` (done) | `ui-runtime`, `input`, `apps/editor` | UI system |
| Sprite packer + quad | `p9-sprite` (done) | `assets`, `render`, `apps/editor` | Design notes |
| AnimationGraph | `p9-anim-graph` (done) | `anim-graph`, `runtime`, `render`, `graph-ui`, `scripting`, `apps/editor` | Dual-mode State Machine / Animation Object host, typed variables, compiled transition rules |
| Shader graph | `p9-shader-graph` (done) | `shader-graph`, `render`, `graph-ui`, `apps/editor` | Design notes + graph-ui host |

Design notes: [ui-runtime.md](../architecture/ui-runtime.md), [fonts.md](../architecture/fonts.md), [sprites.md](../architecture/sprites.md), [anim-graph.md](../architecture/anim-graph.md), [shader-graph.md](../architecture/shader-graph.md).

### P9 Play-path residuals (do not rebuild P8/P9)

Chrome polish (pin flash) stays parked. Multi-select gizmo group transforms are Done. Remaining Play/scripting holes were closed by the pre-P11 foundation wave on `cursor/foundation-harden-e9a2` (do not rebuild P8/P9 packages).

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
| F — Anim Graph Parameters / States / Details host | Done (`cursor/anim-graph-authoring-6e70`); dual-mode State Machine \| Animation Object + compiled rules on `cursor/complete-animation-graph-9a46` |
| G — Behaviour tree Details / catalogs / tree ops / honest Loop-Cooldown-TimeLimit | Done (`p-bt-editor-authoring`) |
| G2 — Behaviour tree free placement, Auto Arrange, Blackboard / Compiler docks | Done (`p-bt-editor-ux`). Follow-on hosts/nav leftovers are **P18**, not this wave |

Parked with this wave: pin flash, `WidgetComponent` `CreateForMesh`, a richer CustomBlock GLSL IDE (syntax-aware editor beyond the expression Textarea). Assigning a shader to a live scene mesh unparked (`cursor/material-shader-improvements-fa96`). Multi-select gizmo unparked (group TRS follow). FunctionLibrary static Call Function rows unparked (`cursor/ui-logic-graph-pass-2e3e`). UserInterface / EditorUtilityInterface **authoring** editors (Designer | Logic mode bar + dual DockView catalogs + editing-stage Babylon GUI) landed as last P12 (`p12-ui-editors`) and this pass.

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
| UserInterface + EditorUtilityInterface **authoring** editors | Chrome **Designer \| Logic** mode bar; Designer Design / Hierarchy / Details (EUI Settings); Logic Class docks on `payload.logic`. Live EditorUtilityInterface **tabs** stay P12 Dockview + `createUiSurface` from Windows → Editor Utilities | Done (`p12-ui-editors` + `cursor/ui-logic-graph-pass-2e3e`) |
| Animation Graph Object + transition-rule graphs | Chrome **State Machine \| Animation Object**; typed variables; compiled `AnimGraph:` / `AnimRule:` scripts; per-slot `animState` layers; Unreal state nodes + nested Enter/Exit rule graphs | Done (`cursor/complete-animation-graph-9a46`) |

## P10 tilemaps

Design note: [tilemaps.md](../architecture/tilemaps.md). Codecs first, then Rapier chains + Play, then painting / 2D template / acceptance e2e.

| Item | Status |
| --- | --- |
| Tileset / Tilemap payloads, UV math, golden chunk VertexData | Done (`cursor/play-path-harden-8678`) |
| Merged chain colliders + `TilemapComponent` Play load | Done (`cursor/play-path-harden-8678`) |
| Touch painting, one undo per stroke, 2D Create Project card | Done (`cursor/play-path-harden-8678`) |
| Play asserts a falling actor settles on painted tiles | Done (foundation wave; keep in-process `tilemap-physics.test.ts`) |
| Editor pick of chunk children + `TilemapComponent` sorting | Done (P10 hardening) |
| Rapier closed loops + Rapier (not software) falling-actor test | Done (P10 hardening) |
| Per-tile collision / animation / flags authoring | Done (P10 hardening) |
| Multi-layer list + runtime sorting / parallax / `:anim` draw set | Done (P10 hardening) |
| Play camera pixel snap; editor pan/zoom stays continuous | Done (P10 hardening) |
| DockView tileset (Preview + Details) and tilemap (Paint + Details) | Done (P10 hardening) |
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
| Sprite/tilemap textures via `ResourceCache`; GLB `assetGuid`; authored lights/cameras | Done (full lighting/camera contract landed in `p-lighting-camera`) |
| Play HUD TouchButton / TouchDPad / default Jump+dpad mappings | Done |
| `playSound` command (logged; no mixer) | Done |
| FunctionLibrary palette nodes | Done (`cursor/ui-logic-graph-pass-2e3e`) — static Call Function rows from open FL docs and `header.payload.functions`; EditorFunctionLibrary editor-only |

## Lighting and cameras (`p-lighting-camera`)

Spec: [engineplan.md](../engineplan.md) §2.5. **Done.** Do not reopen AI packages.

| Slice | Checklist | Packages |
| --- | --- | --- |
| Schema + Details | `p-lighting-camera` | `core` SceneSettings Default Camera (actor+component ids); kit `SceneComponentPicker` with `allowedClassIds`; `apps/editor` Details enums and scene-settings rows |
| Renderer | same | `render` incremental `scene-illumination`, detached UniversalCamera, one ShadowGenerator, fog/IBL/clear, dir/spot gizmos |
| Play | same | `runtime` assign payload; named Default Camera as `activeCamera`; `render` snapshot-apply parity |
| Scripting | same | `scripting-nodes` **Possess Camera** (global `activeCamera`); get/set FOV, ortho size, light enabled/color/intensity |

## P11 behaviour trees / navigation

Foundation-hardening is on `main`. Chrome polish (pin flash) is not P11 work. Multi-select gizmo group transforms are Done. Lighting and cameras (`p-lighting-camera`) are Done. Design notes: [behaviour-tree.md](../architecture/behaviour-tree.md), [navigation.md](../architecture/navigation.md).

| Slice | Checklist | Packages | Depends on |
| --- | --- | --- | --- |
| Design notes | — | `docs/architecture/` | — |
| Tree + evaluator | `p11-behaviour-tree` | `behaviour-tree`, `scripting` (hook) | Design notes |
| BT classes + component | `p11-bt-authoring` | `object-model`, `runtime`, `scripting-nodes` (landed) | Tree package |
| BT editor | `p11-bt-editor` | `graph-ui`, `apps/editor`, `debugger` (landed) | Authoring |
| Nav port + bake | `p11-navigation` | `navigation` (package landed; crowd `addAgent` / `setAgentTarget`) | Design notes |
| Nav editor host | `p11-nav-editor-host` | `apps/editor`, `render`, `runtime` (landed) | Nav package |
| Blockers + 2D + nodes | `p11-nav-blockers-2d` | `navigation`, `scripting-nodes`, `apps/editor`, `runtime` (landed) | Nav editor host |
| §18 acceptance | `p11-acceptance` | `runtime` harness + `e2e/p11-ai.spec.ts` (landed) | Blockers + editor host |

`BehaviourTreeComponent` and `NavAgentComponent` are addable. `NavMeshComponent` and `NavMeshBlockerComponent` are Place Actors only. Auto-bake-on-save stays off by default (Details hides the unwired toggle until **P18**). Dynamic cost volumes do not yet affect path cost (**P18**). RotateToFace / PlayAnimation succeed without a host until **P18**. PlaySound waits on **P16 Audio**. **P11 is Done** (packages + §18). Do not uncheck P11; P18 is additive.

## Behaviour tree editor authoring (`p-bt-editor-authoring`)

Authoring-surface residual, same class as the Anim Graph host pass. Do **not** uncheck `p11-bt-editor`. Packages: `apps/editor`, `graph-ui`, `behaviour-tree` (eval + validate only).

| Slice | Checklist | Packages | Depends on |
| --- | --- | --- | --- |
| Typed Details + catalogs | `p-bt-editor-authoring` | `apps/editor`, `graph-ui` | `p11-bt-editor` |
| Tree ops + canvas diagnostics | same | `apps/editor`, `graph-ui`, `behaviour-tree` (validate) | Details |
| Loop/Cooldown/TimeLimit + Play stack overlay | same | `behaviour-tree` (eval), `bridge`/`runtime` `btState.stack`, `e2e/p11-ai.spec.ts` | Tree ops |

Out of scope: RotateToFace / PlayAnimation hosts (**P18**); PlaySound (**P16 Audio**); nav cost-carve / auto-bake (**P18**); Dockview for asset tabs; large-graph virtualisation (**P17**); P12; lighting.

## Behaviour tree editor UX (`p-bt-editor-ux`)

Authoring-surface residual. Do **not** uncheck `p11-bt-editor` or `p-bt-editor-authoring`. Packages: `behaviour-tree` (layout field only), `graph-ui`, `apps/editor`. Runtime evaluator is unchanged.

| Slice | Checklist | Packages | Depends on |
| --- | --- | --- | --- |
| Optional `editorPositions` + stable X sibling reorder + Auto Arrange | `p-bt-editor-ux` | `behaviour-tree` | `p-bt-editor-authoring` |
| GraphEditor `connectEndMode="add-node"` + TreeNode chrome | same | `graph-ui` | connect policies |
| Blackboard / Compiler Results docks, free drag, one-undo moves | same | `apps/editor`, `e2e/bt-editor.spec.ts` | GraphEditor policies |

Out of scope: changing `children[]` semantics at runtime; 96px cancel / wire-break on script, material, or anim graphs; large-graph virtualisation (**P17** `p17-graph-virtualize`); reopening P11; RotateToFace / PlayAnimation hosts (**P18**); PlaySound (**P16 Audio**).

## Behaviour tree class events (`p-bt-class-events`)

Authoring-surface residual. Do **not** uncheck `p11-bt-authoring`. Packages: `apps/editor`, `scripting-nodes`, `behaviour-tree`, `runtime`.

| Slice | Checklist | Packages | Depends on |
| --- | --- | --- | --- |
| Class Events + palette by ancestry | `p-bt-class-events` | `apps/editor` | `p11-bt-authoring` |
| Decorator host, abort, Return Condition, blackboard nodes | same | `behaviour-tree`, `scripting-nodes`, `runtime` | Class events |
| Composite kind from ancestry + e2e | same | `behaviour-tree`, `e2e/p11-ai.spec.ts` | hosts |

Out of scope: scripted custom composite VMs; RotateToFace / PlayAnimation hosts (**P18**); PlaySound (**P16 Audio**); reopening P11; P12; lighting.

## P12 editor extensions

Spec: [engineplan.md](../engineplan.md) §7 (Windows → Editor Utilities; live vs author), §18 P12, Appendix A `p12-editor-extensions` then `p12-ui-editors`. Lighting/cameras (`p-lighting-camera`) is Done. Design notes: [editor-extensions.md](../architecture/editor-extensions.md).

| Slice | Checklist | Packages | Depends on |
| --- | --- | --- | --- |
| EditorUtilityObject + live Interface tabs | Done (`p12-editor-extensions`) | `object-model`, `apps/editor`, `render` (Dockview Babylon GUI host via `createUiSurface`), export strip | P11 done |
| UserInterface + EditorUtilityInterface **authoring** editors | Done (`p12-ui-editors`) | `apps/editor` (designer Dockview host), `render` (`presentAdtToCanvas` / `createUiSurface`) | `p12-editor-extensions` |
| Lighting / cameras | Done (`p-lighting-camera`) | `render`, `core`, `runtime`, `apps/editor`, `scripting-nodes` | §2.5 landed |

**Live vs author:** Windows → Editor Utilities opens a **live** Dockview tab that presents Babylon GUI (ADT copy, never `registerView`) — that is `p12-editor-extensions`. Content Browser opens **authoring**. UserInterface and EditorUtilityInterface share one host (`p12-ui-editors`): chrome **Designer | Logic** mode bar, Designer Design / Hierarchy / Details, Logic Class docks, editing-stage widgets paint on a healthy Engine, EUI `dockKind` Settings. Do not rebuild `@babylonslate/ui-runtime`.

Follow-up (`cursor/ui-logic-graph-pass-2e3e`): dual DockView surfaces (`layout.json` `{ uiEditorMode, designer, logic }`); leftover `ui-logic` panel closed on restore; FunctionLibrary / EditorFunctionLibrary static Call Function unparked; `NodeDefinition.editorOnly` + Editor Only tape; Add Node Context Sensitive.

Do not start leftover chrome polish (pin flash).

## P13 plugins

Spec: [engineplan.md](../engineplan.md) §10, Appendix A `p13-*`. Design note: [plugins.md](../architecture/plugins.md).

| Slice | Checklist | Packages | Depends on |
| --- | --- | --- | --- |
| PluginSettings + PluginHost | Done (`p13-plugin-model`) | `core`, `assets` | P12 done |
| Settings UI + Show Plugin Content | Done (`p13-plugin-settings-ui`) | `apps/editor`, `editor-kit` | plugin model |
| `.babplugin` export/import | Done (`p13-babplugin`) | `assets`, `apps/editor` | plugin model |
| Starter Content + e2e | Done (`p13-engine-plugin`) | `engine-plugins/`, `apps/editor`, `e2e/p13-plugins.spec.ts` | `.babplugin` |

**P13 is Done.** Native plugins, marketplace, packed itch export (`p14-*`), and Content Browser drag between roots are out of scope (cross-root move is a design note in `plugins.md`).

## P15 source control

Spec: [engineplan.md](../engineplan.md) §12, Appendix A `p15-*`. Design note: [source-control.md](../architecture/source-control.md).

| Slice | Checklist | Packages | Depends on |
| --- | --- | --- | --- |
| LockProvider + Git LFS client + Fake + secrets/HTTP | Done (`p15-lock-provider`) | `source-control`, `core` (`sourceControl` settings), `vfs` (SecretStore, nativeHttp), `apps/desktop` IPC | P14 done |
| Settings, auto-lock, advisory open, CB decoration, Locks panel | Done (`p15-lock-ux`) | `apps/editor`, `source-control` | lock provider |
| Foreground mtime rescan + reload prompts | Done (`p15-external-change`) | `assets` (`IndexedAsset.mtime`), `apps/editor` | lock UX |

**P15 is Done** in CI (FakeLockProvider + Playwright). Two-device GitHub lock visibility and Working Copy branch-switch on a real iPad remain **manual** native acceptance. Out of scope: git clone/commit/pull/push UI, `lockable` in `.gitattributes`, git status badges, CORS proxy, web production source control. Review follow-up (`cursor/p15-review-fixes-419b`): 409 already-ours via verify, rename/folder lock ops, iOS Keychain plugin compile wiring.

Hardening on `cursor/p15-source-control-gaps-44b6`: Git LFS create 409 now consults verify so a lock we already hold is not treated as theirs after restart; auto-lock skips create when verify already lists the path as ours; deleting an asset we hold unlocks that path; the iOS Keychain plugin is in the App target and `packageClassList` (it was an uncompiled Swift file).

## P16 Audio engine

Spec: [engineplan.md](../engineplan.md) §2.6 / §18 / §19, Appendix A `p16-audio-*`. Design note: [audio.md](../architecture/audio.md). Imported Audio is the one sound asset; AudioMixer, AudioChannel and SoundAttenuation are user-created assets. No mixer/channel/attenuation remains a supported playback path.

| Slice | Checklist | Packages | Depends on |
| --- | --- | --- | --- |
| Asset schemas, references, migrations, Project Settings mixer | Done (`p16-audio-assets`) | `core`, `assets`, `exporter` | P15 done |
| Audio and routing-asset editors; AudioComponent | Done (`p16-audio-authoring`) | `apps/editor`, `editor-kit`, `object-model` | audio assets |
| AudioV2 service, cache, unlock, editor/player routing | Done (`p16-audio-runtime`) | `render`, `bridge`, `runtime`, `apps/editor`, `apps/player` | audio assets |
| SoundAttenuation emitters and listener | Done (`p16-audio-spatial`) | `render`, `runtime`, `apps/editor` | runtime + authoring |
| Automatic geometry reverb bake and bounded shared effect | Done (`p16-audio-reverb-bake`) | `render`, `assets`, `apps/editor`, `exporter` | runtime + audio channels |
| Typed Play/Set Channel/Set Global nodes + BT PlaySound host | Done (`p16-audio-nodes-bt`) | `scripting`, `scripting-nodes`, `runtime`, `behaviour-tree`, `apps/editor` | runtime + assets |
| Cross-package no-config/mixer/spatial/reverb/export proof | Done (`p16-audio-acceptance`) | unit + integration + Playwright/export smoke | all P16 slices |

**P16 is Done.** Real-device listening remains **manual**; CI covers routing, gain, unlock, spatial parameters, bake identity, and teardown. Out of scope: streaming music, microphone capture, authored acoustic zones/materials, runtime acoustic ray tracing, waveform editing, DSP plugins and exact impulse-response simulation.

## P17 iPad editor optimisation

Spec: [engineplan.md](../engineplan.md) §2.4 / §18 / §19, Appendix A `p17-*`. **Next phase.** P16 is Done. No `p1-device-spikes` gate. Pin flash stays parked chrome polish. Nav bake collect stays **P18**. Collapse-inactive-subtree / cap-auto-layout stay parked.

| Slice | Checklist | Packages | Depends on |
| --- | --- | --- | --- |
| Idle-unmount background chrome tabs (2 min grace, cap 3) | `p17-inactive-documents` | `apps/editor` (`document-workspace`, UI/Anim docks) | P16 done |
| Off-screen node virtualisation for every `GraphEditor` host | `p17-graph-virtualize` | `graph-ui`, hosts in `apps/editor` | P16 done (can parallel) |
| Windowed Add Node catalog body (~1000 nodes) | `p17-add-node-virtualize` | `graph-ui` (`NodePalette`); optional `editor-kit` list helper | P16 done (can parallel) |
| Windowed Content Browser grid + revoke off-screen thumbs | `p17-content-browser-virtualize` | `apps/editor` Content Browser; `assets` thumbnail LRU | P16 done (can parallel) |
| Prefab Preview on the app-lifetime Engine | `p17-shared-prefab-engine` | `render`, Prefab viewport in `apps/editor` | P16 done (can parallel) |

Out of scope: collapse-inactive-subtree / cap-auto-layout; P18 BT/nav leftovers; pin flash; bake-collect hitch; Place Actors / Add Component / Add Widget / Settings catalogs.

## P18 Behaviour tree hosts and navigation leftovers

Spec: [engineplan.md](../engineplan.md) §14, Appendix A `p18-*`. Additive on Done P11. Do **not** uncheck `p11-*`. Do not start until P17 is marked Done.

| Slice | Checklist | Packages | Depends on |
| --- | --- | --- | --- |
| RotateToFace + PlayAnimation runtime hosts | `p18-bt-task-hosts` | `behaviour-tree`, `runtime`, `apps/editor` | P11 hosts; P17 Done |
| Auto-bake-on-save, bake bounds, cost volumes | `p18-nav-leftovers` | `navigation`, `apps/editor`, `runtime` | `p11-nav-blockers-2d`; P17 Done |

Out of scope: rebuilding BT **PlaySound** (P16); scripted custom composite VM; reopening P11 evaluator/abort matrix; `p1-device-spikes`. Crowd MoveTo is already live.



