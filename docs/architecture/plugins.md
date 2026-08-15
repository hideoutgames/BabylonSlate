# Plugins (P13)

Spec: [engineplan.md](../engineplan.md) §10, Appendix A `p13-*`. Implementation: `@babylonslate/assets` (`plugin-settings`, `plugin-host`, `plugin-package`, `starter-content`) plus editor chrome in `apps/editor`. Plugins are **content and classes only** — no native code, no extra script loader beyond the compiled-graph pipeline.

## Layout

**On-disk project plugin** (identity is the PluginSettings **asset guid**, not the folder name):

```
plugins/<folder>/<name>.plugin.babasset   # PluginSettings at the plugin root
plugins/<folder>/assets/                  # content root (own .blobs)
```

**`.babplugin` zip** uses the same codec as `.babproject` with `kind: "plugin"` ([containers.md](containers.md)). `plugin.json` is that **container manifest only**, derived from PluginSettings at export. In-project discovery scans for `type: "PluginSettings"`; it does **not** require `plugin.json` on disk.

**Engine plugins** live in repo `engine-plugins/` (directory form in git). Vite packs each folder to `public/engine-plugins/<id>.babplugin` plus `index.json` (static hosts cannot list directories). The editor fetches the index, unpacks into a **separate** Memory `ProjectStorage`, and mounts **read-only**. Engine plugins are never copied into the open project (that would dirty Export Project).

First engine plugin: `engine-plugins/starter-content/` — display name **Starter Content**, `enabledByDefault: false`, Actor class **StarterActor**, Lucide `Puzzle`, no artwork. Stable guids: plugin `c0ffee00-0000-4000-8000-000000000001`, class `c0ffee00-0000-4000-8000-000000000002`. `UPDATE_GOLDENS=1` rewrites the committed directory from `buildStarterContentFiles()`.

## PluginSettings

Header `type: "PluginSettings"`, document chunk, `isEditorOnlyAssetType` (stripped from Play / P14). Not a Content Browser **New Asset** type. **New Plugin** (Project Settings, or Content Browser when the project root is selected) creates the folder + PluginSettings.

| Field | Role |
| --- | --- |
| `displayName`, `pluginGuid` (= header guid), `version` (semver), `description`, `author`, `category`, `iconKey` | Identity. Optional Lucide key, not generated art |
| `experimental`, `beta` | Maturity badges; confirm before enable |
| `editorUtilityObjects` | Class ids this plugin boots in the editor ScriptHost (not `project.json`) |
| `enabledByDefault` | Layer 1 of enablement |
| `engineVersionRange`, `pluginDependencies[]` | `^` `~` `>=` `<` `x` exact via `semver-range.ts`; `ENGINE_VERSION` is still `"0.0.0"` |

Opened as DockView kind `plugin-settings` (Details panel). Identity includes a **read-only GUID** row (the PluginSettings asset guid — not editable, so `pluginOverrides` stay keyed). Engine plugin documents are **read-only**. Dependency status in Project Settings is Title Case (`Missing Dependency`, `Dependency Cycle`, `Engine Range`, `Unsatisfiable Range`).

## Enablement

Later wins:

1. PluginSettings `enabledByDefault`
2. `project.json` `pluginOverrides[guid].enabled` (editor uses 1–2)
3. Export-preset `pluginOverrides` (export only; P14)

Disable **unmounts** the content root — assets leave the registry. **Show Plugin Content** is a Content Browser **visibility** filter (`layout.json`, default off). AssetPicker / Play / search still see **enabled** plugin assets when the toggle is off. Extra tree roots appear when the toggle is on; engine roots show a Read Only badge and skip New / Import / Delete.

Override guids with **no discovered plugin** become Unresolved placeholders. Discovered PluginSettings guids are not indexed as placeholders (PluginSettings lives outside the mounted `assets/` root).

`project.json` `scenes` / `graphs` stay **project-root only**. `listDocumentPaths({ rootId: "project" })` must not leak `plugins/...` paths. Play / compile / search iterate `registry.list()` (all mounted roots).

## PluginHost

`discoverProjectPlugins` / `discoverEnginePlugins` → `resolvePluginGraph` (Kahn topo) → `mountEnabledPlugins`. Diagnostics: `plugin.cycle`, `plugin.unsatisfiable`, `plugin.missing`, `plugin.engine_unsatisfiable`. A cycle or unsatisfiable range **does not** zero the whole graph: independent plugins still mount; cycle members stay unmounted even if enabled. After mount, missing `header.dependencies` guids and override guids with no discovered plugin become `Unresolved` placeholders that **keep the guid** (`placeholder: true`). Remounting the plugin replaces the placeholder.

## Content roots

`ContentRoot` has `readOnly?` and `storage?` (default: registry project storage). Walk / create / delete / read use `root.storage ?? this.storage`. Writes throw on `readOnly`. Blobs are per root: `{pathPrefix}/.blobs` (project keeps `assets/.blobs`) so a `.babplugin` is self-contained.

`moveAsset` across roots throws (`Cross-root moves are not supported yet`). See [Cross-root moves](#cross-root-moves).

## Interchange

- **Export Plugin** — `encodeProjectZip` with `kind: "plugin"`, PluginSettings, `assets/`, per-plugin blobs. Download path matches Export Project.
- **Import Plugin** — unpack under `plugins/<safeName>/`. Dedupe by **plugin guid + version**; same guid+version → Keep / Replace; same guid newer/older version → update in place; guid remap only if the incoming PluginSettings guid collides with a **different** plugin (or another occupied guid). `.babplugin` files are never listed as assets.
- **Export Project** remains a full backup (includes disabled project plugins on disk).
- `collectEnabledPluginAssets(registry, enabledGuids)` is the P14 tree-shake helper; disabled roots are absent.

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
