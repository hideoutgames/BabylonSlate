# Asset Registry

Header-indexed asset catalog across content roots: file operations, dependency metadata, scoped loading, importers, texture compression, thumbnails and the runtime asset catalog.

## Ownership

- Registry and loaders: [`packages/assets/src/`](../../../packages/assets/src/) (`registry.ts`, `content-root.ts`, `payload-loader.ts`, `babasset-carry.ts`, `asset-loading-service.ts`, `registry-asset-loading.ts`, `encode-queue.ts`, `texture-*.ts`, `importers/`).
- Editor host: `ProjectService` ([`apps/editor/src/services/project-service.ts`](../../../apps/editor/src/services/project-service.ts)); Content Browser UI: [`apps/editor/src/components/content-browser-workspace.tsx`](../../../apps/editor/src/components/content-browser-workspace.tsx), helpers in `apps/editor/src/lib/content-browser-*.ts`.
- GPU resources and native disposal stay in `ResourceCache` ([`packages/render/src/`](../../../packages/render/src/)); Babylon never enters `@babylonslate/assets`.

## Invariants

1. **Bounded header indexing.** Scans read the 12-byte prefix, validate the header length (≤ 16 MiB), then exactly that header via `readBinaryRange`. Payloads stay unread. Up to `SCAN_CATALOG_READS` = 8 header reads in flight, consumed in directory order (first-file-wins guid resolution is unchanged).
2. **Content roots from day one.** Every path op takes a root id or resolves guid → root. Guids are unique across project and plugins.
3. **Payloads on demand** through `AssetLoadingService`; storage I/O, source bytes, decoded CPU data and GPU resources are accounted separately.
4. **File create/delete/move are outside undo**; in-document edits belong to [command-layer](command-layer.md).
5. `IndexedAsset` entries are replaced, never mutated; `AssetRegistry.generation` advances on every index change and never on reads.

## Content roots

`ContentRoot { id, kind: "project" | "plugin" | "synthetic", pathPrefix, readOnly?, storage? }`. Storage and blobs resolve as `root.storage ?? registry storage` and `{pathPrefix}/.blobs`.

- Project root is `assets/`; enabled plugins mount as `plugin:<guid>` roots ([plugins](plugins.md)). `readOnly` roots refuse create/delete/move, encode writes and derived chunks.
- Cross-root `moveAsset` throws ("Cross-root moves are not supported yet"); duplicate-then-delete (new guid) is the workaround.
- `listDocumentPaths({ rootId: "project" })` feeds `project.json` scenes/graphs: plugin paths must never leak into the manifest. Play and search use `registry.list()`.

## File operations

- Every operation writing a new path claims a case-folded reservation synchronously, before its first await; a second writer gets the usual "already exists" error. Duplicate/copy allocate `stem_N` names and new guids; move/rename keep guids.
- Folder moves/deletes wait for pending writes; GUID-based saves resolve the current path after admission. Moves copy then remove; case-only renames use a recovery copy (`.babylonslate-move-*`, excluded from discovery). Not crash-atomic.
- Empty folders persist through a `.babylonslate-folder` marker.
- A scanned file whose guid is already indexed stays unindexed (`listGuidConflicts()`), and deleting a folder holding one is refused.
- Folder copy/duplicate is a deep copy: references inside the copied folder point at the copies (`applyImportGuidRemap`), copied Classes get class ids from their new stems.
- Delete repairs remaining writable referrers (guid fields → None, `header.dependencies` pruned, project settings cleared, child Classes fall back to `BObject`). Class deletion offers Replace Class first. Usages come from saved headers plus open tabs; closed documents are never read to decide.
- There is no UserInterface asset type (`documentKindForAssetType("UserInterface")` is `null`); do not re-add it.

## Dependency metadata

| Header field | Meaning |
| --- | --- |
| `dependencyMetadataVersion: 1` | Typed collection contract (`ASSET_DEPENDENCY_METADATA_VERSION`) |
| `dependencies` | All references: export reachability, Show References, deletion |
| `requiredDependencies` | Only edges needed to prepare this consumer now |
| `requiredVariableNames` | Class property keys with a required role; overrides inherit it |
| `classReferences` / `requiredClassReferences` | Typed Class identities resolved to guids |
| `consoleCommand` | Debug command registration without loading the graph |

- Required: active actor/component resources, materials, textures, clips, emitters, audio routing, font fallbacks, enabled default SceneLayers, input bindings, called function modules, data schemas. Deferred: streamed scenes, gameplay Class/asset literals, data values, disabled layers.
- Class variables and Structure/Data fields of asset or Class type are **Soft** (Load On Demand) by default; `loading: "hard"` (Load With Owner) adds them to `requiredDependencies`.
- Ordinary strings, names and source text are never references. Native engine class ids never become asset reads. Missing/ambiguous required custom classes throw an actionable error.

## Reads and rewrites

- `AccountedPayloadLoader` reads inline ranges or named blobs, verifies length and sha256, and rechecks the source revision after each chunk; a concurrent save fails the read (callers retry the whole acquisition, at most three times).
- `decodeAssetDocument` reads only the `document` chunk. Readers pairing documents and chunks use `loadDocumentWithChunks` ([containers](containers.md#documents)).
- `carryStoredChunks` (`babasset-carry.ts`): rewrites that change the header, `document` or one derived chunk carry other chunks by stored sha256 without reading blobs; output is byte-identical to a full re-encode, and anything unproven falls back to full decode. A save whose header and file are unchanged writes nothing (no mtime or generation change).
- Document saves, renames and derived commits share one per-asset write queue.

## Scoped loading

- `ProjectService.assetLoadingService` is shared by documents, previews and Play; cache identity = project/root, asset, revision, representation. Required closures tolerate cycles; in-flight work dedupes; cancellation stops shared work only after its last owner leaves.
- Admission reserves bytes before work. Priority: gameplay (High) > explicit preload (Normal) > background (Low). Defaults: 128 MiB source, 128 MiB decoded, 64 MiB temporary, concurrency 4, 1 s unowned retention (provisional, not device-measured). Oversized requests fail with the asset and consumer.
- Editor compile cache `GraphScriptCompileCache` ([`script-compiler.ts`](../../../apps/editor/src/services/script-compiler.ts)): 16 MiB / 256 entries by default.

## Runtime asset catalog

- `RuntimeAssetCatalogEntry` ([`packages/core/src/asset-catalog.ts`](../../../packages/core/src/asset-catalog.ts)): `guid`, `name`, `type`, `path`, `classId`, `parentClass`, `dependencies`, `requiredDependencies`. Queried through `RuntimeAssetCatalog` ([`packages/runtime/src/asset-catalog.ts`](../../../packages/runtime/src/asset-catalog.ts)) as `ctx.assetRegistry`.
- Editor Play sends the packaged set (header-only `collectHeaderReachability` from the export roots plus the Play scene) as `load.assetCatalog`; exported games build it from manifest entries with `assetPath`; editor graph hosts use the live registry.
- Paths are full storage paths including the root prefix (`assets/…`, `plugins/<folder>/assets/…`). Folder matching is exact and case-sensitive.
- `ProjectSettings.alwaysPackageFolders` makes every asset under a listed folder an export and Play root.

## Importers

- Pure functions keyed by extension: `(bytes, options) → ImportResult[]`. Cross-project `.babasset` import remaps colliding guids with `remapImportResultGuids` (typed reference fields only; text-typed values stay as authored). Template instantiation keeps guids.
- Model ingest is **GLB/glTF only** (`MODEL_EXTENSIONS`); parse failure throws, never a stub. OBJ, STL and FBX convert to GLB in [`packages/render/src/`](../../../packages/render/src/) (`convert-obj-to-glb.ts`, `convert-stl-to-glb.ts`, `@babylonslate/render/fbx-import` worker kept out of the player bundle). The Content Browser never constructs Babylon Scenes itself.
- glTF import embeds external images, creates Material per slot, Skeleton when `rigKind !== "none"`, one Animation per clip. Missing `.gltf` BIN throws `MISSING_GLTF_BIN` per file. Empty image bytes must not set `compressionState: "pending"`.
- A relative image URI no sidecar supplies is dropped from the stored GLB together with its textures and every material `*Texture` reference (`stripUnmatchedGltfImageUris`), so each remaining `texture.source` is a valid image index and the Material imports from its factors. The glTF loader throws on a texture without an image, which fails the whole Scene. `embedGltfImportBatch` returns `{ files, warnings }`: one warning per model naming the missing files, which the Content Browser lists in the import issues dialog.
- Font JSON (msdf / facetype) attaches to an existing Font of that family; MSDF PNG is a Font sidecar, not a Texture.

## Texture compression

- States (`TextureCompressionState`): `pending`, `encoding` (in memory only, `ProjectService.textureEncodingGuids`), `compressed`, `fallback_uncompressed`, `encode_failed` (a badge, **source still renders**). Silent fallback is forbidden: state is always explicit.
- `EncodeQueue` runs one job at a time; a Texture has one job, and a newer user request supersedes older results. The registry owns `compressionState`, `ktx2ChunkId`, `encodeError`, `ktx2Width/Height/BlockAlign/Sha256`; document saves take them from the file.
- Compressed non-atlas Textures encode at sizes rounded up to multiples of 4 (`textureEncodeSize`, WebGPU block alignment); atlases (Tileset/Sprite/Sprite Animation via `atlasTextures` header meta) keep their size. Padding never changes existing `ktx2:<hash>` ids (only Particle keys `blockAlign`).
- With Source Control enabled there are **no background re-encodes** of shared Textures; only explicit user actions and this session's new files realign ([source-control](source-control.md)).
- Encoding runs on `apps/editor/public/basis/encode-worker.js` with a transferable source; KTX2/Draco/meshopt/Havok decoders are self-hosted under `apps/editor/public/` (each directory has a `README.md` with upstream and SHA-256). `KTX2_TRANSCODER_RELATIVE_FILES` lives in assets so export can list them without `@babylonslate/render`.

## Thumbnails

- Stored under `derived/{projectGuid}/thumbnails/`; Texture thumbs generate at import. Model/Animation/Material/Prefab captures render on the shared project Engine through one serialized queue: never construct a second `ResourceCache` or extra GPU work for captures (it can lose the WebGL context).
- Browsing only reads existing thumbnails; missing ones keep the type icon. `ThumbnailDecodeLru` is separate from scene payload caches. Tiles load 4 at a time with a 100 ms sync debounce.

## Area emission

Rectangular area lights reference a Texture; **Prepare Emission** (explicit, or started by a scene or prefab viewport for a referenced unprepared Texture, once per source sha256, in `apps/editor/src/lib/area-emission-preparation.ts`) writes a versioned `area-emission` chunk keyed by the source sha256 and processor version beside the untouched `pixels`. Gameplay never preprocesses; export ships it as an `AreaEmission` sidecar.
