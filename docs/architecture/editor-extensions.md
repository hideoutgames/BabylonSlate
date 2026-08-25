# Editor extensions (P12)

Editor-only types that never ship in Play or export. Spec: [engineplan.md](../engineplan.md) §7.4, §18 P12, Appendix A `p12-editor-extensions`.

## Types

| Type | Kind | File | Play / export |
| --- | --- | --- | --- |
| **EditorUtilityObject** | Class parent (`BObject`) | `*.class.babasset` | Stripped. Native events are Event Editor On Begin Play plus On Editor Startup / On Scene Open / On Scene Saved / On Editor Shutdown — not game Begin Play / Tick. Boot: construct → Editor On Begin Play → On Editor Startup → optional On Scene Open. |
| **EditorFunctionLibrary** | Class parent (`FunctionLibrary`) | `*.class.babasset` | Stripped. New Class parent list. Static Call Function rows only on editor graph hosts. |
| **SkyboxCreator** | Creatable helper (not a Skybox document) | `*.skyboxcreator.babasset` | Stripped like PluginSettings. Editor-only tool that slices a Texture into six skybox faces; the generated Textures are runtime assets and pack when a scene `SkyboxComponent` references them. |

`isEditorOnlyAsset` / `isEditorUtilityObjectClass` / `isEditorFunctionLibraryClass` / `isEditorGraphClass` / `isEditorGraphHost` in `@babylonslate/core` (`packages/core/src/editor-only.ts`) walk the parent chain. P14 export reuses the same helpers.

Runtime graphs (Actor, FunctionLibrary, …) never see EditorUtilityObject / EditorFunctionLibrary **or their functions**, even with Add Node **Context Sensitive** off. `NodeDefinition.editorOnly` marks catalog nodes (editor lifecycle events) — not a user Inspector flag. Hydrate stamps `data.__editorOnly`; GraphEditor draws an Editor Only hazard-tape footer (`--node-editor-only-tape` / `--node-editor-only-stripe`), like Development Only.

Leftover `.eui.babasset` files from the removed **EditorUtilityInterface** type are not a document kind and are not creatable. `isEditorOnlyAssetType("EditorUtilityInterface")` still treats that header type as editor-only so they never enter Play or export.

## Project Settings

`ProjectSettings.editorUtilityObjects` is a unique list of class ids. The General page adds classes via `ClassPicker` filtered to the EditorUtilityObject lineage.

Enabled plugins also contribute class ids from `PluginSettings.editorUtilityObjects`. The editor ScriptHost boots the merge (`mergePluginEditorUtilityObjects`) — plugin EUOs register on the plugin, not the project list, so enabling the plugin is the single switch. See [plugins.md](plugins.md).

## Editor ScriptHost

Not the Play worker. On project open it compiles registered EUO graphs (project list **plus** enabled plugin lists) and fires `onEditorStartup`. If a scene tab is already restored, it then fires `onSceneOpen`. Opening a scene later fires `onSceneOpen`; saving a scene fires `onSceneSaved`; closing the project fires `onEditorShutdown` once (the window event clears the started flag so host cleanup does not double-fire). Changing the Project Settings **EditorUtilityObject list** or enabling/disabling a plugin that registers EUOs disposes the host (`onEditorShutdown`) and boots the new list — unrelated `project.json` edits and Content Browser refreshes do not. Play compile (`collectPlayScriptDocuments`) drops editor-only class graphs (EUO / EFL). Packed game export (P14) reuses `isEditorOnlyAsset` (PluginSettings, SkyboxCreator, and leftover EditorUtilityInterface type strings are editor-only); project zip backup (`exportZip`) keeps editor tools.
