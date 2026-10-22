# Container Formats

Locked on-disk formats: `.hasset`, `.htrace`, the project / `.hplugin` tree, derived data and schema-version policy.

## Ownership

- Codec: [`packages/assets/src/hasset.ts`](../../../packages/assets/src/hasset.ts), documents [`asset-document.ts`](../../../packages/assets/src/asset-document.ts), project tree [`hproject.ts`](../../../packages/assets/src/hproject.ts), traces [`trace.ts`](../../../packages/assets/src/trace.ts), migrations [`migration.ts`](../../../packages/assets/src/migration.ts), derived paths [`derived-data.ts`](../../../packages/assets/src/derived-data.ts).
- Editor reads go through `ProjectService` ([`apps/editor/src/services/project-service.ts`](../../../apps/editor/src/services/project-service.ts)).

## .hasset

```
"BABA" (4) | format version u32 LE (= 1) | headerLen u32 LE | header JSON (UTF-8, sorted keys) | chunk bytes…
```

- `HASSET_MAGIC` "BABA", `HASSET_FORMAT_VERSION` = 1, `HASSET_PREFIX_BYTES` = 12, `MAX_HASSET_HEADER_BYTES` = 16 MiB. Sorted keys make headers byte-stable for hashing and goldens.

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
- **Current layout only.** `readHassetHeader` (so every decode, catalog scan and project open) refuses headers missing chunk `byteLength`, `dependencies`, `requiredDependencies`, `dependencyMetadataVersion: 1` or, for a Class, `requiredVariableNames`, with `AssetFormatVersionError`. `encodeHasset` applies the same check. The engine is unreleased, so old files are refused, not upgraded.
- `readHassetHeader` never allocates chunk payloads; the registry indexes headers only.

## Documents

- Scenes, Classes and other authored documents keep their JSON body in one `document` chunk (`encodeAssetDocument` / `decodeAssetDocument`), so type, version and guid stay header-readable.
- Import types (Font, Texture, Model, …) store settings on `header.payload` with binary chunks and no `document` chunk; `decodeAssetDocument` falls back to the header payload. Saves for those types write `headerPayload` so binary chunks survive, and document saves carry extra chunks.
- A re-save keeps the guid read from the existing header.
- Readers that pair a document with chunks (export, Texture variants) use `ProjectService.loadDocumentWithChunks`: one file revision, retried if a save lands in between.
- Scene payloads are `SCENE_SCHEMA_VERSION` = 4; additive fields are filled by `normalizeScene`. Documents are `.hasset` only; `.json` scenes/classes are never read or discovered.

## .htrace

Recorded Play sessions reuse the container with `type: "Trace"` (`TracePayload`: seed, dt, frames). Written only under `derived/{projectGuid}/traces/`, never `assets/`. Read-only (`ProjectService.saveDocument` throws). `@haptic/debugger` does not depend on `@haptic/assets`.

## Project folder and .hplugin

One codec, manifest kind `project` | `plugin`:

```
MyGame/                      (directory) or MyGame.zip
  project.json               # kind=project
  layout.json                # editor dock layout (projects only)
  assets/                    # .hasset tree = Content Browser tree
    .blobs/
  plugins/<folder>/          # project plugins
    <name>.plugin.hasset   # PluginSettings (identity = asset guid)
    assets/  (+ .blobs/)
```

- `.hplugin` zip (kind `plugin`): `plugin.json` + PluginSettings + `assets/`, no `layout.json`. `plugin.json` is the zip manifest only; in-project discovery scans for `type: "PluginSettings"` ([plugins](plugins.md)).
- Directory backend writes incrementally (OPFS, Documents, external folders, desktop); the folder name is the display name. Zip backend (`fflate`) is for Export Project and interchange.
- `project.json` without a project `guid` does not open (the guid namespaces saves and derived data).
- Export Game output (`assets/data-<n>.bin` + `game.json`) is export-only; the editor project stays one `.hasset` per asset ([exporter](exporter.md)).

## Derived data

App-private storage keyed by project guid (`derived/{projectGuid}/…`): compiled scripts, thumbnails, import cache, recovery journal ([command-layer](command-layer.md#journal-format)), Play traces. Never part of Export Project.

## Schema versions

- Each registered type declares `currentVersion` and may own ordered `N → N+1` steps (`MigrationRegistry`, `loadPayloadWithMigration`). `createDefaultMigrationRegistry()` registers **no steps**: older versions are refused as an unsupported old format. Add a step (with a committed golden) only when a released format must be read again.
- Unregistered types pass through (so Font / Sprite / AnimationGraph version 1 is not "newer than 0"); registered future versions are refused. `project.json` migrates as type `Project`.
- Migration is opt-in per session: opening a project that needs it prompts once; `saveDocument`, `saveProject`, NavMesh bakes and Audio clip writes refuse pending paths until `approveMigrateOnSave()`. Untouched files are never silently rewritten; autosave never prompts.
- Play, Simulate, Preview Build and Export Game never migrate: `MigrationRegistry.requireCurrent` refuses any reached asset whose stored version is not current (open working documents are exempt). The packaged player trusts its export.
- `AssetFormatVersionError` messages are user-facing (Scene Loading Failed, Could Not Open Asset, Play/Preview/Export failures).
