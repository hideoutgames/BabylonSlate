# The Editor at a Glance

A quick tour of the editor window: the toolbar, document tabs, the Content Browser and the panels around a scene.

## Toolbar

The top bar shows the project name and the document tabs. The toolbar sits below it.

| Area | Controls |
| --- | --- |
| Left | **Save All** (a dot means something is unsaved), **Undo** and **Redo**. A Class adds **Compile**; a Material adds **Render**; a scene adds the scene mode picker (**Design**, **Landscape**, **Foliage**). |
| Centre | **Play** (it reads **Preview** or **Simulate** for those Play Modes) and the **Debug** menu with Play options. While a Simulation runs, **Simulate** becomes a red **Stop** with **Pause**, a **Game** / **Edit** input toggle and **Return To Scene** beside it ([Simulate controls](../debugging/index.md#simulate-controls)). |
| Right | **Windows**, **Focus**, **Search Project** and **Settings** (**Project Settings** and **Engine Settings**). |

## Document tabs

Every asset you open becomes a document tab.

- The **Content Browser** tab is always first and cannot be closed.
- The open scene sits next to it. Only one scene is open at a time; opening another scene replaces it and asks you to save first if needed.
- Other documents scroll to the right. Hold a tab, then drag it to reorder.
- The **Open Documents** menu at the end of the strip lists every tab and has **Close** for the active document and **Close Open Tab(s)**.

## Content Browser

The Content Browser shows your project's folders on the left and the assets in the selected folder on the right. Double-tap an asset to open it. See [Content Browser](../editor/content-browser.md).

## Scene panels

A scene opens with these windows:

| Window | Use |
| --- | --- |
| Viewport | The 3D or 2D view of the scene. Select, move and frame actors here. |
| Outliner | Every actor in the scene, in folders and parent–child order. |
| Inspector | Settings for the selected actor and its components. |
| Output Log | Messages from the editor and from Play. |
| Compiler Results | Errors and warnings from compiling scripts. |

Other asset editors have their own windows, such as **Preview** and **Inspector** for a Texture. See [Scenes](../scenes/index.md) and [Actors](../scenes/actors.md).

## Windows and Focus

- **Windows** lists the windows the active document can show. Tick or untick one to show or hide it.
- **Focus** (<kbd>Mod</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd>) hides every window except the main one, such as the viewport or the graph. Choose it again to restore the layout.

Drag a window's tab to dock it somewhere else. See [Windows and Layout](../editor/index.md).

## Status bar

The bar at the bottom shows the save state (for example **All Changes Saved** or **2 Unsaved Documents**), the number of errors and the active document's name. Phones do not show it.

## On a phone

Phones and narrow windows use a compact layout:

- The Content Browser button and an **Open Documents** menu replace the tab strip.
- **More Tools** (the ⋯ button) holds the Debug menu, Windows, Search Project and Settings.
- Each document shows one window at a time. Pick another with the window picker at the bottom.
