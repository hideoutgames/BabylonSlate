# Editor extensions

Engine and Project Extensions run editor-only JavaScript or TypeScript tools over
assets and project source files. They have their own packages and activation host.
The existing P12 graph-based editor utility types remain available alongside them.
Spec: [engineplan.md](../engineplan.md) §10.7 and §18 P12.

## Engine and Project Extensions

| Scope | Storage and behavior |
| --- | --- |
| Engine Extensions | Protected bundles in `engine-extensions/` plus the app-owned user library. **Engine Settings → Engine Extensions** manages defaults for new projects, archive downloads, and confirmed deletion of user entries. Bundled entries cannot be deleted or replaced. |
| Project Extensions | Editable `extensions/<folder>/extension.json` and a package-relative `.ts` or `.js` entry. **Project Settings → Project Extensions** provides enable toggles, maturity badges, dependency diagnostics, commands, New, Import, Export, and editing of settings/source. |

New projects copy the Engine library into editable Project Extensions. Later
library changes do not rewrite those copies. Existing projects retain the bundled
read-only fallback without acquiring newly added user-library entries. A project
copy shadows an Engine extension with the same stable `extensionGuid`.

The manifest stores name, GUID, version, description, author, category, Lucide
icon, Experimental/Beta flags, `enabledByDefault`, engine version, extension
dependencies and entry point. `project.json` stores enable overrides by GUID.
Enabling Experimental/Beta code requires maturity confirmation. Missing or
disabled dependencies and cycles block activation; recorded version differences
appear as diagnostics.
Malformed manifests and duplicate IDs remain visible as disabled recovery entries.
They cannot activate or export; deleting a broken project package leaves healthy
extensions available.

Import/export uses a separate `.babextension` zip with an Extension manifest;
`.babplugin` remains the content-plugin format. Project exports can be downloaded
or added to the Engine library. Replacing imported executable code requires
confirmation, and imported Project Extensions remain disabled until enabled.
Archive inspection validates paths, entry presence and package limits: 64 MiB
compressed, 256 MiB expanded, 4096 files, 1 MiB entry source and 256 KiB manifest.

Extension folders do not mount as runtime content roots and their modules are
absent from Play and packed games. An extension-created asset in `assets/` is an
ordinary project asset and follows the normal runtime dependency/export rules.
Project folder backups retain the extension sources.

## Code entry and editor API

An entry exports `activate(api)` using ESM or CommonJS. Activation may be async
and may return an async or synchronous cleanup function. TypeScript is transpiled
without type checking. The first version accepts one entry module and rejects
module imports, re-exports, `require`, dynamic imports and type-only imports.
Extensions execute as trusted editor code; the host is not a security sandbox.

| API | Contract |
| --- | --- |
| `registerCommand({ id, title, description?, fields?, execute })` | Adds a command to the extension's Project Settings entry and returns an unregister function. Fields are `text` or `multiline` with ID, label, optional default and required flag; `execute(values)` receives strings. |
| `assets.list()` / `assets.read(path)` | List registered asset headers and read an asset document. |
| `assets.create(path, { type, name, payload })` | Create a supported JSON document asset under `assets/` with a `.babasset` suffix. Existing paths are rejected. |
| `assets.update(path, document)` | Update a supported project JSON asset while preserving its GUID/type. Updates to open documents are blocked; close the tab first. |
| `code.read(path)` / `code.write(path, source)` | Read/write project `.ts` or `.js` files under `code/`. Writing source does not automatically compile or load it into the game. |
| `materials.convertGlsl(source, options?)` | Convert a supported fragment shader to a Material document or diagnostics; this call does not save an asset. |
| `log(message)` | Write an extension-tagged editor diagnostic. |

The project lifetime owns activation and registered commands. Disabling,
replacing/reloading code or closing the project removes commands and runs cleanup.
Old API references stop accepting calls after deactivation. Activation, command
and cleanup failures surface as extension diagnostics. The host drains outstanding
API operations before releasing project storage. Cleanup failures remain visible
after reload or disable and are also written to the editor diagnostic log.

## Bundled GLSL to Material

**GLSL to Material** is an Experimental Engine Extension, disabled by default.
Enable it in Project Extensions, run its command, enter a Material Name and GLSL
Source, and optionally name the declared UV and Time variables to bind. Success
creates `assets/<name>.material.babasset`; an existing filename or failed
conversion leaves the destination unchanged.

The result contains ordinary editable material nodes and has no extension or
Custom GLSL dependency. The converter reports unsupported syntax before saving.
See [the supported GLSL subset](shader-graph.md#glsl-to-material-conversion) for
input restrictions, numeric semantics and rendering limitations.

## Graph-based editor utility types (P12)

| Type | Kind | File | Play / export |
| --- | --- | --- | --- |
| **EditorUtilityObject** | Class parent (`BObject`) | `*.class.babasset` | Stripped. Native events are Event Editor On Begin Play plus On Editor Startup / On Scene Open / On Scene Saved / On Editor Shutdown — not game Begin Play / Tick. Boot: construct → Editor On Begin Play → On Editor Startup → optional On Scene Open. |
| **EditorFunctionLibrary** | Class parent (`FunctionLibrary`) | `*.class.babasset` | Stripped. New Class parent list. Static Call Function rows only on editor graph hosts. |
| **SkyboxCreator** | Creatable helper (not a Skybox document) | `*.skyboxcreator.babasset` | Stripped like PluginSettings. Editor-only tool that slices a Texture into six skybox faces; the generated Textures are runtime assets and pack when a scene `SkyboxComponent` references them. |

`isEditorOnlyAsset` / `isEditorUtilityObjectClass` / `isEditorFunctionLibraryClass` / `isEditorGraphClass` / `isEditorGraphHost` in `@babylonslate/core` (`packages/core/src/editor-only.ts`) walk the parent chain. P14 export reuses the same helpers.

Runtime graphs (Actor, FunctionLibrary, …) never see EditorUtilityObject / EditorFunctionLibrary **or their functions**, even with Add Node **Context Sensitive** off. `NodeDefinition.editorOnly` marks catalog nodes (editor lifecycle events) — not a user Inspector flag. Hydrate stamps `data.__editorOnly`; GraphEditor draws an Editor Only hazard-tape footer (`--node-editor-only-tape` / `--node-editor-only-stripe`), like Development Only.

Leftover `.eui.babasset` files from the removed **EditorUtilityInterface** type are not a document kind and are not creatable. `isEditorOnlyAssetType("EditorUtilityInterface")` still treats that header type as editor-only so they never enter Play or export.

## Editor utility registration

`ProjectSettings.editorUtilityObjects` is a unique list of class ids. The General page adds classes via `ClassPicker` filtered to the EditorUtilityObject lineage.

Enabled plugins also contribute class ids from `PluginSettings.editorUtilityObjects`. The editor ScriptHost boots the merge (`mergePluginEditorUtilityObjects`) — plugin EUOs register on the plugin, not the project list, so enabling the plugin is the single switch. See [plugins.md](plugins.md).

## Editor ScriptHost

Not the Play worker. On project open it compiles registered EUO graphs (project list **plus** enabled plugin lists) and fires `onEditorStartup`. If a scene tab is already restored, it then fires `onSceneOpen`. Opening a scene later fires `onSceneOpen`; saving a scene fires `onSceneSaved`; closing the project fires `onEditorShutdown` once (the window event clears the started flag so host cleanup does not double-fire). Changing the Project Settings **EditorUtilityObject list** or enabling/disabling a plugin that registers EUOs disposes the host (`onEditorShutdown`) and boots the new list — unrelated `project.json` edits and Content Browser refreshes do not. Play compile (`collectPlayScriptDocuments`) drops editor-only class graphs (EUO / EFL). Packed game export (P14) reuses `isEditorOnlyAsset` (PluginSettings, SkyboxCreator, and leftover EditorUtilityInterface type strings are editor-only); project zip backup (`exportZip`) keeps editor tools.
