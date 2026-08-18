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
| `parentClass` | Optional parent class guid |
| `dependencies` | Guid list |
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
| `locator` | Either `{ "inline": { offset, length } }` or `{ "blob": "<sha256>" }` |

Inline locators point at byte ranges after the header. Blob locators name `{pathPrefix}/.blobs/<sha256>` inside that content root (the project root keeps `assets/.blobs`). Plugin roots use `plugins/<folder>/assets/.blobs` so a `.babplugin` is self-contained. Chunks above the externalise threshold use blob locators by default when saving thin assets; bundled mode always inlines.

### Header-only read

`readBabassetHeader(bytes)` returns guid/type/name/deps/chunk table **without allocating chunk payloads**. The asset registry indexes headers only — see [asset-registry.md](asset-registry.md).

### Editor documents

Scenes and Class logic graphs are `.babasset` files under `assets/` (`assets/main.scene.babasset`, `assets/main.class.babasset`). Legacy `.graph.babasset` still loads. `encodeAssetDocument` / `decodeAssetDocument` keep the JSON body in a single `document` chunk so type, schema version and guid stay header-only readable. Importers (Font, Texture, Model, …) often store structured data on **`header.payload`** with binary `source` / `pixels` chunks and no document chunk; `decodeAssetDocument` falls back to that header payload so those assets open in document workspaces. Settings-tab saves for those import types write `headerPayload` so binary chunks are not replaced by a document chunk. A document save keeps extra chunks (`extraChunksFromDecoded`) so font bytes are not wiped. Asset guids survive a re-save: an existing file's guid is read from its header rather than regenerated.

Projects authored before this move still load: `ProjectService` reads a `.json` document as an unversioned-or-versioned payload and writes it back in the same format. Nothing rewrites a legacy file into a container behind the user's back.

### Modes

- **thin** — dependencies by guid; large chunks may externalise to the blob store.
- **bundled** — dependency assets embedded as nested asset chunks; unpack on import remaps/dedupes.

Leaving a project (export / share) always produces a self-contained file (inline locators).

## .babtrace

Recorded Play sessions reuse the `.babasset` container with `type: "Trace"`. The JSON body is a `TracePayload` (seed, dt, frames with stats/logs/prints/snapshots/input). Files use the `.babtrace` extension; `encodeTraceDocument` / `decodeTraceDocument` wrap `encodeAssetDocument`. Debugger stays free of `@babylonslate/assets`.

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

- **Directory backend** — incremental writes (OPFS, iPad Documents / external folder, desktop). Folder name is the display name (`MyGame/`), not `MyGame.babproject/`. Existing `*.babproject` folders still open.
- **Zip backend** — single-file `.zip` (`fflate`); used for Export Project and interchange. Legacy Export Project `.babproject` zips still decode.

Web persists the directory layout into OPFS and offers Export Project as a `.zip` download. **Export Game** (itch zip) is a different artifact — see [exporter.md](exporter.md).

## `.babpack` (packaged games)

Packed export concatenates reached asset bytes into `boot.babpack` plus one `scene-<guid>.babpack` per additional scene. Magic `BPK1`, then a JSON index of `{ guid, offset, length, hash }` with **absolute file offsets** so HTTP `Range` maps 1:1. The player prefers range requests and falls back to a whole-pack fetch on range-blind hosts. Fonts stay inside packs (`FontFace` from bytes). This format is **export-only** — the editor project on disk stays one `.babasset` per asset (see Write performance in [vfs.md](vfs.md)).

### Derived data (outside the project)

App-private storage keyed by project guid: compiled scripts, thumbnails, import cache, recovery journal. Export Project ignores derived data by construction.

## Schema migration

- Each asset type owns ordered migrations `N → N+1`, applied on load.
- Future (unknown) versions refuse with a clear message **when a chain is registered**. Types with no chain (P9 UserInterface / Font / Sprite / AnimationGraph / Shader) pass through so a version-1 document is not treated as “newer than current 0”.
- Opening a project that needs migration prompts once; migrate-on-save; never silently rewrite untouched files. `ProjectService.saveDocument` / `saveProject` refuse a pending path until `approveMigrateOnSave()`.
- Golden fixtures: one committed `.babasset` per historical version per type — `graph-v0.babasset` (payload in header), `scene-v0.babasset` (payload in the document chunk, the shape the editor writes), `graph-v1.babasset` at current.
- The project manifest (`project.json`) migrates as type `Project` on load and is gated by the same approval.

## Golden / property tests

Byte-stable headers (sorted keys) enable content hashing and golden round-trips for both directory↔zip project backends and babasset encode/decode.
