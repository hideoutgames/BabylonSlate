# Plugins (P13)

Spec: [engineplan.md](../engineplan.md) §10, Appendix A `p13-*`. Implementation: `@babylonslate/assets` (`plugin-settings`, `plugin-host`, `plugin-package`, `starter-content`) plus editor chrome in `apps/editor`. Plugins are **content and classes only** — no native code, no extra script loader beyond the compiled-graph pipeline.

## Layout

**On-disk project plugin** (identity is the PluginSettings **asset guid**, not the folder name):

```
plugins/<folder>/<name>.plugin.babasset   # PluginSettings at the plugin root
plugins/<folder>/assets/                  # content root (own .blobs)
```

**`.babplugin` zip** uses the same project-tree codec as a project folder / `.zip` with `kind: "plugin"` ([containers.md](containers.md)). `plugin.json` is that **container manifest only**, derived from PluginSettings at export. In-project discovery scans for `type: "PluginSettings"`; it does **not** require `plugin.json` on disk.

**Bundled engine plugins** live in repo `engine-plugins/` (directory form in git). Vite packs each folder to `public/engine-plugins/<id>.babplugin` plus `index.json`. The editor fetches the index and unpacks into a separate Memory `ProjectStorage` wrapped read-only (`createReadOnlyProjectStorage` — writes throw).

**Engine Settings → Engine Plugins** combines bundled entries with user-exported `.babplugin` archives in the app-owned `__slate_engine_plugins__` library. Each entry has a persistent **Enabled By Default** toggle and a download-only **Export** action. User-added entries also have **Delete**, with confirmation; bundled entries cannot be deleted or replaced. Library entries have no asset-editing controls. The app-owned library is excluded from the project list.

**New projects** (empty / 2D scaffold and `createFromTemplate`) capture the library and copy each plugin into `plugins/<folder>/` with the same guids and chosen default enabled state, making the copies editable. Existing template copies are retained. Later library defaults, replacement, or deletion do not modify project copies. Opening an existing project does not copy user library entries; the existing bundled read-only fallback remains. A project plugin with guid X shadows the bundled plugin with guid X (one Project Settings row). Deleting a project copy can unmask the bundled original again.

First engine plugin: `engine-plugins/starter-content/` — display name **Starter Content**, `enabledByDefault: false`, Actor class **StarterActor**, Lucide `Puzzle`, no artwork. Stable guids: plugin `c0ffee00-0000-4000-8000-000000000001`, class `c0ffee00-0000-4000-8000-000000000002`. `UPDATE_GOLDENS=1` rewrites the committed directory from `buildStarterContentFiles()`.

## PluginSettings

Header `type: "PluginSettings"`, document chunk, `isEditorOnlyAssetType` (stripped from Play / P14). Not a Content Browser **New Asset** type. **New Plugin** (Project Settings only) creates the folder + PluginSettings.

| Field | Role |
| --- | --- |
| `displayName`, `pluginGuid` (= header guid), `version` (semver), `description`, `author`, `category`, `iconKey` | Identity. Optional Lucide key, not generated art |
| `experimental`, `beta` | Maturity badges; confirm before enable |
| `editorUtilityObjects` | Class ids this plugin boots in the editor ScriptHost (not `project.json`) |
| `enabledByDefault` | Layer 1 of enablement |
| `engineVersionRange`, `pluginDependencies[]` | `^` `~` `>=` `<` `x` exact via `semver-range.ts`; `ENGINE_VERSION` is still `"0.0.0"` |

Opened as DockView kind `plugin-settings` (Details panel). Identity includes a **read-only GUID** row (the PluginSettings asset guid — not editable, so `pluginOverrides` stay keyed). **Icon Key** is a searchable dropdown with Lucide previews; **Default** clears the override. Engine Version Range is read-only: new plugins receive `^ENGINE_VERSION`, while existing/imported compatibility constraints are preserved. **Add Dependency** selects another installed plugin and starts with its version range; self and duplicate choices are excluded. Dependencies can be removed, and missing plugins remain visible for repair. Engine plugin documents are read-only. Saving PluginSettings refreshes discovered metadata, diagnostics, and mounted roots immediately.

Project Settings shows the selected icon immediately after the plugin name, and independent **Experimental** and **Beta** badges. Enabling a flagged plugin names its maturity in the confirmation. Dependency status includes `Missing Dependency`, `Dependency Cycle`, `Engine Range`, `Unsatisfiable Range`, and `Blocked Dependency`.

## Enablement

Later wins:

1. PluginSettings `enabledByDefault`
2. `project.json` `pluginOverrides[guid].enabled` (editor uses 1–2)
3. Export-preset `pluginOverrides` (export / Preview Build only; consumed by `collectExportClosure` in `@babylonslate/exporter`)

Disable **unmounts** the content root — assets leave the registry. **Show Plugin Content** is a Project Settings → Plugins **Switch** (`settings-show-plugin-content`, persisted in `layout.json`, default off). **New Plugin** turns it on automatically. Turning the switch off while the Content Browser is inside a plugin folder resets the grid to project `assets` (path-prefix check, not `rootId`). AssetPicker / Play / search still see enabled plugin assets when the tree is hidden. Extra tree roots appear when shown; only each base plugin folder uses its selected icon, while descendant folders retain the folder glyph. Unknown/unset keys fall back to the folder glyph. Engine roots show a Read Only badge and skip New / Import / Delete.

Override guids with **no discovered plugin** become Unresolved placeholders. Discovered PluginSettings guids are not indexed as placeholders (PluginSettings lives outside the mounted `assets/` root).

`project.json` `scenes` / `graphs` stay **project-root only**. `listDocumentPaths({ rootId: "project" })` must not leak `plugins/...` paths. Play / compile / search iterate `registry.list()` (all mounted roots).

## PluginHost

`discoverProjectPlugins` / `discoverEnginePlugins` → `shadowEnginePlugins` (project guid hides the engine original) → `resolvePluginGraph` (Kahn topo) → `mountEnabledPlugins`. Mounting and Project Settings diagnostics resolve the enabled plugin set, so a disabled prerequisite is unavailable. Diagnostics: `plugin.cycle`, `plugin.unsatisfiable`, `plugin.missing`, `plugin.engine_unsatisfiable`, and transitive `plugin.dependency_blocked`. Invalid plugins and their dependents stay unmounted; independent plugins still mount. After mount, missing `header.dependencies` guids and override guids with no discovered plugin become `Unresolved` placeholders that keep the guid (`placeholder: true`). Remounting the plugin replaces the placeholder.

## Content roots

`ContentRoot` has `readOnly?` and `storage?` (default: registry project storage). Walk / create / delete / read use `root.storage ?? this.storage`. Writes throw on `readOnly`. Blobs are per root: `{pathPrefix}/.blobs` (project keeps `assets/.blobs`) so a `.babplugin` is self-contained.

`moveAsset` across roots throws (`Cross-root moves are not supported yet`). See [Cross-root moves](#cross-root-moves).

## Interchange

- **Export Plugin** — opens a modal offering **Export To Download** or **Export To Engine Plugins**. Both use `encodeProjectZip` with `kind: "plugin"`, PluginSettings, `assets/`, and per-plugin blobs. Engine-library duplicate names (case-insensitive) or GUIDs require a separate **Replace** confirmation for user-added entries, preserving their global default; bundled collisions give an error. Cancelling leaves the existing entry intact. Engine Settings Export only downloads.
- **Import Plugin** — unpack under `plugins/<safeName>/`. Dedupe by **plugin guid + version**; same guid+version → Keep / Replace; same guid newer/older version → update in place; guid remap only if the incoming PluginSettings guid collides with a **different** plugin (or another occupied guid). `.babplugin` files are never listed as assets.
- **Export Project** remains a full backup (includes disabled project plugins on disk).
- `collectEnabledPluginAssets(registry, enabledGuids)` plus export-preset layer-3 overrides feed the P14 tree-shake. Disabled roots are absent from the itch zip / Preview pack. See [exporter.md](exporter.md).

## Editor ScriptHost

Enabled plugins’ `editorUtilityObjects` merge with `ProjectSettings.editorUtilityObjects` (`mergePluginEditorUtilityObjects`). Plugin EUOs register on the plugin, not the project list — enabling the plugin is the single switch. See [editor-extensions.md](editor-extensions.md).

## Cross-root moves

Dragging an asset from project content into a plugin (or between plugins) changes which root owns a guid. A naive file move would leave inbound `header.dependencies` pointing at the old path’s root while the guid stayed the same — Show References would still work **by guid**, but blob locators, relative import paths, and `project.json` scene/graph lists would be wrong if the move also crossed the project-root document filter.

P13 therefore **rejects** `moveAsset` when `asset.rootId !== destRootId`. A future Content Browser affordance needs an explicit fix-up pass:

1. Copy bytes + per-root blobs into the destination `{pathPrefix}/.blobs`.
2. Keep the guid (references stay valid).
3. Rewrite any blob locators that assumed `assets/.blobs`.
4. If the asset is a Scene/Class that lived on the project root, drop it from `project.json` `scenes`/`graphs` (Play still finds it via `registry.list()` while the plugin is enabled).
5. Confirm inbound refs from other roots (same dialog as disable-plugin).

Until that pass exists, duplicate-then-delete in the destination root is the workaround, and it **must** assign a new guid (duplicate already does).
