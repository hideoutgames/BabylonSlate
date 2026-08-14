# Editor extensions (P12)

Editor-only types that never ship in Play or export. Spec: [engineplan.md](../engineplan.md) §7.4, §18 P12, Appendix A `p12-editor-extensions`.

## Types

| Type | Kind | File | Play / export |
| --- | --- | --- | --- |
| **EditorUtilityObject** | Class parent (`BObject`) | `*.class.babasset` | Stripped. Native events are On Editor Startup / On Scene Open / On Scene Saved / On Editor Shutdown — not Begin Play / Tick. |
| **EditorUtilityInterface** | Creatable asset | `*.eui.babasset` | Stripped. Payload is a UserInterface document plus `dockKind: "scene" \| "class"`. |

`isEditorOnlyAsset` / `isEditorUtilityObjectClass` in `@babylonslate/core` walk the parent chain. P14 export reuses the same helpers.

## Live tabs

- **Windows → Editor Utilities** lists EUI assets whose header `dockKind` matches the active document (Scene → `"scene"`, Class → `"class"`). Missing `dockKind` normalizes to `"scene"`. They are **not** in the Scene default layout.
- Opening a utility adds a Dockview panel (`eui-<guid>`, component `editor-utility`). Last placement is stored in `layout.json` like any other tab. Focus keep-lists can include them.
- The panel hosts Babylon GUI through `createUiSurface` + `presentAdtToCanvas` on the **shared Engine**. It never `registerView`s the GUI canvas. Interactive picking is forwarded from the 2D canvas into the standalone ADT. Hidden tabs call `UiSurface.setFrozen(true)` so ADT Canvas2D copies (`present`, `markDirty`, pointer `afterPick`) skip. Close disposes the Scene and ADTs. Hard present failures show the same **Babylon GUI Preview Unavailable** Empty as the designer (`ui-gui-preview-error`).

## Project Settings

`ProjectSettings.editorUtilityObjects` is a unique list of class ids. The General page adds classes via `ClassPicker` filtered to the EditorUtilityObject lineage. Only those classes load into the in-process editor `ScriptHost`.

## Editor ScriptHost

Not the Play worker. On project open it compiles registered EUO graphs and fires `onEditorStartup`. If a scene tab is already restored, it then fires `onSceneOpen`. Opening a scene later fires `onSceneOpen`; saving a scene fires `onSceneSaved`; closing the project fires `onEditorShutdown` once (the window event clears the started flag so host cleanup does not double-fire). Changing the Project Settings **EditorUtilityObject list** disposes the host (`onEditorShutdown`) and boots the new list — unrelated `project.json` edits and Content Browser refreshes do not. Play compile (`collectPlayScriptDocuments`) drops EUO class graphs and never merges EUI `logic` into the HUD library (UserInterface only). Packed game export (P14) reuses `isEditorOnlyAsset`; project zip backup (`exportZip`) keeps editor tools.

## Authoring

Opening an EUI asset uses the UserInterface document kind (`"ui"`) on Dockview: Design / Hierarchy / Details / Logic plus Settings (`dockKind`). Live-run stays **Windows → Editor Utilities**.
