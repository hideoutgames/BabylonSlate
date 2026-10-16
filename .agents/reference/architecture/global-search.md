# Global Search

Project-wide search (toolbar and `Mod+K`): the on-demand `ProjectSearchIndex`, its lifecycle, ranking, UI rules and navigation.

## Ownership

| Area | Source |
| --- | --- |
| `ProjectSearchIndex`, entry kinds, ranking, `DEFAULT_SEARCH_LIMIT` (80) | [`packages/assets/src/search-index.ts`](../../../packages/assets/src/search-index.ts) |
| Header + `document` chunk range read (`readStoredAssetDocument`) | [`packages/assets/src/asset-document.ts`](../../../packages/assets/src/asset-document.ts) |
| Rebuild orchestration and open targets | [`apps/editor/src/context/project-search-context.tsx`](../../../apps/editor/src/context/project-search-context.tsx) |
| Dialog | [`apps/editor/src/components/global-search-dialog.tsx`](../../../apps/editor/src/components/global-search-dialog.tsx) |

## Why a second index

The asset registry is header-only and must never open payloads to scan a project. Search needs actor names, node titles and variable names inside Scene/Class `document` chunks, so it reads those small JSON chunks on demand; texture, mesh, audio and other binary bytes stay unloaded.

| Layer | Reads | Answers |
| --- | --- | --- |
| `AssetRegistry` | `.babasset` headers | guid, type, name, path, parentClass, dependencies |
| `ProjectSearchIndex` | headers + Scene/Class `document` chunks | substring hits over assets, actors, components, graph nodes, classes, variables |

## Entry kinds and targets

| Kind | Source | Opens |
| --- | --- | --- |
| `asset` | header name, type, path, guid, parentClass | Document tab when `documentKindForAssetType` maps it, else Content Browser reveal |
| `actor` / `component` | Scene `actors[]` and their `components[]` | Scene + select the (parent) actor |
| `graph-node` | graph `nodes[]` type, id, catalog title, short string properties | Class graph + focus node |
| `class` | Class headers + catalog engine class ids | Class graph tab; catalog-only ids are informational |
| `variable` | `variables.get` / `set` / `getValidated` `variableName` | Containing graph at that node |

Navigation reuses existing APIs (`openDocument` / `setActiveDocument`, `selectActor`, `setFocusDiagnostic`, Content Browser folder + tile selection); do not add parallel open paths.

## Lifecycle rules

- No warm index: do not build on project open, keep it across edits, upsert continuously or rebuild on import.
- Rebuild when the dialog opens, including open-document JSON so unsaved edits are searchable.
- Rebuild is async and chunked in time-budgeted slices (no frame-per-asset waits, no WKWebView freeze). It reads up to four documents ahead but adds entries one asset at a time in registry order; a failed read leaves that asset header-only.
- Each rebuild publishes an isolated snapshot only while current. Closing the dialog or a newer open cancels it and keeps the last snapshot; Close Project clears the index and invalidates pending work.
- Reads use the asset's root storage (`registry.storageFor(rootId)`), so enabled plugin content is searchable and disabled plugins are absent. Reads never touch the navmesh or reverb chunks and never charge the registry payload account.
- In memory only. Not indexed: ExecuteJavaScript bodies, binary payloads, any on-disk cache.

## Query

- Case-insensitive substring; an empty needle returns nothing.
- Lowercased label, description and keywords are stored at index time, never per keystroke.
- Rank tiers: exact label, label prefix, label substring, description, keyword; ties use `localeCompare`, then index order. `query` fills the cap tier by tier with a bounded sorted buffer instead of sorting every match.

## UI rules

- Toolbar button left of Settings (`global-search`), disabled with no project. `Mod+K` toggles on desktop.
- Large centered `Dialog` with fixed height (`h-[min(90svh,52rem)]`); results scroll in a native scroller (`global-search-results`). Keep the ~80-hit cap and do not window-virtualize this list.
- While indexing, show the pending empty state (`global-search-pending`) and hide stale results; queries wait for the snapshot.
- Results render from `useDeferredValue(needle)`; Enter and Up/Down re-query synchronously when the list lags the typed text. Enter is ignored during IME composition and while indexing.
- Results are grouped by kind with the Content Browser type icon and color. Focus stays in the query; Up/Down crosses groups, Enter opens, Escape closes, and the footer shows the keys as `Kbd`.
