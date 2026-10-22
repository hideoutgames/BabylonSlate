# Undo and Saving

Each document keeps its own Undo history. Save All writes every change, and auto-save does it for you at a set interval.

## Undo and Redo

| Action | Toolbar | Keyboard |
| --- | --- | --- |
| Undo | **Undo** | <kbd>Mod</kbd>+<kbd>Z</kbd> |
| Redo | **Redo** | <kbd>Mod</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> or <kbd>Mod</kbd>+<kbd>Y</kbd> |

- Undo and Redo act on the active document only. Switching tabs switches history.
- Dragging a gizmo, even across several selected actors, is one Undo step.
- Undo history is not saved with the project.
- Edits brought back by [recovery](#recovery-after-a-crash) cannot be undone.

Set limits in **Engine Settings > Undo**:

| Setting | Description |
| --- | --- |
| Undo History Length | Maximum Undo steps per document. Default 50, up to 1000. |
| Undo Memory Limit (MB) | Memory each document's history may use. Default 16, from 1 to 1024. |

An edit larger than the memory limit still applies, but a **Can't Be Undone** notice appears and that document's earlier history is cleared.

## What Undo does not cover

These actions change files or settings directly and cannot be undone:

- Content Browser operations: new folders, imports, rename, move, copy and delete. Delete asks you to confirm first.
- Changes in **Project Settings** and **Engine Settings**.
- Deleting a plugin, an extension or a preview save.

## Save All

Choose **Save All** in the toolbar or press <kbd>Mod</kbd>+<kbd>S</kbd>. It saves every changed document and the project settings. A dot on the button means something is unsaved.

The status bar shows the state: **All Changes Saved**, **2 Unsaved Documents**, **Unsaved Project Changes**, **Unrecovered Edits**, **Auto-Saving…** or **All Changes Auto-Saved**. A dot in front of it means something is unsaved or unrecovered. An asterisk marks unsaved documents in the **Open Documents** menu.

## Auto-save

Haptic saves automatically a set time after you start editing. Change the interval with **Project Settings > General > Auto-Save Interval (Seconds)** (default 120, at least 1).

If an auto-save fails or pauses, the status bar shows **Auto-Save Failed — Use Save All**. Choose **Save All** to save your changes yourself.

**Compile On Save** (on by default, in the same section) compiles your scripts each time you save.

Auto-save pauses while the **Unsaved Documents** prompt is open, so **Discard** drops what the prompt lists. It starts a new interval when you choose **Cancel**.

When you start **Play** with unsaved changes, **Play Without Saving** runs your current edits without saving them first. Auto-save can still save them later. It waits while **Play** or **Preview Build** runs, and starts a new interval once you are back in the editor.

## Closing with unsaved changes

Closing a tab, closing the project or opening another scene while something is unsaved opens **Unsaved Documents**:

- **Save All** saves, then continues.
- **Discard** drops the unsaved changes and continues.
- **Cancel** keeps everything open.

## Recovery after a crash

Haptic records your edits as you work. If the app closes before you save, you can get them back:

- On the Homepage, **Recover Previous Session?** offers **Recover** and **Dismiss**.
- In the editor, the **Recover Unsaved Edits?** notice above the status bar offers **Recover Edits** and **Discard**.

Until you choose **Recover Edits** or **Discard**, the notice stays and the status bar shows **Unrecovered Edits**. Save All, auto-save, **Save & Play** and closing the project or a document do not settle it. Edits you make after reopening the project are saved as usual and are not replayed when you recover.

Recovered edits are unsaved until you choose **Save All**, and they cannot be undone.

## Files changed outside Haptic

When you return to Haptic after another app changed the project's files, for example after a Git pull, Haptic checks for changes:

| Prompt | When | Choices |
| --- | --- | --- |
| Reload Project | Many files or `project.json` changed | **Reload Project** or **Keep Open** |
| File Changed On Disk | A document with unsaved edits changed | **Reload From Disk** (loses your edits) or **Keep Edits** |
| Reload From Disk | Open documents without unsaved edits changed | **Reload From Disk** or **Keep Open** |
