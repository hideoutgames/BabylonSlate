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
| `asset` | Header name, type, path, guid, parentClass | Scene/Class → document tab; import/type assets → Settings tab; else Content Browser reveal |
| `actor` | Scene `actors[]` name, id, classId | Open scene + select actor |
| `component` | Actor `components[]` classId, id, short string properties | Open scene + select parent actor |
| `graph-node` | Graph `nodes[]` type, id, catalog title, short string properties | Open class graph + focus node |
| `class` | Class asset headers + catalog engine class ids | Class `.class.babasset` → graph tab; catalog-only ids are informational |
| `variable` | `variables.get` / `variables.set` name properties | Open containing graph at that node |

Out of v1: ExecuteJavaScript `body` text, binary payloads, on-disk search cache.

`ProjectSearchIndex` reads document chunks from the asset’s **root** storage (`registry.storageFor(rootId)`), so enabled plugin Scene/Class documents are searchable. Disabled plugins are unmounted and absent from the index.

## Lifecycle

- **Rebuild** on project open and `remountRegistry`.
- **Upsert** one asset after `saveDocument`, and from in-memory Scene/Graph content after `applySceneChange` / `applyGraphChange` so unsaved edits are searchable before the autosave write.
- **Remove** when an asset is deleted.
- **Clear** on Close Project.

In-memory only, keyed by the open project. Query is case-insensitive substring; empty needle returns no rows (cap ~80 hits).

## UI

- Toolbar icon left of Settings (`data-testid="global-search"`), disabled with no project.
- Centered `Dialog` (`data-testid="global-search-dialog"`), larger than default (`sm:max-w-2xl`), fixed height `h-[min(90svh,52rem)]` with `overflow-hidden` (same cap as catalog dialogs).
- Results live in a native scroller (`data-testid="global-search-results"`, `min-h-0 flex-1 overflow-y-auto`) so long hit lists scroll instead of growing the popup.
- Results grouped by kind, each hit showing the same type icon/color as the Content Browser. `Ctrl/Cmd+K` toggles on desktop.

## Navigation

Reuse existing APIs: `openDocument` / `setActiveDocument`, `selectActor`, `setFocusDiagnostic` (graph node id), Content Browser folder + tile selection for non-document assets.
