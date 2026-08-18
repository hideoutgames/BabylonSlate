# Editor extensions (P12)

Editor-only types that never ship in Play or export. Spec: [engineplan.md](../engineplan.md) §7.4, §18 P12, Appendix A `p12-editor-extensions`.

## Types

| Type | Kind | File | Play / export |
| --- | --- | --- | --- |
| **EditorUtilityObject** | Class parent (`BObject`) | `*.class.babasset` | Stripped. Native events are Event Editor On Begin Play plus On Editor Startup / On Scene Open / On Scene Saved / On Editor Shutdown — not game Begin Play / Tick. Boot: construct → Editor On Begin Play → On Editor Startup → optional On Scene Open. |
| **EditorUtilityInterface** | Creatable asset | `*.eui.babasset` | Stripped. Payload is a UserInterface document plus `dockKind: "scene" \| "class"`. Live Logic: Event Editor On Begin Play and widget events; no Tick. |
| **EditorFunctionLibrary** | Class parent (`FunctionLibrary`) | `*.class.babasset` | Stripped. New Class parent list. Static Call Function rows only on editor graph hosts. |

`isEditorOnlyAsset` / `isEditorUtilityObjectClass` / `isEditorFunctionLibraryClass` / `isEditorGraphClass` / `isEditorGraphHost` in `@babylonslate/core` (`packages/core/src/editor-only.ts`) walk the parent chain. P14 export reuses the same helpers.

Runtime graphs (Actor, UserInterface, FunctionLibrary, …) never see EditorUtilityObject / EditorUtilityInterface / EditorFunctionLibrary **or their functions**, even with Add Node **Context Sensitive** off. `NodeDefinition.editorOnly` marks catalog nodes (editor lifecycle events) — not a user Inspector flag. Hydrate stamps `data.__editorOnly`; GraphEditor draws an Editor Only hazard-tape footer (`--node-editor-only-tape` / `--node-editor-only-stripe`), like Development Only.

## Live tabs

Creating an EditorUtilityInterface asset (`.eui.babasset`) **is** registration into **Windows → Editor Utilities**. There is no Project Settings / Plugin Settings list for interfaces (EditorUtility**Object** classes stay on that list). Widgets are not auto-inserted into the Scene default layout.

- **Windows → Editor Utilities** on Scene / Class lists EUI assets whose `dockKind` matches the active document (Scene → `"scene"`, Class → `"class"`). Missing `dockKind` normalizes to `"scene"`. **Class-dock utilities** (`dockKind: "class"`) appear on Class documents (`assets/main.class.babasset`, `document-workspace-graph`), not Scene. Open (possibly dirty) document payloads win over stale registry headers, so an unsaved `dockKind` change moves the menu entry immediately. Saving an EUI still reindexes the `.babasset` header.
- **Windows on a UserInterface / EUI authoring tab** lists every project EUI. Choosing one **activates the matching Scene or Class host** (opens it if needed) and then opens `eui-<guid>` on **that** dock — never on the authoring Designer/Logic DockView. Designer **Open Live** (`ui-open-live`) on an EditorUtilityInterface Design toolbar runs the same host + toggle path for the current asset. UserInterface Design does not show Open Live.
- Empty submenu copy: **No Editor Utility Interfaces In This Project** when the project has none; **None For This Document** when EUIs exist but none match this Scene/Class. The empty testid stays `windows-editor-utilities-empty`.
- Opening a utility adds a Dockview panel (`eui-<guid>`, component `editor-utility`). Last placement is stored in `layout.json` like any other tab. Opening live from an authoring tab **activates** an already-open host panel rather than toggling it closed. Focus **keeps already-open** `eui-*` tabs even when Engine Settings has a non-empty keep list (they are not silently closed). Changing `dockKind` while a live tab is open closes it on the old dock rather than orphaning it.
- The panel hosts Babylon GUI through `createUiSurface` + `presentAdtToCanvas` on the **shared Engine**. It never `registerView`s the GUI canvas. Resize/present is rAF-coalesced (`createUiFrameScheduler`). Pointer forwarding captures the **primary** pointer only, then release, wheel, and keyboard (`InputText.processKeyboard`); pick errors are isolated. `attachAdtCanvasPointers` calls `prepareAdtForExternalPresent` **before** `adt.pick`, then a full `_checkUpdate(null)`, then the blit — empty-area hits must not leave an invalidate-rect clip that `clearRect`+`drawImage` copies as a blank frame. Frozen surfaces skip pick and blit (`isFrozen`). Destination `canvas.width` / `height` are assigned only when the ADT size actually changed, and only after that full redraw (assigning width clears the bitmap). Empty canvas hits must not close `eui-*` or fall through to the Scene viewport. Interactive widgets emit `UiWidgetEvent` (click / value / checked / text / pointer enter / exit / press / release). Each open panel loads its own `payload.logic` into an editor-only `ScriptHost` (Event Editor On Begin Play once when the panel host loads; **no** rAF Tick; disposed with the panel) and never adds that graph to Play/export. Freeze follows **panel visibility**, not whether the host Scene/Class tab is the active document. Hard present failures show **Babylon GUI Preview Unavailable** (`ui-gui-preview-error`). Touch uses Pointer Events + `touch-none`; it is supported. E2E (`interactWithUtilityCanvas`) asserts the live canvas still has painted pixels after an empty-corner click, not only that the panel is open.

## Project Settings

`ProjectSettings.editorUtilityObjects` is a unique list of class ids. The General page adds classes via `ClassPicker` filtered to the EditorUtilityObject lineage.

Enabled plugins also contribute class ids from `PluginSettings.editorUtilityObjects`. The editor ScriptHost boots the merge (`mergePluginEditorUtilityObjects`) — plugin EUOs register on the plugin, not the project list, so enabling the plugin is the single switch. See [plugins.md](plugins.md).

## Editor ScriptHost

Not the Play worker. On project open it compiles registered EUO graphs (project list **plus** enabled plugin lists) and fires `onEditorStartup`. If a scene tab is already restored, it then fires `onSceneOpen`. Opening a scene later fires `onSceneOpen`; saving a scene fires `onSceneSaved`; closing the project fires `onEditorShutdown` once (the window event clears the started flag so host cleanup does not double-fire). Changing the Project Settings **EditorUtilityObject list** or enabling/disabling a plugin that registers EUOs disposes the host (`onEditorShutdown`) and boots the new list — unrelated `project.json` edits and Content Browser refreshes do not. **Each live EditorUtilityInterface panel** also hosts that asset’s `payload.logic` in a separate editor-only `ScriptHost` (widget events + Event Editor On Begin Play; no Tick). Play compile (`collectPlayScriptDocuments`) drops editor-only class graphs (EUO / EFL) and never merges EUI `logic` into the HUD library (UserInterface only). Packed game export (P14) reuses `isEditorOnlyAsset` (PluginSettings is editor-only); project zip backup (`exportZip`) keeps editor tools.

## Authoring

Opening an EUI asset uses the UserInterface document kind (`"ui"`): chrome **Designer | Logic** mode bar, then dual DockView catalogs. Designer: Design / Hierarchy / Details plus Settings (`dockKind`). Logic: Class docks on `payload.logic` (Graph / Class / Inspector / Compiler Results). Live-run stays **Windows → Editor Utilities** (or Designer **Open Live**), which opens the live tab on the Scene/Class host rather than the authoring dock. See [ui-runtime.md](ui-runtime.md).
