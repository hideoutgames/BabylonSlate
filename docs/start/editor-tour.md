# The Editor at a Glance

A quick tour of the editor window: the toolbar, document tabs, the Content Browser and the panels around a scene.

## Toolbar

The top bar shows the project name and the document tabs. The toolbar sits below it.

| Area | Controls |
| --- | --- |
| Left | **Save All** (a dot means something is unsaved), **Undo** and **Redo**. A Class adds **Compile**; a Material adds **Render**; a scene adds the scene mode picker (**Design**, **Landscape**, **Foliage**, **Script**, **Timeline**). |
| Centre | **Play** (it reads **Preview** or **Simulate** for those Play Modes) and the **Debug** menu with Play options. While a Simulation runs, **Simulate** becomes a red **Stop** with **Pause**, a **Game** / **Edit** input toggle and **Return To Scene** beside it, plus a **Debug Instance** picker while a Class, Behaviour Tree or Animation Graph is open ([Simulate controls](../debugging/index.md#simulate-controls)). |
| Right | **Windows**, **Focus**, **Search Project** and **Settings** (**Project Settings** and **Engine Settings**). |

### Narrow windows

When the window is too narrow for the whole toolbar, the least important controls move into the **More Actions** menu (the ⋮ button before the right-hand controls). They keep their names, shortcuts and disabled state, and return as soon as there is room again. **Save All**, **Play** or **Simulate**, the Simulation controls (**Pause**, **Stop**, **Game** / **Edit**) and the **Debug** menu never move.

## Document tabs

Every asset you open becomes a document tab.

- The **Content Browser** tab is always first and cannot be closed.
- The open scene sits next to it. Only one scene is open at a time; opening another scene replaces it and asks you to save first if needed.
- Other documents scroll to the right. Hold a tab, then drag it to reorder.
- The **Open Documents** menu at the end of the strip lists every tab and has **Close** for the active document and **Close Open Tab(s)**.
- A text property opened in its own tab (see [Long text and code](#long-text-and-code)) is a tab too. It is never saved with the project's layout and closes when you select something else.

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

Tap a result in **Compiler Results** to select its node or actor, and double-tap it to open the graph or viewport that shows it, framed on the problem. A result Play reported for another class opens that class. Right-click or hold a result for **Open**, **Copy Error** (or **Copy Warning**) and **Copy Details**.

### When Play cannot start

Play needs every asset the game loads at the start. When one does not exist, is saved in a format Haptic cannot read, or cannot be read, Play does not start:

- The **Play Could Not Start** dialog (**Simulation Could Not Start** for a Simulation) lists each problem. Each row names the asset and the actor, component and setting that use it, such as `2D Rich Text on "Dialogue" in Scene Layer "HUD" uses an asset that does not exist: … (Text).` Tap a row to open that Scene, Scene Layer or class with the actor or component selected.
- **Compiler Results** lists the same problems; double-tap one to go to it the same way.
- The **Output Log** shows each problem in full.

When a project setting names the missing asset, such as **Startup Scene** or **Game Instance**, the row names the setting in **Project Settings** instead. Fix the reference, or remove it, and press Play again. Other preparation failures show in the **Output Log**, or in a **Play Failed** dialog when no Output Log is open.

Other asset editors have their own windows, such as **Preview** and **Inspector** for a Texture. See [Scenes](../scenes/index.md) and [Actors](../scenes/actors.md).

Number fields show their unit after the value, such as **45°**, **120 ms** or **50%**. You can type the unit or leave it out. Drag a field's handle to change the value, or type a sum such as `90+45`. While you drag, round values such as 0.1, 0.25, 1, 10 and 100 hold for a moment, so they are easy to land on; keep dragging to move past them. **Number Snap Strength** in **Engine Settings > Accessibility** sets how long they hold, or turns this off.

With several items selected, such as nodes or components, the **Inspector** shows only the properties they all have, and a field whose values differ shows **Mixed Values**. A value you set applies to every item, as one undo step. In a number field, a plain number sets them all, while a sum that starts from **Mixed Values**, such as `Mixed Values+4` or `Mixed Values*2`, changes each item from its own value; dragging the handle does the same.

Right-click or hold a property, or its name, in any **Inspector** for **Copy** and **Paste**. **Copy** keeps the value for the rest of the session and also puts it on the clipboard as text. **Paste** is available only where the copied value fits:

- The same kind of property: a number, a vector with the same axes, a color, an on/off value, text, or an option the list has.
- A number and a slider take each other's value, kept within the property's range. A color and a color with alpha take each other's color; the alpha stays.
- An asset of a type the property takes. An empty asset property knows its types in component and node settings; elsewhere it takes only an asset of the type it already holds.

**Copy** is unavailable when a property shows **Mixed Values**, and **Paste** in read-only Inspectors such as Play's. While you are typing in a text field, right-click shows the usual text menu instead.

### Long text and code

Multi-line properties, such as a text component's **Text**, a Math Expression's **Formula**, a **Function Body** or a plugin's **Description**, are edited right in the **Inspector**. The field keeps a fixed height and scrolls when the text is longer. Your change applies when you leave the field.

To edit with more room, tap the button next to the property name (**Open … in Tab**). The text opens full size in a new document tab named after the property and its asset, such as **Formula: Player Class**. Changes apply when you leave the editor or switch tabs, and the **Inspector** shows them. Closing the tab returns to the asset. The tab belongs to the property: it closes when you select something else, delete the item or close its asset.

## Windows and Focus

- **Windows** lists the windows the active document can show. Tick or untick one to show or hide it.
- **Focus** (<kbd>Mod</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd>) hides every window except the main one, such as the viewport or the graph. Choose it again to restore the layout.

Drag a window's tab to dock it somewhere else. See [Windows and Layout](../editor/index.md).

## Status bar

The bar at the bottom shows the save state (for example **All Changes Saved** or **2 Unsaved Documents**) and the number of errors. Phones do not show it.

## On a phone

Phones and narrow windows use a compact layout:

- The Content Browser button and an **Open Documents** menu replace the tab strip.
- **More Tools** (the ⋯ button) holds the Debug menu, Windows, Search Project and Settings.
- Each document shows one window at a time. Pick another with the window picker at the bottom.
