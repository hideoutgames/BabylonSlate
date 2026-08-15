# Exporter and packaged player (P14)

Spec: [engineplan.md](../engineplan.md) §15, §15.1, §15.2. Implementation: `@babylonslate/exporter` (headless packer), `apps/player` (Vite canvas host), editor **Export Game** and **Preview Build**.

Overlay Play (open scene tab, shared Engine, `registerView`) stays the default. Packaged boot — itch zip **and** Preview Build — always starts from `project.json` `startupSceneGuid` (asset guid). Do not boot or tree-shake from `BabprojectManifest.startupScene` or `assets/main.scene.babasset`.

## Package (`@babylonslate/exporter`)

No React, Babylon, or Capacitor. Callers compile graphs and load payloads; the package tree-shakes, packs, and emits files.

| Export | Role |
| --- | --- |
| `collectExportClosure` | BFS from `startupSceneGuid` plus GameInstance class; strips `isEditorOnlyAsset`; skips disabled plugin roots |
| `exportGame` | Default `mode: "packed"`; writes `game.json`, `scripts.js`, packs, player files |
| `zipExport` | `fflate` zip with `index.html` at the root (itch) |
| `encodeBabpack` / `decodeBabpack` / `decodeBabpackIndex` | Concatenated asset bytes + JSON index `{ guid, offset, length, hash }` (`BPK1`) |
| `createHttpPackSource` / `createMemoryPackSource` | Range-first HTTP loader with whole-body fallback; in-memory Preview Build source |
| `concatenateScripts` / `serializeScriptRegistry` | One `scripts.js` (unminified); `CompileAnchor.line` rewrite is tested for a concatenated blob; the registry keeps per-class sources for ScriptHost |
| Preview protocol | `previewPackFromFiles` / `filesFromPreviewPack` — transfer a `Map` of files into the iframe; never write a pack into the project tree |

Missing or stale startup scene: `MISSING_STARTUP_SCENE_MESSAGE` (`Set Startup Scene in Project Settings.`).

## Export closure

Not `header.dependencies` alone — scene saves often leave those empty.

1. Apply export-preset `pluginOverrides` (layer 3) **before** the walk so disabled plugin roots are absent.
2. Seed with `startupSceneGuid` (must be a Scene asset).
3. Walk `SerializedScene` actors/components (guids in properties, Mesh/Model `assetGuid`, textures, UserInterface, Font, Class ids) plus `gameInstanceClass`.
4. Load Class/Graph/UI-logic documents; pull asset-typed pin values and `header.dependencies`.
5. Recurse to a fixed point. Drop EditorUtilityObject / EditorUtilityInterface / PluginSettings (`isEditorOnlyAsset`).
6. Scene library keys in the pack are **asset guids** (overlay Play may keep path-based document ids).

Release zip compiles with `compileGraphDocumentsForExport` (skips Inspector **Development Only**). Preview Build and a preset with `bundleDebugger: true` keep those nodes.

Textures: pack only `selectTextureChunk`’s chosen variant (KTX2 when present).

## Packed layout (default)

```
index.html          # CSS inlined; itch requires this at zip root
player.js           # Vite `inlineDynamicImports`; workers stay separate files
scripts.js          # class registry (`globalThis.__babylonslateScripts`)
game.json           # GameManifest: startupSceneGuid, render, packs, assets[]
boot.babpack        # startup scene + assets reached through that scene
scene-<guid>.babpack
coi-serviceworker.js
havok/HavokPhysics.wasm
ktx2/…              # transcoder files the player needs
```

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

`includeDebugCommands: manifest.bundleDebugger`. Release player uses `createCommandRegistry({ includeDebug: false })`; core commands (`changescene`, …) stay. When the debugger is bundled, a small vanilla DOM HUD (not the editor `PlayOverlay`) shows fps / scriptMs / physicsMs / draws.

`?preview=1` waits for a same-origin `postMessage` pack. Destroying the iframe drops that WebGL context.

## Preview Build

Debug-dropdown checkbox only (`debuggerDefaults.previewBuild`, default **off**). Always visible; disabled while Play or prepare is running. **Off:** overlay Play unchanged (`canPlay` still requires an open scene tab). **On:** Play does not require a scene tab; always `bundleDebugger: true`; Preparing Preview modal (Saving → Compiling → Collecting Assets → Writing Pack → Launching); same-origin iframe of `/player/`. Cancel only before the iframe exists. Close stops the player, destroys the iframe, drops the pack, and shows the session report if diagnostics were posted.

## Tests

- Closure BFS (GameInstance, EUO strip, plugin disable), zip `index.html` at root, packed boot + per-scene packs, file-count warn/fail, range + whole-fetch dual servers.
- `e2e/p14-export.spec.ts`: unzip, serve range-capable **and** range-blind, assert boot + ticks on `startupSceneGuid`, file count &lt; 800, no `main.scene.babasset`.
- `e2e/p14-preview-build.spec.ts`: default overlay Play; toggle on/off; missing startup scene alert.
