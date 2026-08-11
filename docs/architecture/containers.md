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

`readBabassetHeader(bytes)` returns guid/type/name/deps/chunk table **without allocating chunk payloads**. The asset registry (P2) depends on this invariant.

### Modes

- **thin** — dependencies by guid; large chunks may externalise to the blob store.
- **bundled** — dependency assets embedded as nested asset chunks; unpack on import remaps/dedupes.

Leaving a project (export / share) always produces a self-contained file (inline locators).

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
- Future (unknown) versions refuse with a clear message.
- Opening a project that needs migration prompts once; migrate-on-save; never silently rewrite untouched files.
- Golden fixtures: one committed `.babasset` per historical version per type.

## Golden / property tests

Byte-stable headers (sorted keys) enable content hashing and golden round-trips for both directory↔zip project backends and babasset encode/decode.
