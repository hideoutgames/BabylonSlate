# Editor Extensions

Editor-only tooling: Engine and Project Extensions (trusted JS/TS modules with an editor API) and the graph-based EditorUtilityObject, EditorFunctionLibrary and SkyboxCreator types.

## Decisions

- Two separate mechanisms. **Extensions** are editor-only JavaScript/TypeScript packages with their own manifest, archive (`.hextension`) and activation host. **Editor utility types** are ordinary graph assets run by the editor ScriptHost. Content plugins (`.hplugin`, [plugins.md](plugins.md)) are a third, content-only format.
- Extensions execute as **trusted editor code**; the host is not a security sandbox. Imported Project Extensions stay disabled until enabled, and replacing imported executable code requires confirmation.
- Extension folders never mount as content roots and their modules never reach Play or packed games. Assets an extension creates under `assets/` are ordinary project assets.
- Editor-only assets and graphs are stripped from Play and export by one set of helpers; runtime graphs never see editor utility classes, their functions or editor-only nodes, even with Context Sensitive off.
- The removed EditorUtilityInterface type (`.eui.hasset`) is not a document kind and not creatable; its header type stays editor-only so leftovers never enter Play or export. The game HUD / UserInterface is removed and must not return through this path.

## Ownership

| Area | Source |
| --- | --- |
| Manifest (`extension.json`, `extensions/` dir, 256 KiB cap) | [`extension-settings.ts`](../../../packages/assets/src/extension-settings.ts) |
| Discovery, shadowing, dependency resolution | [`extension-host.ts`](../../../packages/assets/src/extension-host.ts) |
| `.hextension` inspect / import / export and limits | [`extension-package.ts`](../../../packages/assets/src/extension-package.ts) |
| Activation, transpile, command registry, API lifetime | [`apps/editor/src/lib/editor-extension-host.ts`](../../../apps/editor/src/lib/editor-extension-host.ts) |
| Project lifetime, refresh, diagnostics | [`apps/editor/src/services/editor-extension-service.ts`](../../../apps/editor/src/services/editor-extension-service.ts) |
| Engine library and bundled catalog | [`engine-extension-library.ts`](../../../apps/editor/src/lib/engine-extension-library.ts), [`engine-extensions.ts`](../../../apps/editor/src/lib/engine-extensions.ts), [`engine-extensions/`](../../../engine-extensions/) |
| Editor-only predicates | [`packages/core/src/editor-only.ts`](../../../packages/core/src/editor-only.ts) |
| Editor ScriptHost for utility graphs | [`editor-utility-scripts.ts`](../../../apps/editor/src/lib/editor-utility-scripts.ts), [`editor-utility-runtime.tsx`](../../../apps/editor/src/components/editor-utility-runtime.tsx) |

## Extensions

| Scope | Storage |
| --- | --- |
| Engine Extensions | Protected bundles in `engine-extensions/` plus an app-owned user library. Engine Settings → Engine Extensions manages new-project defaults, downloads and confirmed deletion of user entries; bundled entries cannot be deleted or replaced. |
| Project Extensions | Editable `extensions/<folder>/extension.json` plus a package-relative `.ts`/`.js` entry. Project Settings → Project Extensions: enable, maturity badges, diagnostics, commands, New / Import / Export, settings and source editing. |

- New projects copy the Engine library into editable Project Extensions; later library changes never rewrite copies. A project copy shadows an Engine extension with the same stable `extensionGuid`. `project.json` stores enable overrides by guid.
- Manifest: `kind: "extension"`, `formatVersion`, `extensionGuid`, display name, version, description, author, category, Lucide `iconKey`, `experimental` / `beta` (confirm on enable), `enabledByDefault`, `engineVersion`, `extensionDependencies`, `entryPoint`.
- Missing or disabled dependencies and cycles block activation; version differences are diagnostics only. Malformed manifests and duplicate ids stay visible as disabled recovery entries that cannot activate or export.
- Archive limits: 64 MiB compressed, 256 MiB expanded, 4096 files, 1 MiB entry source, 256 KiB manifest; paths are validated before writing.

### Code entry

- The entry exports `activate(api)` (ESM or CommonJS), may be async and may return a cleanup function. TypeScript is transpiled with `ts.transpileModule` without type checking.
- One module only: imports, re-exports, `require`, dynamic imports and type-only imports are rejected. Extensions use the `api` object, never repository modules.
- API surface: `registerCommand` (fields are `text`/`multiline` strings), `assets.list/read/create/update` (JSON `.hasset` under `assets/`; updates to open documents are refused), `code.read/write` (`.ts`/`.js` under `code/`; writing never compiles or loads into the game), `materials.convertGlsl` (no save), `log`. The type lives in `editor-extension-host.ts`.
- The project owns activation and commands. Disable, reload or project close removes commands, runs cleanup and invalidates old API references; the host drains outstanding API calls before releasing storage. A refresh with unchanged packages keeps running extensions and retries only failed ones and their dependents. Failures surface as extension diagnostics.

### GLSL to Material

The bundled Experimental extension ([`engine-extensions/glsl-to-material/`](../../../engine-extensions/glsl-to-material/)), disabled by default, calls `materials.convertGlsl` and saves `assets/<name>.material.hasset` only on success; an existing filename or failed conversion leaves the destination unchanged. The result is ordinary Material nodes with no extension or Custom GLSL dependency ([shader-graph.md](shader-graph.md)).

## Editor utility types

| Type | Kind | Notes |
| --- | --- | --- |
| EditorUtilityObject | Class parent (`Object`), `*.class.hasset` | Events: Editor On Begin Play, On Editor Startup, On Scene Open, On Scene Saved, On Editor Shutdown. Never game Begin Play / Tick |
| EditorFunctionLibrary | Class parent (`FunctionLibrary`), `*.class.hasset` | Static Call Function rows only on editor graph hosts |
| SkyboxCreator | `*.skyboxcreator.hasset` helper | Slices a Texture into six skybox faces; the generated Textures are runtime assets and ship when a `SkyboxComponent` references them |

- `isEditorOnlyAssetType` / `isEditorOnlyAsset` / `isEditorUtilityObjectClass` / `isEditorFunctionLibraryClass` / `isEditorGraphClass` / `isEditorGraphHost` walk the parent chain; Play compile (`collectPlayScriptDocuments`) and export reuse them. Editor-only types: PluginSettings, SkyboxCreator, EditorUtilityInterface. Export Project keeps editor tools.
- `NodeDefinition.editorOnly` marks catalog nodes (editor lifecycle events), not a user flag. Hydrate stamps `data.__editorOnly`; GraphEditor draws the Editor Only hazard-tape footer.
- Registration: `ProjectSettings.editorUtilityObjects` (unique class ids, General page `ClassPicker`) merged with enabled plugins' `PluginSettings.editorUtilityObjects` (`mergePluginEditorUtilityObjects`).

## Editor ScriptHost

- Not the Play worker. On project open it compiles the registered utility graphs and fires `onEditorStartup`, then `onSceneOpen` if a scene tab is restored. Later scene opens fire `onSceneOpen`, saves fire `onSceneSaved`, and project close fires `onEditorShutdown` exactly once.
- Changing the utility list or toggling a plugin that registers utilities disposes the host (`onEditorShutdown`) and boots the new list. Unrelated `project.json` edits and Content Browser refreshes do not reboot it.
