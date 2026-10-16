# Editor scripting

Editor Utility Objects and Editor Function Libraries are classes that run inside the editor, so you can build your own tools with visual scripting. They never run in Play or in exported games.

## Create an Editor Utility Object

1. Create a Class with **EditorUtilityObject** as its parent. See [Classes](classes.md). Its graph starts with the editor events below.
2. Build the tool's logic.
3. In **Project Settings > General**, find **Editor Utility Objects**, choose **Add Class** and pick your class.

The editor starts every listed class when the project opens. Changing the list shuts the running tools down and starts the new list. [Plugins](../projects/plugins.md) can bring their own Editor Utility Objects, which start when the plugin is enabled.

## Editor events

| Event | When it runs |
| --- | --- |
| [Event Editor On Begin Play](class/event-editor-on-begin-play.md) | First, when the editor loads the class. |
| [Event On Editor Startup](class/event-on-editor-startup.md) | Next, when the project's editor tools start. |
| [Event On Scene Open](class/event-on-scene-open.md) | When a scene is opened. Also runs at startup if a scene is already open. |
| [Event On Scene Saved](class/event-on-scene-saved.md) | When a scene is saved. |
| [Event On Editor Shutdown](class/event-on-editor-shutdown.md) | When the project closes or the tools restart. |

Editor Utility Objects have no **Event Begin Play** or **Event Tick**.

## Editor Function Libraries

An **EditorFunctionLibrary** is a [Function Library](functions.md#function-libraries) for editor tools. Its functions appear in **Add Node** only in Editor Utility Object and Editor Function Library graphs.

## Editor-only nodes

Some nodes exist only in editor tool graphs and show a striped **Editor Only** footer. They include nodes that create and edit [Data Trees](data.md):

- [Create Data Tree](class/create-data-tree.md) and [List Data Trees](class/list-data-trees.md).
- [Add Data Entry](class/add-data-entry.md), [Update Data Entry](class/update-data-entry.md), [Move Data Subtree](class/move-data-subtree.md), [Remove Data Subtree](class/remove-data-subtree.md) and [Reorder Data Children](class/reorder-data-children.md).
- [Read Editable Data Tree](class/read-editable-data-tree.md) and [Read Editable Data Entry](class/read-editable-data-entry.md).

These nodes wait until the change finishes, then report **Success** and an **Error** message. Entry edits can be undone like any other edit; a new Data Tree is saved as a file straight away.

## Notes

- Editor tools cannot use [Get Game Instance](class/get-game-instance.md) or the subsystem Get nodes, because no game is running.
- Editor tool classes are left out of exported games.
- For tools written in JavaScript or TypeScript with access to project files, see [Editor Extensions](../projects/extensions.md).
