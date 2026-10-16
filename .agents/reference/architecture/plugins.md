# Plugins

Content plugins: PluginSettings identity, discovery and enablement, mounted content roots, engine plugins, `.babplugin` interchange and export.

## Decisions

- A plugin is **content and classes only**: one `PluginSettings` asset plus its own `assets/` root. No native code and no script loader beyond the compiled-graph pipeline. Editor-only code tools are [editor extensions](editor-extensions.md), a separate format.
- Identity is the PluginSettings **asset guid** (`pluginGuid` = header guid), never the folder name, so `pluginOverrides` stay keyed. The Inspector shows it read-only.
- Enablement layers, later wins: PluginSettings `enabledByDefault` < `project.json` `pluginOverrides[guid].enabled` (editor uses these two) < export-preset `pluginOverrides` (export / Preview Build only).
- Version differences (engine or dependency) are **warnings** and never block mounts, editor utilities, Play or export. Missing or disabled dependencies and cycles block the affected plugin and its dependents; independent plugins still mount.
- A missing plugin never loses data: unresolved guids become guid-keeping `Unresolved` placeholders, replaced when the plugin mounts again.
- Cross-root moves are rejected (`Cross-root moves are not supported yet`). A future move needs a fix-up pass (copy bytes and per-root blobs, keep the guid, rewrite blob locators, drop the asset from `project.json` lists, confirm inbound refs). Until then duplicate-then-delete, which assigns a new guid.
- Out of scope: native plugins, a marketplace, Content Browser drag between roots.

## Ownership

| Area | Source |
| --- | --- |
| PluginSettings schema and defaults | [`plugin-settings.ts`](../../../packages/assets/src/plugin-settings.ts) |
| Discovery, shadowing, dependency graph, mounting, placeholders, diagnostics | [`plugin-host.ts`](../../../packages/assets/src/plugin-host.ts) |
| `.babplugin` export, inspect, import planning, engine library install | [`plugin-package.ts`](../../../packages/assets/src/plugin-package.ts) |
| Starter Content generator | [`starter-content.ts`](../../../packages/assets/src/starter-content.ts), committed tree [`engine-plugins/starter-content/`](../../../engine-plugins/starter-content/) |
| Engine plugin catalog build | [`apps/editor/vite-engine-plugins.ts`](../../../apps/editor/vite-engine-plugins.ts) |
| Read-only and HTTP catalog storage | [`read-only-storage.ts`](../../../packages/vfs/src/read-only-storage.ts), [`http-catalog-storage.ts`](../../../packages/vfs/src/http-catalog-storage.ts) |
| Editor utility merge, Project Settings rows | [`apps/editor/src/lib/plugin-ui.ts`](../../../apps/editor/src/lib/plugin-ui.ts) |
| Export layer-3 resolution | [`apps/editor/src/services/export-game.ts`](../../../apps/editor/src/services/export-game.ts) (`resolveExportPluginGraph`) |

## Layout and format

- On disk: `plugins/<folder>/<name>.plugin.babasset` (PluginSettings at the plugin root) and `plugins/<folder>/assets/` with its own `.blobs`, so a `.babplugin` is self-contained ([containers.md](containers.md)).
- `.babplugin` uses the project-tree codec with `kind: "plugin"`; `plugin.json` is the container manifest only, derived at export. In-project discovery scans for `type: "PluginSettings"` and never needs `plugin.json`. Archives are never listed as assets.
- PluginSettings is editor-only (`isEditorOnlyAssetType`), stripped from Play and export, and not a New Asset type; **New Plugin** in Project Settings creates the folder and settings.
- Fields: `displayName`, `pluginGuid`, author-controlled string `version`, `description`, `author`, `category`, optional Lucide `iconKey` (never generated art), `experimental` / `beta` (confirm before enable), `editorUtilityObjects`, `enabledByDefault`, recorded `engineVersion` and `pluginDependencies[] { guid, version }`.
- Compatibility stamps are recorded automatically from `release/version.json` and installed dependency versions only when the author Version or a plugin-owned asset document actually changes; reads, imports, re-exports and metadata-only saves preserve them.

## Host pipeline

`discoverProjectPlugins` / `discoverEnginePlugins` → `shadowEnginePlugins` (a project guid hides the engine original; one Project Settings row) → `resolvePluginGraph` (topological, over the enabled set) → `mountEnabledPlugins` → `indexUnresolvedPlaceholders`.

| Diagnostic | Severity |
| --- | --- |
| `plugin.engine_unsatisfiable`, `plugin.unsatisfiable` (recorded vs installed version) | Warning |
| `plugin.missing`, `plugin.cycle`, `plugin.dependency_blocked` (transitive) | Error |

- Mounted plugins are `plugin:<guid>` content roots ([asset-registry.md](asset-registry.md)); engine roots are `readOnly` and skip New / Import / Delete. Disabling unmounts, so its assets leave the registry.
- Toggling a discovered plugin reuses the last discovery and only changes mounts; a new override guid, new engine storage or a project rescan rediscovers.
- `project.json` `scenes` / `graphs` stay project-root only (`listDocumentPaths({ rootId: "project" })` must not leak `plugins/…`). Play, compile and search iterate `registry.list()`.
- **Show Plugin Content** (Project Settings → Plugins, persisted in `layout.json`, default off) only hides tree roots; pickers, Play and search still see enabled plugin assets.

## Engine plugins

- Bundled plugins live in repo `engine-plugins/` (directory form). Vite emits each file as a content-addressed `content/<sha256>` part listed in `index.json`, plus `public/engine-plugins/<id>.babplugin`. The editor mounts `index.json` through a read-only `HttpCatalogStorageAdapter` that fetches parts on demand and never downloads the archives. A missing or invalid index yields empty read-only storage.
- **Engine Settings → Engine Plugins** combines bundled entries with user-exported archives in the app-owned `__slate_engine_plugins__` library (excluded from the project list). Bundled entries cannot be deleted or replaced.
- New projects copy the library into `plugins/<folder>/` with the same guids and the chosen default enabled state; later library changes never modify project copies. Opening an existing project copies nothing new; the bundled read-only fallback remains.
- Starter Content: `enabledByDefault: false`, Actor class StarterActor, Lucide `Puzzle`, no artwork, stable guids `c0ffee00-0000-4000-8000-000000000001` (plugin) and `…0002` (class). `UPDATE_GOLDENS=1` regenerates the committed tree from `buildStarterContentFiles()`.

## Interchange and export

- Export Plugin (to download or to the Engine Plugins library) uses `encodeProjectZip` with `kind: "plugin"`. Library name/guid collisions need a Replace confirmation; bundled collisions are errors.
- Import unpacks under `plugins/<safeName>/`. Dedupe by plugin guid + version: same guid and version → Keep / Replace; same guid, other version → update in place (asset ids kept); the plugin guid is remapped only if it collides with a different plugin or asset. A fresh install remaps colliding asset guids and rewrites references inside the pack. Placeholders do not count as collisions.
- Import validates relative paths and portable filename conflicts first, stages replacement outside discovery and backs up the installed tree; a failed replacement restores it (not atomic across a process crash).
- Game export resolves plugins after project and preset overrides (`resolveExportPluginGraph`), then `collectExportReachability` walks only enabled roots ([exporter.md](exporter.md)). A separate registry loads preset-enabled plugins without changing editor mounts. Disabled plugins ship nothing, including their subsystems. Export Project is a full backup.
- Mounted plugins' `editorUtilityObjects` merge with the project list (`mergePluginEditorUtilityObjects`); enabling the plugin is the single switch ([editor-extensions.md](editor-extensions.md)).
