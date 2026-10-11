# Container formats

Locked wire formats for P1 (engineplan §§3.1–3.4). Implementation lives in `@babylonslate/assets`.

## .babasset

One self-contained binary file per asset:

```
magic "BABA" (4) | version u32 LE | headerLen u32 LE | header JSON (utf8) | chunk bytes...
```

### Header (sorted-key JSON)

| Field | Meaning |
| --- | --- |
| `guid` | Asset identity within project + plugins |
| `type` | Asset type id (e.g. `Texture`, `Scene`, `Class`) |
| `name` | Display name |
| `engineVersion` | Engine that wrote the file |
| `version` | Payload schema version (per type) |
| `parentClass` | Optional parent class id (for example `BObject` or `Hero`) |
| `dependencies` | Every referenced guid |
| `requiredDependencies` | Guids needed to prepare this asset now ([dependency metadata](asset-registry.md#storage-and-dependency-metadata)) |
| `dependencyMetadataVersion` | Dependency metadata layout; always `1` (`ASSET_DEPENDENCY_METADATA_VERSION`) |
| `requiredVariableNames` | Class property keys with a required role (Classes only) |
| `mode` | `thin` (in-project) or `bundled` (share/export) |
| `payload` | Structured data (graphs, properties, component trees) |
| `chunks` | Chunk table |

### Chunk table entry

| Field | Meaning |
| --- | --- |
| `id` | Stable chunk id within the asset |
| `kind` | Semantic kind (`pixels`, `audio`, `mesh`, nested `asset`, …) |
| `mime` | MIME type |
| `sha256` | Content hash (hex) |
| `byteLength` | Chunk size in bytes, for inline and blob locators |
| `locator` | Either `{ "inline": { offset, length } }` or `{ "blob": "<sha256>" }` |

Inline locators point at byte ranges after the header. Blob locators name `{pathPrefix}/.blobs/<sha256>` inside that content root (the project root keeps `assets/.blobs`). Plugin roots use `plugins/<folder>/assets/.blobs` so a `.babplugin` is self-contained. Chunks above the externalise threshold use blob locators by default when saving thin assets; bundled mode always inlines.

### Current layout only

`readBabassetHeader` (and so every decode, catalog scan and project open) refuses a header without chunk `byteLength`, `dependencies`, `requiredDependencies`, `dependencyMetadataVersion: 1` or, for a Class, `requiredVariableNames`. It throws `AssetFormatVersionError` naming the asset guid and the missing fields; a newer `dependencyMetadataVersion` is refused as made by a newer engine. The engine is unreleased, so older files are not upgraded. `encodeBabasset` applies the same check, so no writer produces a file the reader refuses.

### Header-only read

`readBabassetHeader(bytes)` returns guid/type/name/deps/chunk table **without allocating chunk payloads**. The asset registry indexes headers only — see [asset-registry.md](asset-registry.md).

### Editor documents

Scenes and Class logic graphs are `.babasset` files under `assets/` (`assets/main.scene.babasset`, `assets/main.class.babasset`). `encodeAssetDocument` / `decodeAssetDocument` keep the JSON body in a single `document` chunk so type, schema version and guid stay header-only readable. Importers (Font, Texture, Model, …) often store structured data on **`header.payload`** with binary `source` / `pixels` chunks and no document chunk; `decodeAssetDocument` falls back to that header payload so those assets open in document workspaces. Settings-tab saves for those import types, and Font editor saves, write `headerPayload` so binary chunks are not replaced by a document chunk and an MSDF attach merges into the complete Font payload. A document save keeps extra chunks (`extraChunksFromDecoded`) so font bytes are not wiped. Asset guids survive a re-save: an existing file's guid is read from its header rather than regenerated.

Scene payloads are at schema version 4 (`SCENE_SCHEMA_VERSION`). Older Scene versions are refused as an unsupported old format; additive fields within version 4 are filled by `normalizeScene` on load. Documents are `.babasset` only: a `.json` scene or Class path is not read, written or discovered on project open.

### Modes

- **thin** — dependencies by guid; large chunks may externalise to the blob store.
- **bundled** — dependency assets embedded as nested asset chunks; unpack on import remaps/dedupes.

Leaving a project (export / share) always produces a self-contained file (inline locators).

## .babtrace

Recorded Play sessions reuse the `.babasset` container with `type: "Trace"`. The JSON body is a `TracePayload` (seed, dt, frames with stats/logs/prints/snapshots/input). Files use the `.babtrace` extension; `encodeTraceDocument` / `decodeTraceDocument` wrap `encodeAssetDocument`. The editor writes them only under derived data (`derived/{projectGuid}/traces/`), never `assets/`. Debugger stays free of `@babylonslate/assets`. Trace documents are read-only: `ProjectService.saveDocument` throws.

## Project folder / .babplugin

One logical tree, two backends behind one codec, parameterized by **manifest kind** (`project` | `plugin`):

```
MyGame/                     (directory)  or  MyGame.zip
  project.json              # kind=project
  layout.json               # editor dock layout (projects only)
  assets/                   # .babasset tree = Content Browser tree
    .blobs/                 # content-addressed immutable chunks
  plugins/<folder>/         # project plugins (kind=project only)
    <name>.plugin.babasset  # PluginSettings (identity = asset guid)
    assets/                 # plugin content root + .blobs
```

`.babplugin` zip (kind=plugin): `plugin.json` + PluginSettings + `assets/` (no `layout.json`). `plugin.json` is the **zip manifest only** — in-project discovery scans for `type: "PluginSettings"`. Detail: [plugins.md](plugins.md).

- **Directory backend** — incremental writes (OPFS, iPad Documents / external folder, desktop). Folder name is the display name (`MyGame/`), not `MyGame.babproject/`.
- **Zip backend** — single-file `.zip` (`fflate`); used for Export Project and interchange. Open Project from a zip picks `.zip` files only.

Web persists the directory layout into OPFS and offers Export Project as a `.zip` download. **Export Game** (itch zip) is a different artifact — see [exporter.md](exporter.md).

## Packaged games

Export Game writes each reached asset as an independent `assets/data-<n>.bin` file, listed in `game.json` with its byte length and SHA-256 revision ([exporter.md](exporter.md#runtime-file-layout)). Fonts are catalog assets loaded through `FontFace` from bytes. This layout is **export-only** — the editor project on disk stays one `.babasset` per asset (see Write performance in [vfs.md](vfs.md)).

### Derived data (outside the project)

App-private storage keyed by project guid: compiled scripts, thumbnails, import cache, recovery journal (`journal/*.jsonl` segments; see [command-layer.md](command-layer.md#journal-format)), **Play traces** (`traces/*.babtrace`). Export Project ignores derived data by construction.

## Schema migration

- Each registered asset type declares its `currentVersion` and may own ordered steps `N → N+1` ending there, applied on load (`MigrationRegistry`, `loadPayloadWithMigration`).
- `createDefaultMigrationRegistry()` registers **no steps**: the engine is unreleased, so a stored version older than current is refused with an “unsupported old format” error rather than upgraded. Add a step only when a released format must be read again.
- Both refusals throw `AssetFormatVersionError`, whose message is user-facing: opening such a Scene shows it in **Scene Loading Failed**, and other assets show it in **Could Not Open Asset**.
- Play, Simulate, Preview Build and Export Game read stored payloads without migrating them, so they refuse any registered type whose stored version is not current (`MigrationRegistry.requireCurrent`, same messages; an upgradable version must be saved with Migrate On Save first):
  - Play / Simulate check every required asset while resolving the catalog closure (`play-asset-sources.ts`), including streamed Scenes and preloads; open working documents are exempt because the editor already migrated them. The refusal appears in Output Log as `Play preparation failed: …`.
  - Export Game and Preview Build record the refusal in `loadExportDocuments`; a reached asset fails with `<asset> could not be read for export: …` (Export error / **Preview Build Failed**), an unreached one does not block. The packaged player trusts its export and does not re-check.
- Future (unknown) versions refuse with a clear message **when a type is registered**. Unregistered types (Font / Sprite / AnimationGraph) pass through so a version-1 document is not treated as “newer than current 0”.
- Opening a project that needs migration prompts once; migrate-on-save; never silently rewrite untouched files. `ProjectService.saveDocument` / `saveProject`, the NavMesh bake write and Audio clip writes refuse a pending path until `approveMigrateOnSave()`. Pending migrations list each path once; loading an unmigrated asset again replaces its entry.
- A Save All the user asks for (toolbar, the close prompt, an exclusive Scene switch, Play) that pending migrations refuse opens **Schema Migration Required**. **Migrate On Save** approves migration for the rest of the project session and runs the complete Save All (bakes, journal clear, compile-on-save, thumbnails, Scene Saved hooks); Play resumes only when that save completed. Auto-save never prompts.
- The approval flow stays covered with no shipped steps: `ProjectService` accepts an injected `migrations` registry, and `project-service.migration.test.ts` registers test steps for Scene and Project. A new step for a released format also gets a committed golden of the version it reads; `class-v1.babasset` and `audio-v1.babasset` are the current-format container goldens, and `demo.babproject.zip` holds a version 4 Scene. Goldens are regenerated by their tests with `UPDATE_GOLDENS=1`.
- The project manifest (`project.json`) migrates as type `Project` on load and is gated by the same approval.

## Golden / property tests

Byte-stable headers (sorted keys) enable content hashing and golden round-trips for both directory↔zip project backends and babasset encode/decode.
