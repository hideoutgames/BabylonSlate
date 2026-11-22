# Container Formats

Locked on-disk formats: `.hasset`, `.htrace`, the project / `.hplugin` tree, derived data and schema-version policy.

## Ownership

- Codec: [`packages/assets/src/hasset.ts`](../../../packages/assets/src/hasset.ts), documents [`asset-document.ts`](../../../packages/assets/src/asset-document.ts), project tree [`hproject.ts`](../../../packages/assets/src/hproject.ts), traces [`trace.ts`](../../../packages/assets/src/trace.ts), migrations [`migration.ts`](../../../packages/assets/src/migration.ts), derived paths [`derived-data.ts`](../../../packages/assets/src/derived-data.ts).
- Editor reads go through `ProjectService` ([`apps/editor/src/services/project-service.ts`](../../../apps/editor/src/services/project-service.ts)).

## .hasset

```
"HAPT" (4) | format version u32 LE (= 1) | headerLen u32 LE | header JSON (UTF-8, sorted keys) | chunk bytes…
```

- `HASSET_MAGIC` "HAPT", `HASSET_FORMAT_VERSION` = 1, `HASSET_PREFIX_BYTES` = 12, `MAX_HASSET_HEADER_BYTES` = 16 MiB. Sorted keys make headers byte-stable for hashing and goldens.

| Header field | Meaning |
| --- | --- |
| `guid` | Asset identity across the project and its plugins |
| `type` | Asset type id (`Texture`, `Scene`, `Class`, …) |
| `name` | Display name |
| `engineVersion` | Engine that wrote the file |
| `version` | Payload schema version (per type) |
| `parentClass` | Optional parent class id (Classes) |
| `dependencies` | Every referenced guid |
| `requiredDependencies` | Guids needed to prepare this asset now ([asset-registry](asset-registry.md#dependency-metadata)) |
| `requiredVariableNames`, `classReferences`, `requiredClassReferences`, `consoleCommand` | Class dependency/registration metadata (optional fields) |
| `dependencyMetadataVersion` | Always `1` (`ASSET_DEPENDENCY_METADATA_VERSION`) |
| `mode` | `thin` (in-project) or `bundled` (share/export) |
| `payload` | Structured header data (importers often keep settings here) |
| `chunks` | Chunk table |

| Chunk field | Meaning |
| --- | --- |
| `id` | Stable id within the asset (`document`, `source`, `pixels`, `ktx2:<hash>`, `navmesh`, `audioReverb`, …) |
| `kind` | Semantic kind (`pixels`, `audio`, `mesh`, `area-emission`, nested `asset`, …) |
| `mime` | MIME type |
| `sha256` | Content hash (hex), verified on every read |
| `byteLength` | Chunk size for both locator kinds |
| `locator` | `{ "inline": { offset, length } }` (after the header) or `{ "blob": "<sha256>" }` |

- Blob locators resolve to `{pathPrefix}/.blobs/<sha256>` inside the asset's content root (`assets/.blobs` for the project, `plugins/<folder>/assets/.blobs` per plugin, so a `.hplugin` is self-contained). An existing blob is never rewritten.
- Thin saves externalise chunks ≥ `DEFAULT_BLOB_THRESHOLD` (64 KiB); bundled mode always inlines and embeds dependencies as nested `asset` chunks. Anything leaving the project is self-contained.
- **Current layout only.** `readHassetHeader` (so every decode, catalog scan and project open) refuses headers missing chunk `byteLength`, `dependencies`, `requiredDependencies`, `dependencyMetadataVersion: 1` or, for a Class, `requiredVariableNames`, with `AssetFormatVersionError`. `encodeHasset` applies the same check. These are the released layout; a later layout change raises `HASSET_FORMAT_VERSION` or `ASSET_DEPENDENCY_METADATA_VERSION` and keeps reading the released layout (the `class-v1` and `audio-v1` goldens pin it byte for byte).
- `readHassetHeader` never allocates chunk payloads; the registry indexes headers only.

## Documents

- Scenes, Classes and other authored documents keep their JSON body in one `document` chunk (`encodeAssetDocument` / `decodeAssetDocument`), so type, version and guid stay header-readable.
- Import types (Font, Texture, Skeleton, …) store settings on `header.payload` with binary chunks and no `document` chunk; `decodeAssetDocument` falls back to the header payload. Saves for those types write `headerPayload` so binary chunks survive, and document saves carry extra chunks.
- Headers stay small because every scan parses and holds them: a Model keeps its full payload in the `document` chunk and `modelHeaderSummary` (everything but `simpleColliders`, plus `simpleColliderCount`) in the header, and an Animation `animationHeaderSummary` (everything but `rootMotion`, plus `rootMotionBone`; a root motion track is 30 samples a second of three numbers), from import (`registry-import.ts`) and every save (`headerMetaForSave`), and EditorPrimitives for its Models; an imported Material's graph goes into its `document` chunk with `{ domain }` in the header. Readers of collision shapes (Play, export, the viewport, the Model editor) and of root motion tracks (Play preparation, export, the Animation editor) load the document; header clip catalogs name only the root motion bone. Skeleton `bones`/`sockets` stay in the header: skeleton matching, bone pickers and attach-point lists read them synchronously from headers with no loaded-document cache (a KayKit Knight Skeleton header is about 5.5 KB).
- A re-save keeps the guid read from the existing header.
- Readers that pair a document with chunks (export, Texture variants) use `ProjectService.loadDocumentWithChunks`: one file revision, retried if a save lands in between.
- Scene payloads are `SCENE_SCHEMA_VERSION` = 1; additive fields are filled by `normalizeScene`. Documents are `.hasset` only; `.json` scenes/classes are never read or discovered.

## .htrace

Recorded Play sessions reuse the container with `type: "Trace"` (`TracePayload`: seed, dt, frames). Written only under `derived/{projectGuid}/traces/`, never `assets/`. Read-only (`ProjectService.saveDocument` throws). `@haptic/debugger` does not depend on `@haptic/assets`.

## Project folder and .hplugin

One codec, manifest kind `project` | `plugin`:

```
MyGame/                      (directory) or MyGame.zip
  project.json               # kind=project
  layout.json                # editor dock layout (projects only)
  cover.webp|cover.jpg|cover.png  # Homepage picture, when the project has one
  assets/                    # .hasset tree = Content Browser tree
    .blobs/
  plugins/<folder>/          # project plugins
    <name>.plugin.hasset   # PluginSettings (identity = asset guid)
    assets/  (+ .blobs/)
```

- `.hplugin` zip (kind `plugin`): `plugin.json` + PluginSettings + `assets/`, no `layout.json`. `plugin.json` is the zip manifest only; in-project discovery scans for `type: "PluginSettings"` ([plugins](plugins.md)).
- Directory backend writes incrementally (OPFS, Documents, external folders, desktop); the folder name is the display name. Zip backend (`fflate`) is for Export Project and interchange.
- `project.json` without a project `guid` does not open (the guid namespaces saves and derived data).
- `project.json` holds `metadata` (the project's `name`), `settings`, `scenes` and `graphs`. A manifest missing any of them does not open and its Homepage identity cannot be edited; nothing rebuilds an empty project from it. Only `plugin.json` keeps a top-level `name`, which templates rewrite.
- The project picture is a root cover file named by `metadata.appearance.coverFile`; `project.json` and app-settings recents never hold its data URL (`storedProjectAppearance`). `ProjectAppearance.image` is in memory only: `loadCurrentProject` reads it from the cover file, create and **Edit** write the file (`writeProjectCover`, removing other cover files), and Homepage keeps each recent's copy in derived storage at `recent-covers/<encoded folder id>` (`syncRecentProjectCover`, loaded into cards by `withRecentProjectCovers`, removed with the recent).
- Export Game output (`assets/data-<n>.bin` + `game.json`) is export-only; the editor project stays one `.hasset` per asset ([exporter](exporter.md)).

## Derived data

App-private storage keyed by project guid (`derived/{projectGuid}/…`): compiled scripts, thumbnails, import cache, recovery journal ([command-layer](command-layer.md#journal-format)), Play traces. Never part of Export Project. Where each host keeps it: [vfs.md](vfs.md#app-owned-libraries-and-derived-data).

## Schema versions

- `RELEASED_VERSIONS` / `CURRENT_VERSIONS` in `migration.ts` are exhaustive over `AssetType | "Project"` (`satisfies Record<VersionedAssetType, number>`): a new asset type does not compile until it has a version. Every type is at 1 until the first release. Extension asset types (`extension.<guid>.<typeId>`) are at `EXTENSION_ASSET_FORMAT_VERSION` (1).
- Reads are strict: `MigrationRegistry.requireCurrent` refuses any stored version other than the current one (older: "unsupported old format", newer: "made with a newer engine version") and any unknown type. There are no upgrade steps and no migration prompt; opening a document, `project.json` (type `Project`), Play, Simulate, Preview Build and Export Game all refuse (open working documents are exempt from the Play check). `currentVersion` throws for an unknown type, so no save writes version 0. The packaged player trusts its export.
- `AssetFormatVersionError` messages are user-facing (Scene Loading Failed, Could Not Open Asset, Play/Preview/Export failures).
