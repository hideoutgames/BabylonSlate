# Exporter

Export Game and Preview Build: the headless `@haptic/exporter` closure and packer, the `game.json` catalog, and the `apps/player` host that boots it.

## Decisions

- `@haptic/exporter` imports no React, Babylon or Capacitor. Callers compile graphs and load payloads; the package tree-shakes, packs and emits files.
- The only export target is a web/itch.io zip. Capacitor and Electron host the **editor**, not shipped games; there are no native exported games.
- Packaged games always boot `project.json` `startupSceneGuid` (an asset guid). Never boot or tree-shake from `HprojectManifest.startupScene` or a guessed `assets/main.scene.hasset`. A missing or stale startup scene fails with `MISSING_STARTUP_SCENE_MESSAGE` ("Set Startup Scene in Project Settings."). Overlay Play and Preview Build may seed the open Scene tab for that session only (Debug **Start In Open Scene**, default on); Export Game never does.
- Every export writes independent `assets/data-<n>.bin` files with `assetCatalogVersion: 1`; there is no packed/loose choice and no `mode` field. ZIP is delivery only, not a runtime archive. Static hosting needs no HTTP Range support.
- Export Game and Preview Build share one closure and compile path (`collectAndExportGame`). A reached asset that fails to load, has a non-current format version, or whose Class / Animation Graph codegen throws fails the export by name; nothing ships silently without it.
- Preview Build packs PNG/pixels, never KTX2 (`shouldPackKtx2ForPreviewBuild()` is false), so a cold iframe matches overlay Play; Export Game packs KTX2 only when the full self-hosted transcoder ships.
- No game HUD keys in `GameManifest`; the player never hydrates a HUD and never packs EditorUtilityInterface assets.

## Ownership

| Area | Source |
| --- | --- |
| Roots and reachability (`selectExportRoots`, `collectExportReachability`, `collectHeaderReachability`) | [`closure.ts`](../../../packages/exporter/src/closure.ts) |
| `exportGame`, `zipExport`, `parseGameManifest` | [`export-game.ts`](../../../packages/exporter/src/export-game.ts) |
| Physics/transcoder file selection | [`player-files.ts`](../../../packages/exporter/src/player-files.ts) |
| Sidecar types, guid prefixes, file-count defaults | [`constants.ts`](../../../packages/exporter/src/constants.ts) |
| Runtime catalog, source content, hydrate shared with editor Play | [`asset-catalog.ts`](../../../packages/exporter/src/asset-catalog.ts), [`source-content.ts`](../../../packages/exporter/src/source-content.ts), [`hydrate.ts`](../../../packages/exporter/src/hydrate.ts) |
| Preview handoff and per-file requests | [`preview-protocol.ts`](../../../packages/exporter/src/preview-protocol.ts), [`preview-assets.ts`](../../../packages/exporter/src/preview-assets.ts), [`preview-save-storage.ts`](../../../packages/exporter/src/preview-save-storage.ts) |
| Editor export, plugin layer 3, document loading | [`apps/editor/src/services/export-game.ts`](../../../apps/editor/src/services/export-game.ts), [`export-game-inputs.ts`](../../../apps/editor/src/services/export-game-inputs.ts) |
| Player host URLs | [`apps/editor/src/lib/player-host-url.ts`](../../../apps/editor/src/lib/player-host-url.ts) |
| Player boot, backend, worker host | [`apps/player/src/`](../../../apps/player/src/) `boot.ts`, `player-backend.ts`, `worker-host.ts`, `hydrate.ts` |

## Closure

- Not `header.dependencies` alone (scene saves often leave them empty). Roots: `startupSceneGuid`, `gameInstanceClass`, Project Settings `audioMixerGuid`, Input assets, debug commands, every Class whose parent chain reaches `GameSubsystem` / `SceneSubsystem` (`subsystemBaseClassIdOf`), and every asset under Project Settings `alwaysPackageFolders`. A listed Scene starts its own closure.
- Export-preset `pluginOverrides` apply **before** the walk, so disabled plugin roots are absent ([plugins.md](plugins.md)). `isEditorOnlyAsset` strips PluginSettings, SkyboxCreator, EditorUtilityObject / EditorFunctionLibrary and leftover EditorUtilityInterface.
- The walk reads only typed reference fields (asset guids, or a Class compile id from its file stem via `classIdForAssetPath`); display names never resolve and ordinary strings are never searched for guid text. It follows payload fields (sprite `textureGuid`, overlay 2D guids including RichText `[img]`), asset-typed variable and pin defaults, Class `parentClass` metadata, Model slots → Material → Texture, to a fixed point.
- Reachability includes deferred references; the manifest separately records `requiredDependencies`. Startup acquires only the entry Scene and declared project systems; inclusion never implies startup loading.
- Release exports compile with `stripDevelopmentOnly`; Preview Build and `bundleDebugger: true` presets keep Development Only nodes. Each Class compiles under `classIdForAssetPath`; subsystems need no manifest field because the runtime discovers them from the scripts.
- `loadExportDocuments` reads each asset's document and chunks from one saved version (`loadDocumentWithChunks`), so a save or encode between reads cannot mix versions. The Scene reverb flush runs first and is never superseded by edits or Auto-Save ([audio.md](audio.md)).

## Files and catalog

```
index.html          # player CSS inlined; itch requires it at the zip root
player.js           # code splitting off; workers stay separate files
game.json           # catalog: required dependencies, paths, byte lengths, SHA-256
assets/data-<n>.bin # one per asset or sidecar
coi-serviceworker.js, havok/ (3D), assets/rapier-*.js (2D or physics SceneLayers), ktx2/, draco/, meshopt/
```

- Sidecars use typed ids: `navmesh:<sceneGuid>` (`NavMesh`), `audioReverb:<sceneGuid>`, `font-facetype:`, `font-msdf:`, `font-msdf-png:`, area emission. Packed Audio is a **BSAU** envelope, packed Model a **BSMO** envelope (payload incl. `importScale`, `materialSlots`, `autoLod` + GLB).
- `selectPlayerRuntimeFiles` keeps Havok for 3D, Rapier for 2D, and Rapier in 3D only when a reached SceneLayer enables physics (an unreadable layer keeps it).
- Filenames stay distinct on case-insensitive filesystems and cannot contain separators or Windows reserved names. File count warns at 800 and fails at 1000 by default (preset-overridable) because itch caps uploads.
- `zipExport` uses a fixed local-noon 1980-01-01 mtime (`SAFE_ZIP_MTIME`): UTC midnight is 1979 west of UTC and DOS dates reject it.
- `game.json` carries `project: { name, version }` (Get Project Name / Version; the player refuses a manifest without it), `render` normalized by `normalizeRenderProjectSettings`, `playFrameCap`, 2D settings, `physicsWorld`, audio settings, and `assets[]` with `assetPath` for authored entries. Debugger loop settings appear only when `bundleDebugger` is true. `parseGameManifest` rejects outdated manifests and asks for a rebuild.

## Player

- `apps/player` is a Vite canvas host: runtime, render, bridge, physics, debugger; no DockView, editor chrome or React shell. It owns its own Engine (never `registerView` onto the editor Engine). One private constructor canvas owns the context; the visible canvas uses the shared-view path.
- It loads current exports only (SHA-256 `revision` on every entry, BSMO/BSAU envelopes, prefixed sidecars). Startup reads the entry Scene closure plus startup-required assets; everything else is read on acquire. `AssetLoadingService` publishes sources only after the required closure succeeds.
- Boot hydrates packed Sprite, Tilemap, Animation, Behaviour Tree, Material, Material Function, particle and audio payloads into `createEngine` and the worker before `play`, then waits for model instances, sample-ready textures and `prewarmSceneMaterials`. KTX2 decodes on the main thread with `forceRGBA`.
- Debug commands and the stats HUD follow `bundleDebugger`; Print and Draw Debug always apply; Line Trace debug lines follow `traceDebugDraw: manifest.bundleDebugger`. Engine Settings `postProcessingEnabled` is never read by the player.
- Stop, fatal load failure and startup rollback share one release path; the backend Engine is disposed after the view release settles or 5 s pass. Worker failures report `player.worker.failed`; late disposal failures `player.cleanup.failed`.

## Preview Build

- Toggle in the Debug menu (`debuggerDefaults.previewBuild`, default off). It always bundles the debugger and runs the hosted player in a same-origin iframe. The pack lives in memory, is rebuilt every time, and is never written into the project.
- Handoff is a handshake: the player posts `PREVIEW_REQUEST_PACK_MESSAGE` once listening and the editor answers (re-sending per request); posting only on iframe `load` raced module evaluation. The iframe receives only `game.json` and requests files through `createPreviewAssetClient`. Boot failures post `PREVIEW_ERROR_MESSAGE` and render as an Alert, never a silent black frame.
- `canSendPreviewPack` refuses replies after Stop; a `runtime.infinite_loop` diagnostic closes Preview like Stop. The player keeps at most 1000 posted diagnostics.
- Player URLs go through `playerHostBase()` / `playerPreviewSrc()` with `import.meta.env.BASE_URL`; hardcoding `/player/` breaks sub-path deployments such as Pages. `loadPlayerDistFiles` accepts only relative paths inside the player root and rejects dot-named parts; the player build's `player-files.json` omits dot-named files (`ktx2/.keep`), as desktop staging drops those markers.
- The handshake carries the Engine Settings Trace Memory Budget; standalone games use the runtime default (128 MiB). Save storage is forwarded to the editor host ([save-games.md](save-games.md)).
