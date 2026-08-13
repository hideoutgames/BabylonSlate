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
| `type` | Asset type id (e.g. `Texture`, `Scene`, `Graph`) |
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

Inline locators point at byte ranges after the header. Blob locators name `assets/.blobs/<sha256>` inside a project. Chunks above the externalise threshold use blob locators by default when saving thin assets; bundled mode always inlines.

### Header-only read

`readBabassetHeader(bytes)` returns guid/type/name/deps/chunk table **without allocating chunk payloads**. The asset registry indexes headers only — see [asset-registry.md](asset-registry.md).

### Editor documents

Scenes and graphs are `.babasset` files under `assets/` (`assets/main.scene.babasset`, `assets/main.graph.babasset`). `encodeAssetDocument` / `decodeAssetDocument` keep the JSON body in a single `document` chunk so type, schema version and guid stay header-only readable. Asset guids survive a re-save: an existing file's guid is read from its header rather than regenerated.

Projects authored before this move still load: `ProjectService` reads a `.json` document as an unversioned-or-versioned payload and writes it back in the same format. Nothing rewrites a legacy file into a container behind the user's back.

### Modes

- **thin** — dependencies by guid; large chunks may externalise to the blob store.
- **bundled** — dependency assets embedded as nested asset chunks; unpack on import remaps/dedupes.

Leaving a project (export / share) always produces a self-contained file (inline locators).

## .babtrace

Recorded Play sessions reuse the `.babasset` container with `type: "Trace"`. The JSON body is a `TracePayload` (seed, dt, frames with stats/logs/prints/snapshots/input). Files use the `.babtrace` extension; `encodeTraceDocument` / `decodeTraceDocument` wrap `encodeAssetDocument`. Debugger stays free of `@babylonslate/assets`.

## .babproject / .babplugin

One logical tree, two backends behind one codec, parameterized by **manifest kind** (`project` | `plugin`):

```
MyGame.babproject/          (directory)  or  MyGame.babproject (zip)
  project.json              # or plugin.json for kind=plugin
  layout.json               # editor dock layout (projects only)
  assets/                   # .babasset tree = Content Browser tree
    .blobs/                 # content-addressed immutable chunks
  plugins/                  # project plugins (kind=project only)
```

- **Directory backend** — incremental writes (iPad Documents / external folder / desktop).
- **Zip backend** — single-file zip (`fflate`); used for web Export Project and interchange.

Web persists the directory layout into OPFS and offers Export Project as a zip download.

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
