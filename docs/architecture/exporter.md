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
2. Seed with `startupSceneGuid` (must be a Scene asset).
3. Walk `SerializedScene` actors/components (guids in properties, Mesh/Model `assetGuid`, textures, UserInterface, Font, Class ids) plus scene `gameInstanceClass` **and** the project `gameInstanceClass` when the scene field is empty.
4. Load Class/Graph/UI/Sprite/Tilemap documents; pull asset-typed pin values, `header.dependencies`, and payload fields such as sprite `textureGuid`.
5. Recurse to a fixed point. Drop EditorUtilityObject / EditorUtilityInterface / PluginSettings (`isEditorOnlyAsset`).
6. Scene library keys in the pack are **asset guids** (overlay Play may keep path-based document ids).

Release zip compiles Class/Graph **and UserInterface `logic`** with `compileGraphDocumentsForExport` (skips Inspector **Development Only**). Preview Build and a preset with `bundleDebugger: true` keep those nodes. UI graphs compile from the asset path (`assets/<name>.ui.babasset`) so `classIdForGraphPath` matches overlay Play.

Textures: pack only `selectTextureChunk`’s chosen variant (KTX2 when present). Scene `navmesh` extra chunks pack as sidecar assets (`type: "NavMesh"`, guid `navmesh:<sceneGuid>`) so they do not collide with the Scene JSON guid.

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
```

`GameManifest` records `startupSceneGuid`, optional `gameInstanceClass` (project field), `render`, `playFrameCap`, project `twoD.pixelsPerUnit` / `pixelPerfect` (defaults 100 / false), `packs`, `physicsWorld`, and `assets[]`. Font index entries include `name` (authored `family`, else the asset name) so the player can `FontFace(family, bytes)`. The player boot prefers `manifest.gameInstanceClass`, then the startup scene field.

`loose` is an explicit preset option (`packed: false`): tree-shaken `assets/<guid>.bin`, no `.babpack`. Wasm, transcoder, and `coi-serviceworker.js` stay real files in both modes.

HTTP loader: probe `Range: bytes=0-7`, then the index, then per-asset ranges. Status `200` (range-blind host) falls back to a whole-pack fetch.

File-count report: warn 800 / fail 1000 (preset-overridable). Export smoke asserts count.

## Export Game vs Export Project

| Action | Output |
| --- | --- |
| **Export Game** (Project Settings) | Itch zip of the packaged player |
| **Export Project** | `.babproject` backup of the project tree |

Preview packs are in-memory only. Capacitor and Electron host the **editor**, not shipped games.

## `apps/player`

Vite canvas host: `@babylonslate/runtime` + `@babylonslate/render` + bridge/physics/debugger. No Dockview, editor chrome, or React shell. Dedicated Engine (do not `registerView` onto the editor Engine). Boot `startupSceneGuid`; apply `render.customResolution` (WxH framebuffer + stretch or black bars) via the shared `play-preview-aspect` math in `@babylonslate/core`.

`includeDebugCommands: manifest.bundleDebugger`. Release player uses `createCommandRegistry({ includeDebug: false })`; core commands (`changescene`, …) stay. When the debugger is bundled, a small vanilla DOM HUD (not the editor `PlayOverlay`) shows fps / scriptMs / physicsMs / draws. Packed fonts use `FontFace(family, bytes)` — family from the manifest `name`, falling back to the guid; not blob URLs.

Boot hydrates packed **Sprite / Tilemap / Tileset / AnimationGraph / BehaviourTree / Blackboard** payloads into `createEngine` and the worker (`loadAnimGraphs`, `loadTilemaps`, `loadNavMesh`, …) **before** `play`. In-process fallback registers the same content and runs a rAF `advance` pump; both paths capture canvas input into the input ring. Overlay Play remains the path that mounts UserInterface **widget trees** onto Babylon GUI (`PlayHudOverlay`); the packaged player compiles UI logic into `scripts.js` and packs the UI JSON.

`?preview=1` waits for a same-origin `postMessage` pack. Destroying the iframe drops that WebGL context.

## Preview Build

Debug-dropdown checkbox only (`debuggerDefaults.previewBuild`, default **off**). Always visible; disabled while Play or prepare is running. **Off:** overlay Play unchanged (`canPlay` still requires an open scene tab); chrome launch reads **Play**. **On:** chrome launch reads **Preview**; Play does not require a scene tab; always `bundleDebugger: true`; Preparing Preview modal (Saving → Collecting Assets → Compiling → Writing Pack → Launching); same-origin iframe of the hosted player. Cancel only before the iframe exists. **Stop** is a labeled 44px control layered above the iframe (not a 28px ghost X in a chrome strip). Clicking it posts `PREVIEW_STOP_MESSAGE`, drops the in-memory pack, unmounts the overlay immediately, and shows the session report if diagnostics were posted. `canSendPreviewPack` refuses handshake replies after Stop so a dying iframe cannot relaunch. The packaged player HUD samples fps on the rAF pump (same idea as overlay Play) so fps is not stuck at 0 while ticks climb.

**Player URLs follow the Vite base.** The iframe `src` and `loadPlayerDistFiles` both go through `playerHostBase()` / `playerPreviewSrc()` (`apps/editor/src/lib/player-host-url.ts`), which prefix `import.meta.env.BASE_URL`. Hardcoding `/player/` broke every non-root deployment — GitHub Pages serves the editor from `/BabylonSlate/`, so the iframe fetched the domain root and showed nothing but its own black background. `playerHostVitePlugin` mounts at the same base in dev.

**The pack handover is a handshake, not a single post.** The player posts `PREVIEW_REQUEST_PACK_MESSAGE` once its listener is installed and the editor replies with the pack, resending on each request; posting only on the iframe `load` event raced module evaluation and silently dropped it. Repeat packs are ignored after the first launch. Boot failures post `PREVIEW_ERROR_MESSAGE`, which the overlay renders as an `Alert` (`preview-build-error`) so a failed boot is never an unexplained black frame. Without a locked framebuffer the player resizes its canvas to the element and observes it for changes.

## Tests

- Closure BFS (GameInstance, EUO strip, plugin disable, sprite `textureGuid` payloads), zip `index.html` at root, packed boot + per-scene packs, Havok XOR Rapier, file-count warn/fail, range + whole-fetch dual servers, `pixelsPerUnit` / Font `name` on `game.json`, UserInterface logic in `scripts.js`, Scene navmesh sidecars.
- Player `packedContentFromGame` hydrates sprite/tilemap/navmesh payloads from the pack.
- `e2e/p14-export.spec.ts`: unzip, serve range-capable **and** range-blind, assert boot + ticks on `startupSceneGuid`, file count &lt; 800, no `main.scene.babasset`.
- `e2e/p14-preview-build.spec.ts`: default overlay Play; toggle on/off; chrome launch **Preview** when the checkbox is on; missing startup scene alert; a booted proof (`data-startup-scene` matches the project guid, `data-booted="true"`, ticks advance, player HUD fps not stuck at 0, no `data-error`, canvas laid out) so a black overlay cannot pass again; and **Stop** restores the editor (overlay and iframe gone, Play enabled, Debug menu visible). `preview-build-overlay.test.tsx` pins the labeled 44px Stop above the iframe.
- `apps/editor/vite-player-host.test.ts`: the dev mount follows the configured base and ignores the origin-root path under a sub-path deployment.
