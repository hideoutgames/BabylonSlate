# Asset Registry

Header-indexed asset catalog across content roots: file operations, dependency metadata, scoped loading, importers, texture compression, thumbnails and the runtime asset catalog.

## Ownership

- Registry and loaders: [`packages/assets/src/`](../../../packages/assets/src/) (`registry.ts`, `content-root.ts`, `payload-loader.ts`, `hasset-carry.ts`, `asset-loading-service.ts`, `registry-asset-loading.ts`, `encode-queue.ts`, `texture-*.ts`, `importers/`).
- `registry.ts` keeps the index, catalog reads, path reservations, write fences and the public API. It re-exports by name the public types and the two shared values (`FOLDER_MARKER_NAME`, `RegistryGenerationClock`) declared in `registry-types.ts`. Pure path helpers and the folder-tree builder are in `registry-paths.ts`; atlas referrer tracking is the `AtlasReferrerIndex` class in `registry-atlas.ts`. The other operations are sibling modules whose functions take a `RegistryHost` (`registry-types.ts`): root scans (`registry-scan.ts`), Texture file rewrites (`registry-texture-rewrite.ts`), encode requests and the alignment pass (`registry-texture-encoding.ts`), asset moves and renames (`registry-asset-moves.ts`), folders (`registry-folders.ts`), Duplicate and Copy (`registry-copy.ts`) and imports (`registry-import.ts`). They call public registry methods through the host, which dispatches through the instance, never the sibling module function.
- Editor host: `ProjectService` ([`apps/editor/src/services/project-service.ts`](../../../apps/editor/src/services/project-service.ts)), which delegates to sibling `project-*.ts` modules: Texture encoding and alignment (`project-texture-encoding.ts`), plugins (`project-plugins.ts`), reference rewrites on rename and delete (`project-reference-repair.ts`), starter scaffolds (`project-scaffold.ts`) and `.hasset` chunk reads and writes (`project-asset-files.ts`). Content Browser UI: [`apps/editor/src/components/content-browser-workspace.tsx`](../../../apps/editor/src/components/content-browser-workspace.tsx), helpers in `apps/editor/src/lib/content-browser-*.ts`.
- GPU resources and native disposal stay in `ResourceCache` ([`packages/render/src/`](../../../packages/render/src/)); Babylon never enters `@haptic/assets`.

## Invariants

1. **Bounded header indexing.** Scans read the 12-byte prefix, validate the header length (≤ 16 MiB), then exactly that header via `readBinaryRange`. Payloads stay unread. Up to `SCAN_CATALOG_READS` = 8 header reads in flight, consumed in directory order (first-file-wins guid resolution is unchanged).
2. **Content roots from day one.** Every path op takes a root id or resolves guid → root. Guids are unique across project and plugins.
3. **Payloads on demand** through `AssetLoadingService`; storage I/O, source bytes, decoded CPU data and GPU resources are accounted separately.
4. **File create/delete/move are outside undo**; in-document edits belong to [command-layer](command-layer.md).
5. `IndexedAsset` entries are replaced, never mutated; `AssetRegistry.generation` advances on every index change and never on reads.

## Content roots

`ContentRoot { id, kind: "project" | "plugin" | "synthetic", pathPrefix, readOnly?, storage? }`. Storage and blobs resolve as `root.storage ?? registry storage` and `{pathPrefix}/.blobs`.

- Project root is `assets/`; enabled plugins mount as `plugin:<guid>` roots ([plugins](plugins.md)). `readOnly` roots refuse create/delete/move, encode writes and derived chunks.
- Cross-root moves (`moveAsset` to another `rootId`, `moveFolder(..., targetRootId)`) need both roots writable: the source loses the file. Fix-up pass: decode the file with the source blob store (every chunk's length and sha256 verified; a missing or torn blob refuses the move before anything is written) → write each blob chunk to the target root's store under its locator name → copy the file bytes unchanged (blob locators name a sha256, not a root, so nothing is rewritten) → remove the source → re-index under the target root with the same guid, so inbound references and class ids (the file stem) survive. Source blobs stay as unreferenced files (no blob GC; another asset may share them).
- A cross-root folder move does that blob step for every listed asset, then copies the whole tree (markers, empty folders, unlisted files) and removes the source; a failed copy removes the partial destination. It refuses a folder holding a guid conflict and a destination that exists on disk. Like same-root moves it is not crash-atomic: an interrupted move can leave a same-guid copy, which the next scan keeps unindexed.
- Moves never touch `project.json`: the editor re-derives `scenes`/`graphs` from `listDocumentPaths({ rootId: "project" })` after every move, and plugin compatibility stamps change only on document saves.
- `listDocumentPaths({ rootId: "project" })` feeds `project.json` scenes/graphs: plugin paths must never leak into the manifest. Play and search use `registry.list()`.

## File operations

- Every operation writing a new path claims a case-folded reservation synchronously, before its first await; a second writer gets the usual "already exists" error. Duplicate/copy allocate `stem_N` names and new guids; move/rename keep guids.
- Folder moves/deletes wait for pending writes; GUID-based saves resolve the current path after admission. Moves copy then remove; case-only renames use a recovery copy (`.haptic-move-*`, excluded from discovery). Not crash-atomic.
- Empty folders persist through a `.haptic-folder` marker.
- A scanned file whose guid is already indexed stays unindexed (`listGuidConflicts()`), and deleting a folder holding one is refused.
- Folder copy/duplicate is a deep copy: references inside the copied folder point at the copies (`applyImportGuidRemap`), copied Classes get class ids from their new stems.
- Copies take `AssetCopyOptions`: `signal` is checked before a copy's write and between a folder's files (not during the reference remap); an aborted folder copy deletes its partial destination. The Content Browser removes earlier completed copies itself, so Cancel leaves no copies.
- Delete repairs remaining writable referrers (guid fields → None, `header.dependencies` pruned, project settings cleared, child Classes fall back to `Object`). Class deletion offers Replace Class first. Usages come from saved headers plus open tabs; closed documents are never read to decide.
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
- `carryStoredChunks` (`hasset-carry.ts`): rewrites that change the header, `document` or one derived chunk carry other chunks by stored sha256 without reading blobs; output is byte-identical to a full re-encode, and anything unproven falls back to full decode. A save whose header and file are unchanged writes nothing (no mtime or generation change).
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

- Pure functions keyed by extension: `(bytes, options) → ImportResult[]`. `ImportOptions.signal` aborts a slow importer (it rejects with the signal's reason) and `onProgress(fraction)` reports one file's progress where the importer can tell (HDR conversion). Cross-project `.hasset` import remaps colliding guids with `remapImportResultGuids` (typed reference fields only; text-typed values stay as authored). Template instantiation keeps guids.
- Model ingest is **GLB/glTF only** (`MODEL_EXTENSIONS`); parse failure throws, never a stub. OBJ, STL and FBX convert to GLB in [`packages/render/src/`](../../../packages/render/src/) (`convert-obj-to-glb.ts`, `convert-stl-to-glb.ts`, `@haptic/render/fbx-import` worker kept out of the player bundle). The Content Browser never constructs Babylon Scenes itself.
- glTF import embeds external images, creates Material per slot, Skeleton when `rigKind !== "none"`, one Animation per clip. Missing `.gltf` BIN throws `MISSING_GLTF_BIN` per file. Empty image bytes must not set `compressionState: "pending"`.
- A relative image URI no sidecar supplies is dropped from the stored GLB together with its textures and every material `*Texture` reference (`stripUnmatchedGltfImageUris`), so each remaining `texture.source` is a valid image index and the Material imports from its factors. The glTF loader throws on a texture without an image, which fails the whole Scene. `embedGltfImportBatch` returns `{ files, warnings }`: one warning per model naming the missing files, which the Content Browser lists in the import issues dialog.
- Font JSON (msdf / facetype) attaches to an existing Font of that family; MSDF PNG is a Font sidecar, not a Texture.
- `AssetRegistry.importFile` runs the `runImport` option (default `importByExtension`). With `signal`, an abort before or during the conversion writes nothing, and an abort or failure while a file's results are written deletes the assets that file already created: one file imports whole or not at all. Attach imports (Font atlases) check the signal only before writing. Thumbnails and encodes are queued after every result is written. Batch rollback (earlier files of a cancelled Content Browser import) is the caller's job: the Content Browser deletes the guids it imported.
- Import worker ([`import-worker-protocol.ts`](../../../packages/assets/src/import-worker-protocol.ts), [`import-worker.ts`](../../../packages/assets/src/import-worker.ts), [`import-worker-client.ts`](../../../packages/assets/src/import-worker-client.ts), deep export `@haptic/assets/import-worker-client`): the editor's registry imports `.hdr`, `.glb` and `.gltf` on a module worker (one per request, `{ type: "module" }` like every bundled worker, so Vite dev, the Pages build and the native shells load it the same way). The request carries the bytes (a transferred copy) and `ImportOptions` without `signal` / `onProgress`; replies are `progress` (throttled to 50 ms), `imported` (chunk buffers transferred once each), `converted` or `error`. Abort terminates the worker at once. Hosts without `Worker` (Node tests) import in-process. Images, audio and fonts are only sniffed and stay in-process; OBJ and STL convert on the main thread's Babylon Engine (cancellable between files only); FBX has its own worker (`convertFbxImportBatch`, `signal` terminates it); thumbnails need the DOM.
- Environment cubes (`importers/environment.ts`): `.env` and `.dds` are stored byte-for-byte after `readEnvironmentTextureInfo` validation (the extension must match the container). `.hdr` converts at import ([`hdr-environment.ts`](../../../packages/assets/src/hdr-environment.ts), Babylon-free CPU, no Engine): RGBE decode with box downsampling (`radiance-hdr.ts`, `-Y H +X W` only), equirect to WebGL cube faces in Babylon's HDRCubeTexture orientation (centre +Z, ¾ across +X, top +Y), GGX filtered importance sampling per mip at alpha `2^(i/0.8)/size` (Babylon's HDRFiltering and the 0.8 LOD scale a prefiltered DDS CubeTexture reads with), then an RGBA16F DDS cube with a full mip chain. Faces are the power of two nearest width/4, capped at the Face Size (`hdrEnvironmentFaceSize`; 128, 256 or 512 from `ImportOptions.hdrFaceSize`, the **HDR Import Face Size** engine setting, default 256), so a larger setting never upscales a small panorama. The `source` chunk is an ordinary DDS environment cube: no runtime path or export reads anything else, and irradiance is derived at load as for any DDS. Conversion yields to the event loop every 32 ms, checking the signal.
- HDR Textures keep the imported panorama byte-for-byte in chunk `hdr` (`HDR_SOURCE_CHUNK_ID`, kind `hdr`, `image/vnd.radiance`) and record `payload.hdrFaceSize`. Export and Play select only `source` (`selectTextureChunk`), so the panorama never ships. `reconvertHdrEnvironment(guid, faceSize, convert, { signal, onProgress })` converts the kept panorama again (the editor passes the worker converter), then rewrites `source` and the cube fields (`width`, `height`, `mipLevels`, `hdrFaceSize`, ...) only while the stored `hdr` sha256 is the one it converted; an abort before the write leaves the file unchanged. The registry owns those fields: saving an open Texture takes them from the file, like the encode state. Backward compatibility: a missing `hdrFaceSize` reads as 256 (what older imports used); a cube with no `hdr` chunk (ENV, DDS, HDR imported before panoramas were kept) has a read-only Face Size and `reconvertHdrEnvironment` refuses it.

## Texture compression

- States (`TextureCompressionState`): `pending`, `encoding` (in memory only, `ProjectService.textureEncodingGuids`), `compressed`, `fallback_uncompressed`, `encode_failed` (a badge, **source still renders**). Silent fallback is forbidden: state is always explicit.
- `EncodeQueue` runs one job at a time; a Texture has one job, and a newer user request supersedes older results. The registry owns `compressionState`, `ktx2ChunkId`, `encodeError`, `ktx2Width/Height/BlockAlign/Sha256`; document saves take them from the file.
- Compressed non-atlas Textures encode at sizes rounded up to multiples of 4 (`textureEncodeSize`, WebGPU block alignment); atlases (Tileset/Sprite/Sprite Animation via `atlasTextures` header meta) keep their size. Padding never changes existing `ktx2:<hash>` ids (only Particle keys `blockAlign`).
- With Source Control enabled there are **no background re-encodes** of shared Textures; only explicit user actions and this session's new files realign ([source-control](source-control.md)).
- Encoding runs on `apps/editor/public/basis/encode-worker.js` with a transferable source; KTX2/Draco/meshopt/Havok decoders are self-hosted under `apps/editor/public/` (each directory has a `README.md` with upstream and SHA-256). `KTX2_TRANSCODER_RELATIVE_FILES` lives in assets so export can list them without `@haptic/render`.

## Thumbnails

- Stored under `derived/{projectGuid}/thumbnails/`; Texture thumbs generate at import. Model/Animation/Material/Prefab captures render on the shared project Engine through one serialized queue: never construct a second `ResourceCache` or extra GPU work for captures (it can lose the WebGL context). The queue ([`model-thumbnail-capture-host.tsx`](../../../apps/editor/src/components/model-thumbnail-capture-host.tsx)) pauses while a blocking scene load is open (`blockingSceneLoadOpen`, held by every open **SceneLoadingDialog** that is neither failed nor a rendering update): loading budgets renew on any shader finishing on the Engine, so a capture's compiles would keep a stuck load alive. Rendering updates do not pause it, since every settings change starts one. A load that opens mid-capture stops it, and the asset is captured again once the load closes unless a newer save replaced it. One capture ends at `SCENE_CAPTURE_CEILING_MS` (90 s) whatever compiles meanwhile, keeping the type icon.
- Capture results (`ThumbnailCaptureResult`, from `captureAssetThumbnailPng` / `captureModelThumbnailPng`): `captured`, `expired` (still wanted when its time ran out), `failed` (unreadable source, unavailable Material, empty Prefab, render error) or `cancelled`. An `expired` result carries a `reason`: `ceiling` (the capture's ceiling ended it while shaders kept finishing) or `bound` (a wait saw no progress for its whole bound, or the frame graph's preparation threw `PreparationTimedOut`). Only `ceiling` is retried, once, because a heavy Prefab or Model can legitimately need longer where shaders link synchronously (SwiftShader) or one after another (heavy programs on iPad WebKit WebGL2); `bound` and `failed` keep the type icon. The retry widens only the ceiling (`SCENE_CAPTURE_RETRY_CEILING_MS`, the 300 s loading ceiling): every per-wait bound stays as it is. The host parks the job until `pending` is empty and no blocking load is open, then runs it. New work interrupts a running retry, which keeps its place; the third interruption spends it, so a steady trickle of saves cannot make it burn its ceiling repeatedly. An interrupted retry that already holds its image writes it when no newer save of the asset is pending. A newer save of the asset replaces a parked or running retry; a retry that ends without an image keeps the type icon without a report. A backfill's `attemptedMissing` entry covers both attempts.
- Browsing only reads existing thumbnails; missing ones keep the type icon. `ThumbnailDecodeLru` is separate from scene payload caches. Tiles load 4 at a time with a 100 ms sync debounce.

## Area emission

Rectangular area lights reference a Texture; **Prepare Emission** (explicit, or started by a scene or prefab viewport for a referenced unprepared Texture, once per source sha256, in `apps/editor/src/lib/area-emission-preparation.ts`) writes a versioned `area-emission` chunk keyed by the source sha256 and processor version beside the untouched `pixels`. Gameplay never preprocesses; export ships it as an `AreaEmission` sidecar.
