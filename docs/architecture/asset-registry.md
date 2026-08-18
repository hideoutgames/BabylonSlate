# Asset registry

Shared surface for P2 Content Browser, import, thumbnails, and texture compression (engineplan §§2.4, 3.3, 3.5, 10.2). Implementation lives in `@babylonslate/assets`.

## Invariants

1. **Header-only indexing.** Scan and browse use `readBabassetHeader` only — never allocate chunk payloads to build the guid index, folder tree, dependency graph, or Show References. Project-wide **text** search is a separate `ProjectSearchIndex` that may read Scene/Class (and legacy Graph) document chunks only ([global-search.md](global-search.md)).
2. **Content-root-aware from day one.** Roots are first-class. P13 mounts enabled plugin roots (`plugin:<guid>`) with optional `storage` and `readOnly`; P2 still tests a second synthetic root.
3. **Payloads on demand.** Chunk bytes load through an accounted accessor. Full LRU resource cache is P4; P2 ships a thin byte-accounted loader so open stays near-zero payload bytes.
4. **File create/delete outside undo.** Registry owns asset files; `packages/edit` owns in-document edits ([command-layer.md](command-layer.md)).

## Content roots

```ts
interface ContentRoot {
  id: string;
  kind: "project" | "plugin" | "synthetic";
  /** Path prefix inside ProjectStorage holding this root's `.babasset` tree. */
  pathPrefix: string;
  /** Engine plugin roots refuse create/delete/move. */
  readOnly?: boolean;
  /** Engine plugins mount from a separate storage; defaults to the registry's. */
  storage?: ProjectStorage;
}
```

- Project open mounts the project root (`assets/`). Enabled plugins mount as extra roots; disable unmounts them. Detail: [plugins.md](plugins.md).
- Guids are unique across the project and its plugins; references are ordinary guid edges.
- Resolve / watch / save paths always take a root id (or resolve via guid → root). `storageFor(rootId)` / `blobsFor(rootId)` use `root.storage ?? this.storage` and `{pathPrefix}/.blobs`.
- `createAsset` / `deleteAsset` / `moveAsset` throw on `readOnly`. Cross-root `moveAsset` throws until an explicit fix-up pass exists ([plugins.md](plugins.md#cross-root-moves)).
- `listDocumentPaths({ rootId: "project" })` feeds `project.json` scenes/graphs — plugin Class/Scene paths must not leak into the manifest. Play/search use `registry.list()`.

## Registry surface

| API | Role |
| --- | --- |
| `mountRoot` / `unmountRoot` | Add or remove a content root and (re)scan headers |
| `reindexPath` | Re-read one `.babasset` header after an in-place save (e.g. EUI `dockKind`) |
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

Generated at import (same worker path as encode when textures compress). `generateThumbnailBytes` passes the source chunk MIME into the decode `Blob` (JPEG/PNG/WebP); output is JPEG. Stored under `derived/{projectGuid}/thumbnails/` as small compressed images. Content Browser decodes lazily for **window-virtualised** grid cells only (`p17-content-browser-virtualize` — today the folder maps every tile). Off-screen blob URLs revoke. Thumbnail LRU is **separate** from the scene payload / P4 cache. Folder **TreeView** is already windowed.

## Texture compression state

Per Texture asset (engineplan §3.5):

| State | Meaning |
| --- | --- |
| `pending` | Source written; not yet queued |
| `encoding` | Encode job in flight |
| `compressed` | KTX2 chunk present |
| `fallback_uncompressed` | Transcoder unavailable / failed — render from source |
| `encode_failed` | Worker encode failed — **source still renders**. `encode_failed` is a badge/diagnostic, not a broken texture. |

Queue: `EncodeQueue` on `ProjectService` (one job at a time; pause on document `visibilitychange` / Preview hooks; recycle counter after N jobs). Import of compressible textures enqueues immediately; `commitCompressedTexture` writes the KTX2 chunk + `compressed` state. Policy defaults leave pixel art, sprites, UI, and fonts uncompressed (no `pending` state). Max dimension clamp default 2048 (Project Settings), overridable per Texture via `payload.maxDimension`. **Retry encoding** is Project Settings only. On registry mount, `autoRequeueUncompressed` re-queues `fallback_uncompressed`, `pending`, and interrupted `encoding` jobs. Encode callbacks bump the document registry generation so Content Browser badges refresh live. A hung worker fails the job on timeout (or `error` / `messageerror`) so the queue keeps pumping.

Loader prefers KTX2 when present (`selectTextureChunk`); self-hosted transcoder via `configureKtx2Transcoder(KhronosTextureContainer2)` in `createEngine`, URLs under `apps/editor/public/ktx2/` (vendored `babylon.ktx2Decoder.js`, MSC Basis, UASTC→ASTC/BC7, Zstd). Silent fallback is forbidden — state must be explicit.

**Encode path (source-first transferable):** the editor wires `createWorkerEncodeFn` with `editorEncodeWorkerUrl()` (`publicAssetUrl("basis/encode-worker.js")` so GitHub Pages `/BabylonSlate/` and Capacitor `/` both resolve) plus vendored Basis encoder wasm under `apps/editor/public/basis/` into `EncodeQueue`. The host posts a transferable `source` `ArrayBuffer` plus MIME (`SourceEncodeRequest`); the worker decodes and clamps, then Basis-encodes. Worker init errors clear the cached `ready` promise so the next job can spawn a new Worker. If the worker cannot decode (`decode_unavailable`), the host runs Safari / odd-MIME `Image.decode()` (`decodeSourceToRgba`) and posts a transferable RGBA job (`RgbaEncodeRequest`) — encode stays off the main thread. `encode_failed` persists `payload.encodeError` (Output Log + Texture Settings); a later successful `commitCompressedTexture` clears it. Source `pixels` stay on the asset; `selectTextureChunk` still returns `kind: "source"` when there is no usable KTX2, so `encode_failed` does **not** make the texture unusable. Thumbnails pass the source chunk MIME into `createImageBitmap` (`generateThumbnailBytes(..., mime)`); output is JPEG. Unit tests keep `stubEncodeKtx2` as the default when no Worker is injected. CI runs a real Basis encode smoke (`a16-encode-smoke.test.ts` / `createNodeBasisEncodeFn`) against checked-in A16 wall envelopes in `@babylonslate/test-kit`. On project enter, `probeKtx2TranscoderAvailable(editorKtx2PublicBase())` marks compressed textures `fallback_uncompressed` when decoder files are missing. Editor `createEngine` passes the same KTX2 base.

**GLB/glTF import:** `parseGlbForBrowse` extracts materials, embedded images (pixel chunks), and animation names so CB dependents are browsable; mesh runtime fidelity stays thin until Play. Animation payloads store `{ clipName }` (glTF group name). Model payloads store `clipNames[]` so Animation Graph Details can enum clips without importing `@babylonslate/render`.

## Content Browser (P2)

`apps/editor/src/components/content-browser-workspace.tsx` is the registry-backed project asset UI:

- Left pane is catalog **TreeView** (`content-browser-folder-tree`) of folders **and** assets (`flattenContentBrowserTree`: folders first under each parent, then assets). **New Folder** sits above the tree (`content-browser-new-folder`). Extra tree roots for **enabled** plugins appear when **Show Plugin Content** is on in Project Settings → Plugins (`settings-show-plugin-content`, default off, `layout.json`; **New Plugin** turns it on). Turning that switch **off** resets the grid to `assets` when the current folder is under a plugin prefix (`isPluginContentFolderPath` — do not trust `selectedRoot.rootId`, because an orphaned plugin path falls back to the project root). AssetPicker / Play / search still see those assets when the tree is hidden. Engine roots show a Read Only badge and skip New / Import / Delete. Tap a folder to set the grid folder; tap an asset to open its parent folder and select that guid; double-tap / `onActivate` opens the asset. **No context menu** on the tree. Hold ~250ms then drag to reparent (`onReparent` → `moveAsset` / `moveFolder`) **within the same root**. Drop on a folder moves into it; drop on an asset uses that asset’s parent. The `assets` root is not draggable. Illegal destinations use `isValidMoveDestination`. Cross-root drags are rejected ([plugins.md](plugins.md#cross-root-moves)).
- One toolbar row: Import, New Asset, shared **SearchInput** (clear when non-empty), **Filter** dropdown (multi-select type checkboxes; empty = all types), **Sort** dropdown (radio: Name A–Z default, Name Z–A, Type A–Z / Z–A, Date Modified Newest / Oldest; session-only like Filter; folders stay first and follow name direction only), then **Deselect All** and counted **Delete (N)** when a tile or folder tile is selected. Both selection actions are outline (`ContentBrowserSelectionActions`); Delete is not a filled destructive primary. Tapping Delete opens the danger confirm (`content-browser-delete-dialog`, `AlertDialogContent variant="destructive"` with a red media well). Cancel and Delete are `size="touch"` (44px); only the confirm control is solid `variant="destructive"` (`text-destructive-foreground`, not a 10% tint). No page heading or subtitle.
- Every folder view, **including root `assets`**, shows **direct children only**: child **folder tiles** first (`ContentBrowserFolderTile`, `content-folder-{path}`, uncolored `--card` well), then assets in that folder (`collectFolderGuids` defaults non-recursive). **P17** (`p17-content-browser-virtualize`) windows that grid: only viewport tiles plus overscan mount; until then `visibleAssets.map` renders the whole folder.
- Fixed-size shadcn `Card` tiles (`grid-cols-[repeat(auto-fill,9rem)]`, `size="sm"`): square thumb (`aspect-square` + `object-cover`, compact type-colored Lucide fallback via `TypeVisualIcon` `size={40}` / `TYPE_VISUAL_ICON_TILE_SIZE` when no thumbnail). Passing Lucide `size` plus `absoluteStrokeWidth` (design stroke 2) keeps SVG `width`/`height` at the CSS box and stroke at 2 CSS px so dense glyphs do not blob. Then `CardTitle` / `CardDescription` / badges. Asset thumbs use a 2px type-colored `typeColorThumbAccent` border on a `--card` well with `rounded-t-xl` so the outline follows the Card corners; folder cards stay `--card` with a muted `FolderIcon` at the same 40px Lucide size and absolute stroke. Titles strip a trailing `.{type}` suffix; type stays in the description. Cells do not stretch with `minmax(…, 1fr)`. Class tiles inherit the parent engine icon (Object / Actor / Widget) and share `--asset-animation`. PluginSettings tiles use Lucide `Puzzle` with `--asset-script-type`. UserInterface uses `PanelTop`, AnimationGraph `Workflow`, BehaviourTree `ListTree`.
- Folder tree (TreeView) and asset grid are native vertical scrollports (`min-h-0 overflow-y-auto overscroll-y-contain`). TreeView hold-reparent delays `setPointerCapture` until the 250ms arm and leaves rows pan-able (no `touch-none`). The grid itself is nested inside `content-browser-asset-grid`; overflow is not on `display: grid`.
- **Click / tap replaces selection** (`exclusiveSelectAsset` / `exclusiveSelectFolder`; `data-selected`). **Tap+drag across cards** paint-selects every tile the pointer crosses (`paintSelectTiles`; replaces the previous set; pointer capture blocks grid scroll for that gesture). Long-press / right-click **adds** the target (`addSelectedAssetGuid` / `addSelectedFolderPath`) then opens the tile menu. **Deselect All** (`content-browser-deselect-all`) or **tap / click empty grid** (padding/gaps, not a tile) **clears both** asset and folder selection. Reveal-from-search still focuses a single guid. **Double-click / double-tap** a folder tile navigates into it; the same gesture **opens** a catalog asset via `openOrFocusDocument` (`documentKindForAssetType`). **Double-click / double-tap empty grid** (scrollport padding, empty copy, or gaps — not a tile) opens **New Asset** when the selected root is writable. Stationary hold ≥500ms or right-click opens the **tile** context menu (`useLongPressMenu`). Tile pointer events `stopPropagation` so they do not arm the empty-grid menu or New Asset double-tap. Early pointer movement on **empty grid** scrolls. The workspace root does not bind `useContextMenu` pointer handlers.
- Empty grid long-press / right-click (scrollport, not a tile): **New Folder**, **New Asset**, **Import** — same handlers as the toolbar. Empty-grid double-tap skips that menu and opens New Asset directly.
- One tile context menu from the **intersection** of the current asset + folder selection (long-press on a tile adds it, then snapshots both `selectedGuids` and `selectedFolderPaths`). Duplicate / Move… / Copy to Folder… / Delete apply to every selected item. Rename is exactly one item. Show References is exactly one asset and zero folders. Mixed Texture + Scene still shares the asset row. **Retry Encoding** is Project Settings only.
- The registry tree root (`assets`) is **not movable** and has no folder context menu.
- Duplicate uses `duplicateAsset` / `duplicateFolder`. **Move…** / **Copy to Folder…** always open `ContentBrowserMoveDialog` (title **Move 3 items** when the selection is larger than one). Confirm loops every selected asset and folder. A destination is invalid if it is any selected folder or a descendant. Copy allows the current parent.
- **Class** `.class.babasset` owns the logic graph (event/function graphs on every class parent: `BObject`, `Actor`, `ActorComponent`, `GameInstance`, `FunctionLibrary`, `EditorFunctionLibrary`, `BDebugCommand`, `EditorUtilityObject`, `BTTask`, `BTDecorator`, `BTService`, `BTComposite`). The internal document kind stays `"graph"` (layout ids, Focus, Compile). User-facing tab suffix is **Class**. Legacy `type: "Graph"` / `.graph.babasset` still loads; save rewrites the header type to `Class` with `parentClass ?? "Actor"`. Prefab + Components dock tabs appear only when ancestry includes **Actor**.
- **UserInterface** stays its own asset (Designer | Logic mode bar; Logic Class docks on `payload.logic`). It is not a Class. **EditorUtilityInterface** (`*.eui.babasset`) is a creatable sibling: same widget payload plus `dockKind`, listed from **Windows → Editor Utilities**, stripped from Play. See [editor-extensions.md](editor-extensions.md) and [ui-runtime.md](ui-runtime.md).
- **New Asset** creates authored types only: Scene, Class, UserInterface, EditorUtilityInterface, Sprite, SpriteAnimation, AnimationGraph, Shader, Enum, Structure, ScriptInterface, AudioMixer, AudioChannel, SoundAttenuation. PluginSettings is **not** in that list — **New Plugin** (Project Settings only) creates the folder + PluginSettings. Import-only types (Texture, Material, Model, Audio, Font, Animation) are created by Import, not the New Asset button. New Asset inside a **project** plugin folder writes to that root; engine plugin roots disable create/import/delete. `.babplugin` files are never listed.
- Every catalog type opens a tab. Scene / Class / UserInterface / Sprite / Sprite Animation / Tileset / Tilemap / Material / AnimationGraph / Behaviour Tree / Shader / Enum / Structure / ScriptInterface / AudioMixer / AudioChannel / SoundAttenuation open DockView documents. Font and Blackboard stay non-DockView hosts. Texture, Model, Audio, and Animation open an **`asset-settings`** tab in `AssetDocumentWorkspace` (PropertyGrid) — not a new Shader or UI designer. Texture settings show a source **preview** (`texture-preview`, checkerboard behind alpha), **Usage** (albedo / normal / Pixel Art / UI — Pixel Art already means uncompressed + nearest; no extra mip/nearest toggles), read-only Compression, and **Max Dimension** (Source / 4096 / 2048 / 1024 / 512). Unset `payload.maxDimension` uses project `textures.maxTextureDimension` (default 2048). Effective GPU/encode size is `min(source longest edge, asset max, project max)`. Changing max requeues KTX2 for compressible usages; Pixel Art / UI skip encode (`decodeSourceToRgba` clamps when encoding). Uncompressed Play/editor upload still uses source bytes through sync `ResourceCache.getTexture`.
- Import: web/electron toolbar **Import** clicks the in-DOM `content-browser-import-input` (same path as Playwright `setInputFiles`). iOS/Android use `pickImportFiles()` (`babylonslate.documentPicker` when installed). A project-wide blocking **Importing** overlay (`importing-overlay`) shows determinate `n / m` and the current filename **during the write pass only**. Texture KTX2 encode stays on the background queue with compression badges — the overlay dismisses when `.babasset` writes finish. Per-file importer failures surface in a follow-up alert instead of failing silently.
- **New Asset** (`ContentBrowserNewAssetDialog`) is a large two-pane `Dialog` (not an `AlertDialog`) at the same shell size as CatalogDialog / Project Settings (`h-[min(90vh,52rem)] w-[min(96vw,64rem)]`): exclusive type cards (`new-asset-type-${type}`, Title Case labels, `TypeVisualIcon` thumbs) grouped World / Scripting / UI / 2D / Animation / Rendering / AI / Audio, plus a details pane (name; Class parent as exclusive engine-base + project Class rows with parent-engine icons). Search is not autofocused. Create → `registry.createAsset`. The name field starts **empty**; Create stays disabled until the user types a non-empty name (`newAssetFileName` does not invent `NewAsset`). Class create writes the default logic graph plus `header.parentClass` (picker default `BObject`). Create is also disabled when `newAssetFileName` already exists in the selected folder (`new-asset-name-taken`). `createAsset` throws if the path exists (no silent overwrite).
- **New Folder** → `registry.createFolder` (mkdir + `.babylonslate-folder` marker so empty folders survive Git). Confirm is disabled when the folder name already exists.
- Long-press + `ContextMenuOverlay`: one selection menu (see intersection above). Empty grid gets New Folder, New Asset, Import. **Duplicate** / copy allocate `stem_N` in the destination folder (`stripTrailingCopyIndex` then `nextCopyName`; keep the unsuffixed stem when unused) and write that name into both the file path (preserving `.scene.babasset` / `.class.babasset` / `.graph.babasset`) and `header.name`, with a new guid. Folder copy/duplicate recurse markers and nested assets. Rename confirm is disabled on a colliding path.
- **Move…** / **Copy to Folder…** open `ContentBrowserMoveDialog`: item preview, `SearchInput`, editor-kit `TreeView` of `flattenFolderTree(assetRegistry.folderTree("project"))` with folder icons. Illegal destinations (unchanged parent on move; any selected folder or a descendant) are muted and not selectable. Copy allows the current parent. Confirm loops `moveAsset` / `moveFolder` / `copyAsset` / `copyFolder`. After a folder move, open document tabs for contained assets are retargeted. Rename stays a text dialog (folder rename = `moveFolder` with a new sibling name). When Source Control is on, asset rename/move and folder rename/move/delete refuse paths locked by someone else and `transferLock` ours from old path to new (helpers in `source-control-file-ops.ts`). Copy does not transfer locks.
- File ops: `moveAsset` / `renameAsset` / `duplicateAsset` / `copyAsset` / `moveFolder` / `duplicateFolder` / `copyFolder` keep guids stable on move/rename; duplicate/copy assign a new guid and a unique `stem_N` name. Open document tabs are retargeted via `DocumentService.repathDocument`; `refreshAssetRegistry` rewrites `project.json` scene/graph path lists. `listDocumentPaths` treats Class and legacy Graph as compile/script documents. New projects scaffold `assets/main.class.babasset` with `parentClass: "Actor"`.
- `AlertDialog variant="destructive"` lists the same items as **Delete (N)** — selected folder paths plus selected asset names, not flattened folder contents (`content-browser-delete-list`). Extra lines warn when the selection is the last Scene and/or last Class in the project. Inbound refs still come from `showReferences` (names are `SelectableText`). Toolbar Delete only opens this dialog; confirming is the destructive step.
- Texture tiles show `payload.compressionState` badges (`pending`, `encoding`, `fallback_uncompressed`, `encode_failed`). Badges refresh when encode `onState` / `onComplete` / `onError` bump the registry generation.
- Walk records `IndexedAsset.mtime` from `DirEntry` / `stat` (null when the adapter has none). Foreground rescan diffs mtimes — see [source-control.md](source-control.md).
- Content Browser `data-lock-slot` shows Git LFS lock state when Source Control is enabled (`data-lock-state="mine"` / `"theirs"` plus owner name). Hidden and empty when Source Control is off.
- Grid tiles expose stable `data-testid="content-item-{path}"` plus `data-asset-path` / `data-asset-guid` for Playwright.
- Thumbnails: `generateThumbnailBytes` at import → `writeThumbnail` in derived data; CB grid lazy-decodes visible Texture cells via `ThumbnailDecodeLru` / `loadAssetThumbnail`. Off-screen blob URL revoke and skip-decode while the browser tab is CSS-hidden wait on **P17** (`p17-content-browser-virtualize`).

`DocumentProvider` exposes `assetRegistry`, `refreshAssetRegistry()` (`projectService.remountRegistry()`), and `repathDocument`.

## Tests

- Second synthetic root mounts and resolves across roots.
- Hundreds of assets open with near-zero `accountedPayloadBytes`.
- Importer unit tests + guid-remap cases + GLB browse parse.
- Encode queue states; loader KTX2 vs source; transcoder unavailable / export-omitted smoke; A16 Basis encode CI smoke. Source-first transferable `SourceEncodeRequest` vs RGBA fallback, `encodeError` persistence, and thumbnail MIME passthrough (`packages/assets/src/encode-worker-protocol.test.ts`). `encodeFailed: true` keeps `selectTextureChunk` on `kind: "source"` (`packages/assets/src/asset-registry.test.ts`).
- Content Browser helpers (filter / sort by name, type, or date / new-asset labels and groups / unique names / Move destination validity / selection menu intersection / folder+asset flatten / drop-target resolution / exclusive tap + paint-select + additive menu selection / empty-grid double-click target / thumb type outlines) unit-tested in the editor. Tile long-press menus and empty-grid pointer isolation covered in jsdom (`content-browser-asset-tile.test.tsx`, `content-browser-folder-tile.test.tsx`, `content-browser-move-dialog.test.tsx`, `content-browser-new-asset-dialog.test.tsx`, `use-content-browser-paint-select.test.tsx`). Multi-select toolbar Delete is outline until confirm (`content-browser-selection-actions.test.tsx`). Registry `duplicateFolder` / `copyFolder` / in-place folder rename via `moveFolder`. Encode queue timeout, worker error, remount requeue of `pending`/`encoding`, and Texture preview / maxDimension helpers.
- E2E: Scene/Class **double-click** open, PNG+GLB import with **Importing** overlay then reload, PNG encode badge does not stay Encoding, Texture preview, killed-tab journal recovery (`e2e/p2-accept.spec.ts`); density IA, exclusive tap, paint-select Duplicate, mixed asset+folder menu without Show References, Deselect All, outline counted Delete until 44px confirm, empty-grid deselect, empty-grid **double-click** New Asset, vertical scrollports, unique-name/duplicate, empty New Asset name, tree asset rows, folder tiles first, Sort menu name vs type order, empty-grid menu, no Retry Encoding on asset tiles (`e2e/editor-density.spec.ts`).
