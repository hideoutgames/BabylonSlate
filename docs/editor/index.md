# Windows and Layout

The editor shows each open asset as a document tab, and each document arranges its own windows, such as a viewport, an Outliner and an Inspector. You can rearrange, hide and focus those windows, and Haptic remembers the layout per document.

## Documents and tabs

- Double-tap an asset tile in the **Content Browser** grid to open it as a document. If it is already open, its tab comes forward. In the folder tree beside the grid, double-tapping a name renames it instead.
- The **Content Browser** tab is always first and cannot be closed.
- One scene is open at a time. Its tab sits next to the Content Browser; opening another scene replaces it.
- Hold a tab, then drag it sideways to reorder. The **Open Documents** menu at the end of the strip lists every tab and can close one or all of them.
- <kbd>Alt</kbd>+<kbd>Page Down</kbd> and <kbd>Alt</kbd>+<kbd>Page Up</kbd> move between documents; <kbd>Alt</kbd>+<kbd>W</kbd> closes the active one.

Closing a document with unsaved changes asks whether to save. When you reopen the project, your tabs come back.

## Arrange windows

- Drag a window's tab to dock it beside, above or below another window, or into another window's tab group. On a touch screen, hold the tab first.
- Drag the divider between windows to resize them.
- Each document keeps its own arrangement.

## The Windows menu

**Windows** in the toolbar lists the windows the active document can show. Tick a window to show it, untick it to hide it. A window you show again returns to where it was. The last visible window cannot be hidden.

Windows is unavailable for documents that have a single fixed view, including the Content Browser.

## Focus

**Focus** (<kbd>Mod</kbd>+<kbd>Shift</kbd>+<kbd>F</kbd>) hides every window except the document's main one, such as the viewport, graph or preview, so it can use the whole space. Choose **Focus** again to bring the other windows back.

To keep more windows visible in Focus, open **Engine Settings > Focus**. It lists each editor; add the windows that should stay.

Focus is not available in the phone layout.

## Narrow toolbars

The toolbar measures the room it has. When it cannot show everything, controls move into the **More Actions** menu (the ⋮ button), in this order: **Focus**, **Windows**, **Search Project**, **Settings**, **Undo** and **Redo**, **Return To Scene**, the scene mode picker, **Debug Instance**, the compilation error indicator, then **Compile** or **Render**. **Save All**, **Play** or **Simulate**, the Simulation's **Pause**, **Stop** and **Game** / **Edit** input toggle and the **Debug** menu always stay. Menu entries keep their shortcuts and disabled state, and the controls come back when the window widens.

## Phone layout

On phones, and in narrow windows, the editor switches to a compact layout:

- Each document shows one window at a time. Pick another with the window picker at the bottom of the screen.
- Windows cannot be dragged, and Focus is not available.
- The Content Browser button and the **Open Documents** menu replace the tab strip.
- **More Tools** (the ⋯ button) holds the Debug menu, Windows, Search Project and Settings.
- The toolbar's **More Actions** menu (the ⋮ button) appears when a running Simulation or a Class leaves too little room, and holds the controls that no longer fit.

Widening the window, for example leaving Split View on iPad, returns to the full layout.

## In this section

- [Content Browser](content-browser.md)
- [Importing Assets](importing.md)
- [Global Search](search.md)
- [Undo and Saving](undo-and-saving.md)
- [Settings](settings.md)
