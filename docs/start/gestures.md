# Touch Gestures

Haptic is built for touch first: buttons, taps and gestures cover the editor, and a mouse and keyboard add right-click and shortcuts.

## Everywhere

| Gesture | Result |
| --- | --- |
| Tap | Select or activate. |
| Hold still about half a second | Open the context menu (same as right-click). Moving your finger first cancels it. |
| Hold a window's tab, then drag | Move the window to another dock position. |
| Hold a document tab, then drag sideways | Reorder document tabs. |
| Swipe the tab strip | Scroll through open documents. |

Text fields keep the system's own selection, copy and paste menus.

## Viewport

| Gesture | 3D | 2D |
| --- | --- | --- |
| Tap | Select an actor. | Select an actor. |
| One-finger drag | Look around from the camera position. With **Pivot Around Center** on, orbit instead. | Pan the view. |
| Hold, then drag | — | Draw a selection rectangle. |
| Pinch | Zoom toward the view centre. | Zoom around your fingers. |
| Three-finger drag | Fly: drag sideways to strafe, up and down to move forward and back. | Pan the view. |

- Hold Ctrl, Command or Shift while tapping to add to the selection.
- **Drag Select** in the viewport toolbar turns the next one-finger drag into a selection rectangle, in 2D and 3D.
- Turn on **Joystick** in the viewport's settings menu for an on-screen stick that moves the camera.
- Double-tap an actor in the **Outliner** to frame it in the viewport.

## Graphs

Class, Material, Animation Graph, Behaviour Tree and Particle Graph editors share these gestures.

| Gesture | Result |
| --- | --- |
| One-finger drag on empty space | Pan. |
| Pinch | Zoom between 10% and 150%. |
| Double-tap empty space | Open **Add Node** at that spot. |
| Hold empty space, then drag | Draw a selection rectangle. |
| Tap an output pin, then an input pin | Connect them. |
| Drag from a pin | Draw a wire. Release over empty space to open Add Node and connect the new node. |
| Tap empty space | Clear the selection. |

Double-tapping does not zoom. Shaking a node back and forth while dragging breaks its links; turn this off with **Shake Nodes To Disconnect** in **Engine Settings > Graph**.

## Content Browser

| Gesture | Result |
| --- | --- |
| Tap a tile | Select it. |
| Drag across tiles | Select every tile you cross. |
| Double-tap an asset | Open it. |
| Double-tap a folder | Go into the folder. |
| Double-tap empty space | Open **New Asset**. |
| Hold a tile | Open its menu. |
| Hold empty space | **New Folder**, **New Asset** and **Import**. |
| Hold a row in the folder tree, then drag | Move it to another folder. |
| Swipe a tree row sideways | Add it to the selection. |
| Two-finger tap a tree row | Select the range up to that row. |

The **Outliner** uses the same tree gestures. Drag an actor onto another actor to parent it, or onto a folder to move it there.

## Sliders and curves

- Drag a slider's thumb to change the value. Swiping across the track scrolls the panel instead.
- Tap a collapsed curve or gradient to expand it, then drag keys or stops with one finger. **Add Key** and **Add Stop** add new ones.

## Tilesets and tilemaps

- **Move** is the default tool: one finger pans the view.
- In a Tileset, tap a cell to select that tile.
- In a Tilemap, pick a painting tool, then paint with one finger.
- Pinch zooms and two fingers pan with any tool. Adding a second finger stops a paint stroke.
