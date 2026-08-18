# Exporter and packaged player (P14)

Spec: [engineplan.md](../engineplan.md) §15, §15.1, §15.2. Implementation: `@babylonslate/exporter` (headless packer), `apps/player` (Vite canvas host), editor **Export Game** and **Preview Build**.

Overlay Play (open scene tab, shared Engine, `registerView`) stays the default. Packaged boot — itch zip **and** Preview Build — always starts from `project.json` `startupSceneGuid` (asset guid). Do not boot or tree-shake from `BabprojectManifest.startupScene` or `assets/main.scene.babasset`.

## Package (`@babylonslate/exporter`)

No React, Babylon, or Capacitor. Callers compile graphs and load payloads; the package tree-shakes, packs, and emits files.

| Export | Role |
| --- | --- |
| `collectExportClosure` | BFS from `startupSceneGuid` plus GameInstance class; walks scene/graph JSON and Sprite/UI/Tilemap payloads; strips `isEditorOnlyAsset`; skips disabled plugin roots |
| `exportGame` | Default `mode: "packed"`; writes `game.json`, `scripts.js`, packs, player files |
| `selectPlayerRuntimeFiles` | Havok **or** Rapier wasm/JS matching `physicsWorld`; drops `README.md` / `.keep` |
| `zipExport` | `fflate` zip with `index.html` at the root (itch) |
| `encodeBabpack` / `decodeBabpack` / `decodeBabpackIndex` | Concatenated asset bytes + JSON index `{ guid, offset, length, hash }` (`BPK1`) |
| `createHttpPackSource` / `createMemoryPackSource` | Range-first HTTP loader with whole-body fallback; in-memory Preview Build source |
| `concatenateScripts` / `serializeScriptRegistry` | One `scripts.js` (unminified). Concatenation adds `//# sourceURL` prefixes; ScriptHost evals **per-class** `script.source`, so the registry keeps original `CompileAnchor.line`. |
| Preview protocol | `previewPackFromFiles` / `filesFromPreviewPack` — transfer a `Map` of files into the iframe; never write a pack into the project tree |

Missing or stale startup scene: `MISSING_STARTUP_SCENE_MESSAGE` (`Set Startup Scene in Project Settings.`).

## Export closure

Not `header.dependencies` alone — scene saves often leave those empty.

1. Apply export-preset `pluginOverrides` (layer 3) **before** the walk so disabled plugin roots are absent.
2. Seed with `startupSceneGuid` (must be a Scene asset) **and** Project Settings `audioMixerGuid` the same way `gameInstanceClass` is seeded. Pack `occlusionEnabled` and reverb wet/decay/damping scales from Project Settings Audio.
3. Walk `SerializedScene` actors/components (guids in properties, Mesh/Model `assetGuid`, textures, UserInterface, Font, Class ids) plus scene `gameInstanceClass` **and** the project `gameInstanceClass` when the scene field is empty.
4. Load Class/Graph/UI/Sprite/Tilemap documents; pull asset-typed pin values (including **Apply User Interface** `UserInterface:<guid>`), `header.dependencies`, payload fields such as sprite `textureGuid`, nested `nestedUiGuid` / `imageGuid` / `materialGuid` (Interface-domain Materials on HUD widgets), Font **family names** on UI `style.fontFamily`, and **Scene display names** on Change Scene nodes so `changeScene("Level 2")` packs that Scene.
5. Recurse to a fixed point. Drop EditorUtilityObject / EditorUtilityInterface / PluginSettings / SkyboxCreator (`isEditorOnlyAsset`). Generated skybox face Textures stay in the pack when a scene `SkyboxComponent` references them. Unused UserInterface assets stay out of the pack.
6. Scene library keys are **asset guids** in both the pack and overlay Play; display names remain aliases for `changescene`.

Release zip compiles Class/Graph **and UserInterface `logic`** with `compileGraphDocumentsForExport` (skips Inspector **Development Only**), then merges `compileAnimGraphScripts` (`AnimGraph:{guid}` / `AnimRule:{guid}:{id}`). Preview Build and a preset with `bundleDebugger: true` keep Development Only nodes. UI graphs compile via `logicGraphFromUiPayload` as `UserInterface:<guid>` / parent `UserInterface` — the same class id overlay Play uses. File-stem `classIdForGraphPath("assets/HUD.ui.babasset")` → `HUD` is **not** the runtime class id.

Textures: pack `selectTextureChunk`’s chosen variant (KTX2 when present) on the Texture guid for GPU materials. When `pixels` or imported `source` exist, also pack a `UiImage` sidecar (`type: "UiImage"`, guid `uiimage:<textureGuid>`) so Babylon GUI Image widgets get a browser-decodable bitmap. Scene `navmesh` extra chunks pack as sidecar assets (`type: "NavMesh"`, guid `navmesh:<sceneGuid>`) so they do not collide with the Scene JSON guid. Scene `audioReverb` extra chunks pack the same way (`type: "AudioReverb"`, guid `audioReverb:<sceneGuid>`). Packed Audio assets are a **BSAU** envelope (JSON payload + source bytes).

## Packed layout (default)

```
index.html          # CSS inlined; itch requires this at zip root
player.js           # Vite `codeSplitting: false`; workers stay separate files
scripts.js          # class registry (`globalThis.__babylonslateScripts`)
game.json           # GameManifest: startupSceneGuid, render, 2D PPU, packs, assets[], optional uiDesignerPresets
boot.babpack        # startup scene + assets reached through that scene
scene-<guid>.babpack
coi-serviceworker.js
havok/HavokPhysics.wasm   # 3d only
# or assets/rapier.es-*.js  # 2d only
ktx2/…              # transcoder files the player needs
```

`GameManifest` records `startupSceneGuid`, optional `gameInstanceClass` (project field), `render`, `playFrameCap`, project `twoD.pixelsPerUnit` / `pixelPerfect` (defaults 100 / false), `packs`, `physicsWorld`, and `assets[]`. Audio fields: optional `audioMixerGuid`, `occlusionEnabled` (default on), and reverb scales (default 1). Font index entries include `name` (authored `family`, else the asset name) so the player can `FontFace(family, bytes)`. The player boot prefers `manifest.gameInstanceClass`, then the startup scene field. When `bundleDebugger` is true the manifest also carries `infiniteLoopDetection` and `loopCount` from Project Settings (defaults on / 1_000_000); release packs omit those keys. `parseGameManifest` fills the defaults for old debugger-bundled `game.json` files and ignores the fields on release manifests.

`loose` is an explicit preset option (`packed: false`): tree-shaken `assets/<guid>.bin`, no `.babpack`. Wasm, transcoder, and `coi-serviceworker.js` stay real files in both modes.

HTTP loader: probe `Range: bytes=0-7`, then the index, then per-asset ranges. Status `200` (range-blind host) falls back to a whole-pack fetch.

File-count report: warn 800 / fail 1000 (preset-overridable). Export smoke asserts count.

## Export Game vs Export Project

| Action | Output |
| --- | --- |
| **Export Game** (Project Settings) | Itch zip of the packaged player |
| **Export Project** | `.zip` backup of the project directory tree |

Preview packs are in-memory only. Capacitor and Electron host the **editor**, not shipped games.

## `apps/player`

Vite canvas host: `@babylonslate/runtime` + `@babylonslate/render` + bridge/physics/debugger. No Dockview, editor chrome, or React shell. Dedicated Engine (do not `registerView` onto the editor Engine). Boot `startupSceneGuid`; apply `render.customResolution` (WxH framebuffer; the host **letterboxes** with `fitContainedRect` and re-layouts on `#player-root` resize — never `object-fit: fill`) via the shared `play-preview-aspect` math in `@babylonslate/core`.

`includeDebugCommands: manifest.bundleDebugger`. Release player uses `createCommandRegistry({ includeDebug: false })`; core commands (`changescene`, …) stay. When the debugger is bundled, a small vanilla DOM HUD (not the editor `PlayOverlay`) shows fps / scriptMs / physicsMs / draws, and boot forwards `infiniteLoopDetection` / `loopCount` on the `load` control message. Packed fonts use `FontFace(family, bytes)` — family from the manifest `name`, falling back to the guid; not blob URLs. The HUD also calls `applyFontRegistryToHost` on the Layer ADT after attach so the first frame after load is dirty. Engine Settings `uiDesignerPresets` pack onto `game.json` so Preview Build / export merge the same Safe Area list as overlay Play.

Boot hydrates packed **Sprite / Sprite Animation / Tilemap / Tileset / AnimationGraph / BehaviourTree / Blackboard / Material / Material Function / UserInterface** payloads into `createEngine` and the worker (`loadUserInterfaces` before `loadScripts`, then `loadAnimGraphs`, `loadSprites`, `loadTilemaps`, `loadNavMesh`, …) **before** `play`. Material documents, functions, and the startup scene `postProcessStack` go to the Engine; `assignMaterial` is forwarded with mesh/camera commands. `activeScene` looks up the packed scene guid and calls `loadScene` / `applySceneEnvironment` so a later `changescene` replaces that stack. Engine Settings `postProcessingEnabled` is editor/Play-only and is not read by the player. In-process fallback registers the same content and runs a rAF `advance` pump; both paths capture canvas input into the input ring. Packed UserInterface JSON hydrates into `createPlayerUiHost` (`attachFullscreenGui` when a Scene exists): `uiApply` / `uiRemove` / `uiSetVisible` and `uiWidgetEvent` match overlay Play. The host is interactive (`interactive: true`); ADT ideal is the first applied HUD’s `designResolution` / `scaleRule`. Canvas move/leave still reach the Layer ADT while `skipPointerMovePicking` is on. Packed Interface Materials (plus functions/textures they reference) hydrate into `createEngine` `materialDocuments` so HUD Material widgets can blit; the host passes `resolveInterfaceMaterial` / `resolveTexture` into `createPlayerUiHost`. The Engine keeps Texture KTX2 bytes; the HUD host uses `guiTextureBytesFromGame` (UiImage sidecars, else browser-decodable Texture bytes). EUI assets are never packed. Session input mode starts **All**; `setInputMode` commands match overlay Play.

`?preview=1` waits for a same-origin `postMessage` pack. Destroying the iframe drops that WebGL context.

## Preview Build

Debug-dropdown checkbox only (`debuggerDefaults.previewBuild`, default **off**). Always visible; disabled while Play or prepare is running. **Off:** overlay Play unchanged (`canPlay` still requires an open scene tab); chrome launch reads **Play**. **On:** chrome launch reads **Preview**; Play does not require a scene tab; always `bundleDebugger: true`; Preparing Preview modal (Saving → Collecting Assets → Compiling → Writing Pack → Launching); same-origin iframe of the hosted player. Cancel only before the iframe exists. **Stop** is a labeled 44px control layered above the iframe (not a 28px ghost X in a chrome strip). Clicking it posts `PREVIEW_STOP_MESSAGE`, drops the in-memory pack, unmounts the overlay immediately, and shows the session report if diagnostics were posted. A posted diagnostic with `code: "runtime.infinite_loop"` closes Preview the same way without tapping Stop; the player also cancels rAF and stops the worker so the iframe is not left running. Preview diagnostics now carry `code` (and optional `bodyLine`); the editor no longer hardcodes `code: "preview"` when the player sent a real code. `canSendPreviewPack` refuses handshake replies after Stop so a dying iframe cannot relaunch. The packaged player HUD samples fps on the rAF pump (same idea as overlay Play) so fps is not stuck at 0 while ticks climb.

**Player URLs follow the Vite base.** The iframe `src` and `loadPlayerDistFiles` both go through `playerHostBase()` / `playerPreviewSrc()` (`apps/editor/src/lib/player-host-url.ts`), which prefix `import.meta.env.BASE_URL`. Hardcoding `/player/` broke every non-root deployment — GitHub Pages serves the editor from `/BabylonSlate/`, so the iframe fetched the domain root and showed nothing but its own black background. `playerHostVitePlugin` mounts at the same base in dev.

**The pack handover is a handshake, not a single post.** The player posts `PREVIEW_REQUEST_PACK_MESSAGE` once its listener is installed and the editor replies with the pack, resending on each request; posting only on the iframe `load` event raced module evaluation and silently dropped it. Repeat packs are ignored after the first launch. Boot failures post `PREVIEW_ERROR_MESSAGE`, which the overlay renders as an `Alert` (`preview-build-error`) so a failed boot is never an unexplained black frame. A locked framebuffer stays WxH; CSS contain letterboxes it in the iframe so circles stay round. Without a locked framebuffer the player resizes its canvas to the element and observes it for changes (Follow System).

## Tests

- Closure BFS (GameInstance, EUO/EUI strip, plugin disable, sprite `textureGuid` payloads, `audioMixerGuid` → channels / Audio → channel/attenuation, reachable UserInterface + nested UI / image / Interface `materialGuid` / Font family), zip `index.html` at root, packed boot + per-scene packs, Havok XOR Rapier, file-count warn/fail, range + whole-fetch dual servers, `pixelsPerUnit` / Font `name` on `game.json`, UserInterface logic as `UserInterface:<guid>` in `scripts.js`, Scene navmesh and audioReverb sidecars, Texture `UiImage` sidecars (`uiimage:<guid>`), packed Audio BSAU.
- Player `packedContentFromGame` hydrates sprite / Sprite Animation / tilemap / navmesh / audioReverb, Material / Material Function, Particle Emitter / Particle System, and UserInterface payloads from the pack, plus the startup scene post-process stack. Missing Sprite Animation frame `width`/`height` are filled from packed Texture PNG IHDR bytes. `packedBootControls` emits `loadUserInterfaces` before `loadScripts` and drops UI class ids from `spawn`. `loadSprites` carries Sprite Animation documents referenced by packed Animation Graphs. GUI Image URLs come from UiImage sidecar bytes, not KTX2 labeled as PNG.
- `e2e/p14-export.spec.ts`: unzip, serve range-capable **and** range-blind, assert boot + ticks on `startupSceneGuid`, file count &lt; 800, no `main.scene.babasset`, and verify distinct authored parent/child world positions in the live Babylon visuals.
- `e2e/p14-preview-build.spec.ts`: default overlay Play; toggle on/off; chrome launch **Preview** when the checkbox is on; missing startup scene alert; a booted proof (`data-startup-scene` matches the project guid, `data-booted="true"`, ticks advance, player HUD fps not stuck at 0, no `data-error`, canvas laid out) so a black overlay cannot pass again; the same placement fixture as overlay Play/export; and **Stop** restores the editor (overlay and iframe gone, Play enabled, Debug menu visible). `preview-build-overlay.test.tsx` pins the labeled 44px Stop above the iframe.
- `apps/editor/vite-player-host.test.ts`: the dev mount follows the configured base and ignores the origin-root path under a sub-path deployment.
