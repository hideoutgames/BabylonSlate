# Asset registry

Shared surface for P2 Content Browser, import, thumbnails, and texture compression (engineplan §§2.4, 3.3, 3.5, 10.2). Implementation lives in `@babylonslate/assets`.

## Invariants

1. **Header-only indexing.** Scan and browse use `readBabassetHeader` only — never allocate chunk payloads to build the guid index, folder tree, dependency graph, or Show References. Project-wide **text** search is a separate `ProjectSearchIndex` that may read Scene/Graph document chunks only ([global-search.md](global-search.md)).
2. **Content-root-aware from day one.** Roots are first-class; plugin roots must not be a retrofit (P13 mounts them; P2 tests a second synthetic root).
3. **Payloads on demand.** Chunk bytes load through an accounted accessor. Full LRU resource cache is P4; P2 ships a thin byte-accounted loader so open stays near-zero payload bytes.
4. **File create/delete outside undo.** Registry owns asset files; `packages/edit` owns in-document edits ([command-layer.md](command-layer.md)).

## Content roots

```ts
interface ContentRoot {
  id: string;
  kind: "project" | "plugin" | "synthetic";
  /** Absolute path prefix inside ProjectStorage for this root's assets/. */
  pathPrefix: string;
}
```

- Project open mounts the project root (`assets/`).
- Guids are unique across the project and its plugins; references are ordinary guid edges.
- Resolve / watch / save paths always take a root id (or resolve via guid → root).

## Registry surface

| API | Role |
| --- | --- |
| `mountRoot` / `unmountRoot` | Add or remove a content root and (re)scan headers |
| `getByGuid` / `list` / `folderTree` | Index queries (folder tree includes marker-backed empty folders) |
| `createFolder` / `moveFolder` | Empty folders (`.babylonslate-folder`) and folder moves |
| `moveAsset` / `renameAsset` / `duplicateAsset` / `copyAsset` | Path ops; guid stable on move/rename |
| `showReferences(guid)` | Inbound + outbound deps from header `dependencies[]` |
| `importFile` | Document-picker bytes → importers → write `.babasset` + enqueue work |
| `createAsset` / `deleteAsset` / `deleteFolder` | File ops (confirm delete in UI via Show References) |
| `accountedPayloadBytes` | Diagnostic for the hundreds-of-assets open test |

### Accounted payload accessor

`AccountedPayloadLoader` reads a chunk by locator (inline range or blob store) and increments `accountedPayloadBytes`. Opening a several-hundred-asset project must leave this near zero until something requests a payload. P4 replaces / wraps this with the scene resource cache LRU.

## Importers

Pure functions keyed by extension: `(bytes, options) → ImportResult[]`.

| Inputs | Produces |
| --- | --- |
| images | Texture |
| glb / gltf / obj / stl | Model (+ Material / Texture / Animation as needed) |
| audio | Audio |
| woff2 / woff / ttf / otf | Font |
| facetype JSON / msdf atlas | Attach representations to an **existing** Font |
| `.babasset` | Unpack / remapped copy |

Cross-project import remaps colliding guids and rewrites references in the incoming set. Template instantiate keeps guids as-is.

## Thumbnails

Generated at import (same worker path as encode when textures compress). Stored under `derived/{projectGuid}/thumbnails/` as small compressed images. Content Browser decodes lazily for visible virtualised cells only; thumbnail LRU is **separate** from the scene payload / P4 cache.

## Texture compression state

Per Texture asset (engineplan §3.5):

| State | Meaning |
| --- | --- |
| `pending` | Source written; not yet queued |
| `encoding` | Encode job in flight |
| `compressed` | KTX2 chunk present |
| `fallback_uncompressed` | Transcoder unavailable / failed — render from source |
| `encode_failed` | Worker encode failed — source still renders |

Queue: `EncodeQueue` on `ProjectService` (one job at a time; pause on document `visibilitychange` / Preview hooks; recycle counter after N jobs). Import of compressible textures enqueues immediately; `commitCompressedTexture` writes the KTX2 chunk + `compressed` state. Policy defaults leave pixel art, sprites, UI, and fonts uncompressed (no `pending` state). Max dimension clamp default 2048 (Project Settings). **Retry encoding** lives in Project Settings and the Content Browser tile menu; `autoRequeueUncompressed` re-queues `fallback_uncompressed` on registry mount.

Loader prefers KTX2 when present (`selectTextureChunk`); self-hosted transcoder via `configureKtx2Transcoder(KhronosTextureContainer2)` in `createEngine`, URLs under `apps/editor/public/ktx2/` (vendored `babylon.ktx2Decoder.js`, MSC Basis, UASTC→ASTC/BC7, Zstd). Silent fallback is forbidden — state must be explicit.

**Encode path:** the editor wires `createWorkerEncodeFn` (`/basis/encode-worker.js` + vendored Basis encoder wasm under `apps/editor/public/basis/`) into `EncodeQueue`. Unit tests keep `stubEncodeKtx2` as the default when no Worker is injected. CI runs a real Basis encode smoke (`a16-encode-smoke.test.ts` / `createNodeBasisEncodeFn`) against checked-in A16 wall envelopes in `@babylonslate/test-kit`. On project enter, `probeKtx2TranscoderAvailable` marks compressed textures `fallback_uncompressed` when decoder files are missing.

**GLB/glTF import:** `parseGlbForBrowse` extracts materials, embedded images (pixel chunks), and animation names so CB dependents are browsable; mesh runtime fidelity stays thin until Play.

## Content Browser (P2)

`apps/editor/src/components/content-browser-workspace.tsx` is the registry-backed project asset UI:

- Folder tree from `folderTree("project")` (includes empty folders via `.babylonslate-folder` markers); **New Folder** sits on the tree (`content-browser-new-folder`), not the main toolbar.
- One toolbar row: Import, New Asset, shared **SearchInput** (clear when non-empty), **Filter** dropdown (multi-select type checkboxes; empty = all types), Delete when a tile is selected. No page heading or subtitle.
- Fixed-size shadcn `Card` tiles (`grid-cols-[repeat(auto-fill,7rem)]`, `size="sm"`): square thumb (`aspect-square` + `object-cover`, icon fallback), then `CardTitle` / `CardDescription` / badges. Titles strip a trailing `.{type}` suffix; type stays in the description. Cells do not stretch with `minmax(…, 1fr)`.
- Root folder `assets` lists the whole tree; any other folder shows **direct children only** (`collectFolderGuids`).
- **Click / tap selects** (replace selection; `data-selected`). **Double-click / double-tap opens** Scene and Graph via `openOrFocusDocument`. Hold ~250ms arms drag-reorder; hold still to ~500ms opens the context menu.
- Import through `pickImportFiles()` in `@babylonslate/vfs` (web/electron: DOM file input; iOS/Android: optional `babylonslate.documentPicker` bridge, else the same DOM picker). UI never calls Capacitor plugins directly. A hidden `content-browser-import-input` remains for Playwright `setInputFiles`.
- **New Asset** uses type + engine-base parent-class pickers → `registry.createAsset`.
- **New Folder** → `registry.createFolder` (mkdir + `.babylonslate-folder` marker so empty folders survive Git).
- Long-press multi-select + `ContextMenuOverlay`: Duplicate, Rename, Move, Copy, Show References, Retry encoding, Delete; folder right-click opens the delete confirm for the folder tree (assets root is protected).
- **Move** opens a `Dialog` + editor-kit `TreeView` of `flattenFolderTree(assetRegistry.folderTree("project"))`; confirm calls `moveAsset`. Rename stays a text dialog.
- File ops: `moveAsset` / `renameAsset` / `duplicateAsset` / `copyAsset` / `moveFolder` keep guids stable on move/rename; duplicate/copy assign a new guid. Open Scene/Graph tabs are retargeted via `DocumentService.repathDocument`; `refreshAssetRegistry` rewrites `project.json` scene/graph path lists.
- `AlertDialog` lists removed asset names and inbound refs from `showReferences` (names are `SelectableText`).
- Drag source MIME `application/x-babylonslate-asset` with `{ guid, type, path }`.
- Texture tiles show `payload.compressionState` badges (`pending`, `encoding`, `fallback_uncompressed`, `encode_failed`).
- Empty `data-lock-slot` on tiles reserved for P15 lock decoration.
- Grid tiles expose stable `data-testid="content-item-{path}"` plus `data-asset-path` / `data-asset-guid` for Playwright.
- Thumbnails: `generateThumbnailBytes` at import → `writeThumbnail` in derived data; CB grid lazy-decodes visible Texture cells via `ThumbnailDecodeLru` / `loadAssetThumbnail`.

`DocumentProvider` exposes `assetRegistry`, `refreshAssetRegistry()` (`projectService.remountRegistry()`), and `repathDocument`.

## Tests

- Second synthetic root mounts and resolves across roots.
- Hundreds of assets open with near-zero `accountedPayloadBytes`.
- Importer unit tests + guid-remap cases + GLB browse parse.
- Encode queue states; loader KTX2 vs source; transcoder unavailable / export-omitted smoke; A16 Basis encode CI smoke.
- Content Browser helpers (filter / new-asset / drag MIME / folder-tree flatten for Move) unit-tested in the editor.
- E2E: Scene/Graph **double-click** open, PNG+GLB import→reload, killed-tab journal recovery (`e2e/p2-accept.spec.ts`); density IA in `e2e/editor-density.spec.ts`.
