# Global search

Post-P6 editor discovery (engineplan §7.5). Implementation: `ProjectSearchIndex` in `@babylonslate/assets`, dialog and navigation in `apps/editor`.

## Why a second index

The asset registry is **header-only** ([asset-registry.md](asset-registry.md)): it must not open payloads to scan a project. Global search needs actor names, graph node titles, and variable strings that live in Scene/Class **document** JSON chunks. Those chunks are small text; texture/mesh/audio bytes stay unloaded.

| Layer | Reads | Answers |
| --- | --- | --- |
| `AssetRegistry` | `.babasset` headers | guid, type, name, path, parentClass, dependencies |
| `ProjectSearchIndex` | headers + Scene/Class (and legacy Graph) `document` chunks | substring query over assets, actors, components, graph nodes, classes, variables |

## Entry kinds

| Kind | Source | Open target |
| --- | --- | --- |
| `asset` | Header name, type, path, guid, parentClass | Scene/Class/Model/Skeleton/Animation and other DockView types → document tab; Texture / Audio → Settings tab; else Content Browser reveal |
| `actor` | Scene `actors[]` name, id, classId | Open scene + select actor |
| `component` | Actor `components[]` classId, id, short string properties | Open scene + select parent actor |
| `graph-node` | Graph `nodes[]` type, id, catalog title, short string properties | Open class graph + focus node |
| `class` | Class asset headers + catalog engine class ids | Class `.class.babasset` → graph tab; catalog-only ids are informational |
| `variable` | `variables.get` / `variables.set` `variableName` (legacy `name`) | Open containing graph at that node |

Out of v1: ExecuteJavaScript `body` text, binary payloads, on-disk search cache.

`ProjectSearchIndex` reads document chunks from the asset’s **root** storage (`registry.storageFor(rootId)`), so enabled plugin Scene/Class documents are searchable. Disabled plugins are unmounted and absent from the index.

## Lifecycle

**P20** (`p20-search-on-demand`) drops the warm index. Until that slice lands, today's code still rebuilds on project open / `remountRegistry` and upserts after save/edit.

Target lifecycle:

- Do **not** rebuild on project open or keep a warm index across edits.
- **Rebuild when Global Search is initiated** (toolbar / `Ctrl/Cmd+K` opens the dialog). Include **open document** JSON so unsaved edits are in that snapshot.
- Rebuild is **async / chunked** (yield between assets) so open does not freeze WKWebView. Query waits until that rebuild finishes (empty/spinner while pending). Cancel an in-flight rebuild if the dialog closes or a newer open starts.
- Drop continuous upsert / rebuild-on-import as the source of truth.
- **Clear** on Close Project.
- Result cap ~80 stays; the result body is **not** virtualised (`p20-log-virtualize` windows `SearchDialog` pick lists, not this hit list).
- Still no on-disk search cache, no ExecuteJavaScript body, no binary payloads.

In-memory only, keyed by the open project. Query is case-insensitive substring; empty needle returns no rows.

## UI

- Toolbar icon left of Settings (`data-testid="global-search"`), disabled with no project.
- Centered `Dialog` (`data-testid="global-search-dialog"`), larger than default (`sm:max-w-2xl`), fixed height `h-[min(90svh,52rem)]` with `overflow-hidden` (same cap as catalog dialogs).
- While a rebuild is pending, the body is empty/spinner; queries wait until the snapshot is ready.
- Results live in a native scroller (`data-testid="global-search-results"`, `min-h-0 flex-1 overflow-y-auto`) so long hit lists scroll instead of growing the popup. Cap ~80; do not window-virtualise this list.
- Results grouped by kind, each hit showing the same type icon/color as the Content Browser. `Ctrl/Cmd+K` toggles on desktop.

## Navigation

Reuse existing APIs: `openDocument` / `setActiveDocument`, `selectActor`, `setFocusDiagnostic` (graph node id), Content Browser folder + tile selection for non-document assets.
