# Asset registry

Shared surface for P2 Content Browser, import, thumbnails, and texture compression (engineplan §§2.4, 3.3, 3.5, 10.2). Implementation lives in `@babylonslate/assets`.

## Invariants

1. **Header-only indexing.** Scan and browse use `readBabassetHeader` only — never allocate chunk payloads to build the guid index, folder tree, dependency graph, or Show References.
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
| `getByGuid` / `list` / `folderTree` | Index queries |
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

Queue: one dedicated import Worker; one job at a time; pause on Preview / background; recycle worker after N jobs. Source + KTX2 chunks both commit on the `.babasset`. Policy defaults leave pixel art, sprites, UI, and fonts uncompressed. Max dimension clamp default 2048 (Project Settings).

Loader prefers KTX2 when present (`selectTextureChunk`); self-hosted transcoder via `configureKtx2Transcoder` / `KhronosTextureContainer2.URLConfig` under `apps/editor/public/ktx2/`. Silent fallback is forbidden — state must be explicit. Encode runs on `EncodeQueue` (one job, pauseable, recycle after N) with a stub encoder in tests and Basis wasm in the import Worker.

## Content Browser (P2)

`apps/editor/src/components/content-browser-workspace.tsx` is the registry-backed project asset UI:

- Folder tree from `folderTree("project")`; asset grid filtered by folder, type chips, and search.
- Import via hidden `<input type="file" multiple>` → `registry.importFile` (no Capacitor from UI).
- **New Asset** uses type + engine-base parent-class pickers → `registry.createAsset`.
- Long-press multi-select + `ContextMenuOverlay` delete; `AlertDialog` lists removed assets and inbound refs from `showReferences`.
- Drag source MIME `application/x-babylonslate-asset` with `{ guid, type, path }`.
- Texture tiles show `payload.compressionState` badges (`pending`, `encoding`, `fallback_uncompressed`, `encode_failed`).
- Empty `data-lock-slot` on tiles reserved for P15 lock decoration.

`DocumentProvider` exposes `assetRegistry` and `refreshAssetRegistry()` (`projectService.remountRegistry()`).

## Content Browser

Pinned tab consumes the registry: folder tree, type filters, search, Import (file input), New Asset (type + parent class), long-press multi-select, drag payload `application/x-babylonslate-asset`, compression badges, and delete confirmation listing inbound refs. Lock decoration is an empty `data-lock-slot` for P15.

## Tests

- Second synthetic root mounts and resolves across roots.
- Hundreds of assets open with near-zero `accountedPayloadBytes`.
- Importer unit tests + guid-remap cases.
- Encode queue states; loader KTX2 vs source; transcoder omitted smoke.
- Content Browser helpers (filter / new-asset / drag MIME) unit-tested in the editor.
