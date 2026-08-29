# Exporter and packaged player (P14)

Spec: [engineplan.md](../engineplan.md) §15, §15.1, §15.2. Implementation: `@babylonslate/exporter` (headless packer), `apps/player` (Vite canvas host), editor **Export Game** and **Preview Build**.

Overlay Play (shared Engine, `registerView`) stays the default. Packaged **itch zip / Export Game** always starts from `project.json` `startupSceneGuid` (asset guid). Overlay Play and Preview Build seed that guid when Debug **Play from Scene** is off, or when it is on and no scene tab is open; otherwise they seed the open scene for that session only. Do not boot or tree-shake from `BabprojectManifest.startupScene` or `assets/main.scene.babasset`.

## Package (`@babylonslate/exporter`)

No React, Babylon, or Capacitor. Callers compile graphs and load payloads; the package tree-shakes, packs, and emits files.

| Export | Role |
| --- | --- |
| `collectExportClosure` | BFS from `startupSceneGuid` plus GameInstance class; walks scene/graph JSON (including `settings.sceneLayers` and Create Scene Layer pin defaults) and Sprite/Tilemap/SceneLayer payloads; strips `isEditorOnlyAsset`; skips disabled plugin roots |
| `exportGame` | Default `mode: "packed"`; writes `game.json`, `scripts.js`, packs, player files |
| `selectPlayerRuntimeFiles` | Havok **or** Rapier wasm/JS matching `physicsWorld`; drops `README.md` / `.keep` |
| `zipExport` | `fflate` zip with `index.html` at the root (itch). Fixed **local noon 1980-01-01** `mtime` (DOS dates use local getters; UTC midnight fails west of UTC with `date not in range 1980-2099`) |
| `encodeBabpack` / `decodeBabpack` / `decodeBabpackIndex` | Concatenated asset bytes + JSON index `{ guid, offset, length, hash }` (`BPK1`) |
| `createHttpPackSource` / `createMemoryPackSource` | Range-first HTTP loader with whole-body fallback; in-memory Preview Build source |
| `concatenateScripts` / `serializeScriptRegistry` | One `scripts.js` (unminified). Concatenation adds `//# sourceURL` prefixes; ScriptHost evals **per-class** `script.source`, so the registry keeps original `CompileAnchor.line`. |
| Preview protocol | `previewPackFromFiles` / `filesFromPreviewPack` — transfer a `Map` of files into the iframe; never write a pack into the project tree |

Missing or stale startup scene: `MISSING_STARTUP_SCENE_MESSAGE` (`Set Startup Scene in Project Settings.`).

## Export closure

Not `header.dependencies` alone — scene saves often leave those empty.

1. Apply export-preset `pluginOverrides` (layer 3) **before** the walk so disabled plugin roots are absent.
2. Seed with `startupSceneGuid` (must be a Scene asset) **and** Project Settings `audioMixerGuid` the same way `gameInstanceClass` is seeded. Pack `occlusionEnabled` and reverb wet/decay/damping scales from Project Settings Audio.
3. Walk `SerializedScene` actors/components (guids in properties, Mesh/Model `assetGuid`, textures, Font, Class ids) plus scene `gameInstanceClass` **and** the project `gameInstanceClass` when the scene field is empty.
4. Load Class/Graph/Sprite/Tilemap/**SceneLayer** documents; pull asset-typed pin values, `header.dependencies`, payload fields such as sprite `textureGuid` and overlay `2DTexture` / `2DMaterial` / `2DPanel` / `2DText` / `2DRichText` guids (including `[img]` texture guids parsed from markup), and **Scene display names** on Change Scene nodes so leftover `changeScene("Level 2")` graphs still pack that Scene (new graphs store a Scene guid and pack via `enqueueRefs`). SceneLayer overlay actors pack the same closure as a 2D scene. Player `activeScene` still swaps **world** only.
5. Recurse to a fixed point. Drop EditorUtilityObject / leftover EditorUtilityInterface / PluginSettings / SkyboxCreator (`isEditorOnlyAsset`). Generated skybox face Textures stay in the pack when a scene `SkyboxComponent` references them.
6. Scene library keys are **asset guids** in both the pack and overlay Play; display names remain aliases for `changescene`.

Release zip compiles Class/Graph with `compileGraphDocumentsForExport` (skips Inspector **Development Only**), then merges `compileAnimGraphScripts` (`AnimGraph:{guid}` / `AnimRule:{guid}:{id}`). Preview Build and a preset with `bundleDebugger: true` keep Development Only nodes.

Textures: pack `selectTextureChunk`’s chosen variant (KTX2 when present **and** the player file map contains the full self-hosted transcoder: JS decoder, MSC wasm, UASTC→ASTC/BC7/RGBA/R8/RG8, Zstd). If those files are missing, pack source `pixels` (`transcoderAvailable: false`) so itch zip does not bind KTX2 the player cannot decode. **Preview Build always packs PNG/pixels** (`shouldPackKtx2ForPreviewBuild` / `transcoderAvailable: false`) so a cold iframe matches overlay Play on hardware GPUs — Playwright SwiftShader used to pack PNG while desktop Preview packed KTX2 and stayed on the error sampler. Itch **Export Game** still packs KTX2 when the transcoder files exist. Packed Texture index entries also record authored payload `width`/`height` (import pixels, not LOD/GPU bytes) so overlay `2DTexture` layout in the player matches the SceneLayer object. `ResourceCache` tags KTX2 blobs as `image/ktx2` with `forcedExtension: ".ktx2"` and a `#.ktx2` URL suffix so Babylon does not treat a `blob:` URL (or IPv4 host) as a generic image, and passes the bytes as `buffer` so the KTX2 loader does not go through the image decoder. The player then `configureKtx2DecoderRuntime`: main-thread wasm (blob Workers under COEP often fail) and `forceRGBA` for packed play so software GL cannot upload ASTC/BC7. Scene `navmesh` extra chunks pack as sidecar assets (`type: "NavMesh"`, guid `navmesh:<sceneGuid>`) so they do not collide with the Scene JSON guid. Scene `audioReverb` extra chunks pack the same way (`type: "AudioReverb"`, guid `audioReverb:<sceneGuid>`). Packed Audio assets are a **BSAU** envelope (JSON payload + source bytes). Packed Model assets are a **BSMO** envelope (JSON `ModelPayload` including `importScale` and `materialSlots` + GLB source); the player peels that into `modelBytes` + `modelPayloads` so Preview Build and itch export match editor/Play scale. Closure walks Scene mesh `assetGuid` → Model `materialSlots` / `payload` / `dependencies` → Material graph `textureGuid` → Texture (same `payloadByGuid` string walk as Sprite `textureGuid`). Play/player slim embedded GLB rasters **only** when every slot Material’s sampled texture guids exist in packed `textureBytes`; otherwise construction mats keep authored PNG/JPEG instead of the 1×1 red stub. Raw GLB (pre-envelope packs) still loads at import scale 1. Font `facetype-glyphs` packs as `FontFacetype` (`font-facetype:<fontGuid>`) for `Text3DComponent`; Font MSDF JSON/PNG pack as `FontMsdf` / `FontMsdfAtlas` (`font-msdf:<fontGuid>` / `font-msdf-png:<fontGuid>`) for overlay 2D Text. `bytesForAsset` skips those sidecar chunks so the Font guid stays woff/ttf for GUI `FontFace`.

## Packed layout (default)

```
index.html          # CSS inlined; itch requires this at zip root
player.js           # Vite `codeSplitting: false`; workers stay separate files
scripts.js          # class registry (`globalThis.__babylonslateScripts`)
game.json           # GameManifest: startupSceneGuid, render, 2D PPU, packs, assets[]
boot.babpack        # startup scene + assets reached through that scene
scene-<guid>.babpack
coi-serviceworker.js
havok/HavokPhysics.wasm   # 3d only
# or assets/rapier.es-*.js  # 2d only
ktx2/…              # transcoder files the player needs
draco/…             # glTF Draco decoder (KHR_draco_mesh_compression)
meshopt/…           # glTF meshopt decoder (EXT_meshopt_compression)
```

`GameManifest` records `startupSceneGuid`, optional `gameInstanceClass` (project field), `render`, `playFrameCap`, project `twoD.pixelsPerUnit` / `pixelPerfect` (defaults 100 / false), Engine Settings `touchMinTargetPx` (default 44), `packs`, `physicsWorld`, and `assets[]`. Audio fields: optional `audioMixerGuid`, `occlusionEnabled` (default on), and reverb scales (default 1). Font index entries include `name` (authored `family`, else the asset name) so the player can `FontFace(family, bytes)`. The player boot prefers `manifest.gameInstanceClass`, then the startup scene field. When `bundleDebugger` is true the manifest also carries `infiniteLoopDetection` and `loopCount` from Project Settings (defaults on / 1_000_000); release packs omit those keys. `parseGameManifest` fills the defaults for old debugger-bundled `game.json` files and ignores the fields on release manifests. `GameManifest` does not include HUD keys.

`loose` is an explicit preset option (`packed: false`): tree-shaken `assets/<guid>.bin`, no `.babpack`. Wasm, transcoder, and `coi-serviceworker.js` stay real files in both modes.

HTTP loader: probe `Range: bytes=0-7`, then the index, then per-asset ranges. Status `200` (range-blind host) falls back to a whole-pack fetch.

File-count report: warn 800 / fail 1000 (preset-overridable). Export smoke asserts count.

## Export Game vs Export Project

| Action | Output |
| --- | --- |
| **Export Game** (Project Settings) | Itch zip of the packaged player. Failures surface as **Could not build the zip. Try again.** when the cause is a zip/DOS-date error; other messages stay readable. |
| **Export Project** | `.zip` backup of the project directory tree |

Preview packs are in-memory only. Capacitor and Electron host the **editor**, not shipped games.

## `apps/player`

Vite canvas host: `@babylonslate/runtime` + `@babylonslate/render` + bridge/physics/debugger. No Dockview, editor chrome, or React shell. Dedicated Engine (do not `registerView` onto the editor Engine). Boot `startupSceneGuid`; apply `render.customResolution` via the shared `play-preview-aspect` math in `@babylonslate/core` (`playFramebufferSize`): Black Bars on locks WxH and the host **letterboxes** with `fitContainedRect` (never `object-fit: fill`); Black Bars off fills `#player-root` and `resize()` follows the element. Re-layout on `#player-root` resize.

`includeDebugCommands: manifest.bundleDebugger`. Release player uses `createCommandRegistry({ includeDebug: false })`; core commands (`changescene`, …) stay. When the debugger is bundled, a small vanilla DOM HUD (not the editor `PlayOverlay`) shows fps / scriptMs / physicsMs / draws, and boot forwards `infiniteLoopDetection` / `loopCount` on the `load` control message. **Print** (`data-testid="print-overlay"`) and **Draw Debug** always apply — they are not gated by `bundleDebugger`. Stats HUD stays debugger-only. Packed fonts use `FontFace(family, bytes)` — family from the manifest `name`, falling back to the guid; not blob URLs. Facetype sidecars hydrate into `createEngine` `fontFacetypeBytes` for 3D Text. MSDF JSON/PNG sidecars hydrate into `fontMsdfJson` / `fontMsdfPng` for overlay 2D Text. Inline RichText `[img]` textures pack through the SceneLayer closure, not `collectStrings` on the markup string.

Boot hydrates packed **Sprite / Sprite Animation / Tilemap / Tileset / AnimationGraph / Animation / BehaviourTree / Blackboard / Material / Material Function** payloads into `createEngine` and the worker (`loadScripts` when present, then `loadAnimGraphs`, `loadSprites`, `loadTilemaps`, `loadNavMesh`, …) **before** `play`. Packed Texture index `width`/`height` become `texturePixelSizes` on `createEngine` so overlay `2DTexture` planes match the SceneLayer object instead of sniffed GPU/LOD bytes. Packed Model **BSMO** bytes peel into `modelBytes` (GLB) and `modelPayloads` (`importScale`, `materialSlots`) on `createEngine`. Packed Animation JSON fills clip names/durations and stamps Play groups with Animation guids (`modelClipAnimationGuids` / `retargetAnimationLoads`). Material documents, functions, and the startup scene `postProcessStack` go to the Engine; `assignMaterial` is forwarded with mesh/camera commands. After the first `assignMesh`, the player waits for GLB instances (`whenEditorModelsReady`) then sample-ready library textures (`whenMaterialTexturesReady`) then `prewarmSceneMaterials` — the editor viewport already does this; the iframe Engine did not. `activeScene` looks up the packed scene guid and calls `loadScene` / `applySceneEnvironment` so a later `changescene` replaces that stack. Engine Settings `postProcessingEnabled` is editor/Play-only and is not read by the player. In-process fallback registers the same content and runs a rAF `advance` pump; both paths capture canvas input into the input ring. The packaged player does not hydrate a game HUD. EUI assets are never packed.

`?preview=1` waits for a same-origin `postMessage` pack. Destroying the iframe drops that WebGL context.

## Preview Build

Debug-dropdown checkbox only (`debuggerDefaults.previewBuild`, default **off**). Always visible; disabled while Play or prepare is running. **Session** also has **Play from Scene** (`debuggerDefaults.playFromScene`, default **on**). **Off Preview Build:** overlay Play; chrome launch reads **Play**. **On:** chrome launch reads **Preview**; always `bundleDebugger: true`; Preparing Preview modal (Saving → Collecting Assets → Compiling → Writing Pack → Launching); same-origin iframe of the hosted player. Cancel only before the iframe exists. **Stop** is a labeled 44px control layered above the iframe (not a 28px ghost X in a chrome strip). Clicking it posts `PREVIEW_STOP_MESSAGE`, drops the in-memory pack, unmounts the overlay immediately, and shows the session report if diagnostics were posted. A posted diagnostic with `code: "runtime.infinite_loop"` closes Preview the same way without tapping Stop; the player also cancels rAF and stops the worker so the iframe is not left running. Preview diagnostics now carry `code` (and optional `bodyLine`); the editor no longer hardcodes `code: "preview"` when the player sent a real code. `canSendPreviewPack` refuses handshake replies after Stop so a dying iframe cannot relaunch. The packaged player HUD samples fps on the rAF pump (same idea as overlay Play) so fps is not stuck at 0 while ticks climb. Preview Build packs an in-memory `startupSceneGuid` override from the open scene when Play from Scene is on; Export Game never uses that override.

**Player URLs follow the Vite base.** The iframe `src` and `loadPlayerDistFiles` both go through `playerHostBase()` / `playerPreviewSrc()` (`apps/editor/src/lib/player-host-url.ts`), which prefix `import.meta.env.BASE_URL`. Hardcoding `/player/` broke every non-root deployment — GitHub Pages serves the editor from `/BabylonSlate/`, so the iframe fetched the domain root and showed nothing but its own black background. `playerHostVitePlugin` mounts at the same base in dev.

**The pack handover is a handshake, not a single post.** The player posts `PREVIEW_REQUEST_PACK_MESSAGE` once its listener is installed and the editor replies with the pack, resending on each request; posting only on the iframe `load` event raced module evaluation and silently dropped it. Repeat packs are ignored after the first launch. Boot failures post `PREVIEW_ERROR_MESSAGE`, which the overlay renders as an `Alert` (`preview-build-error`) so a failed boot is never an unexplained black frame. A locked framebuffer (Black Bars on, or a live `setRenderResolution`) stays WxH; CSS contain letterboxes it in the iframe so circles stay round. Without a locked framebuffer the player resizes its canvas to the element and observes it for changes (Black Bars off, or Follow System when custom resolution is off). The iframe uses `outline-none` / `focus-visible:outline-none`, and the packaged player sets `canvas:focus { outline: none }`, so a click does not draw a browser focus ring. AudioV2 is created suspended at player boot; the first canvas gesture only resumes / unlocks (no `CreateAudioEngineAsync` on the click turn). When the debugger is bundled, the player shows the same **Click the game view to enable audio** hint while play commands are queued.

## Tests

- Closure BFS (GameInstance, EUO strip, leftover EditorUtilityInterface type strings, plugin disable, sprite `textureGuid` payloads, `audioMixerGuid` → channels / Audio → channel/attenuation), zip `index.html` at root, packed boot + per-scene packs, Havok XOR Rapier, file-count warn/fail, range + whole-fetch dual servers, `pixelsPerUnit` / Font `name` on `game.json`, Scene navmesh and audioReverb sidecars, packed Audio BSAU, packed Model BSMO (`importScale` / `materialSlots`). `GameManifest` does not carry HUD fields.
- Player `packedContentFromGame` hydrates sprite / Sprite Animation / tilemap / navmesh / audioReverb, Material / Material Function, Particle Emitter / Particle System, and **Animation** catalog JSON from the pack (clip names/durations plus `modelClipAnimationGuids` / `retargetAnimationLoads`), plus the startup scene post-process stack. Missing Sprite Animation frame `width`/`height` are filled from packed Texture PNG IHDR bytes. `packedBootControls` emits `loadScripts` then play controls. `loadSprites` carries Sprite Animation documents referenced by packed Animation Graphs.
- `e2e/p14-export.spec.ts`: unzip, serve range-capable **and** range-blind, assert boot + ticks on `startupSceneGuid`, file count &lt; 800, no `main.scene.babasset`, and verify distinct authored parent/child world positions in the live Babylon visuals.
- `e2e/p14-preview-build.spec.ts`: default overlay Play; toggle on/off; chrome launch **Preview** when the checkbox is on; missing startup scene alert; a booted proof (`data-startup-scene` matches the project guid, `data-booted="true"`, ticks advance, player HUD fps not stuck at 0, no `data-error`, canvas laid out) so a black overlay cannot pass again; wait for the overlay **then** `data-booted` (`waitForPreviewBuildBoot`, 60s each) so packing a Kenney GLB on software GL is not charged against the player-tick timeout; the same placement fixture as overlay Play/export; Main Scene Mannequin slot Materials plus tan albedo pixels; and **Stop** restores the editor (overlay and iframe gone, Play enabled, Debug menu visible). Scene/Prefab viewports pause while Preparing Preview is up (`editorViewportPausedForSession`). `preview-build-overlay.test.tsx` pins the labeled 44px Stop above the iframe.
- `apps/editor/vite-player-host.test.ts`: the dev mount follows the configured base and ignores the origin-root path under a sub-path deployment.
