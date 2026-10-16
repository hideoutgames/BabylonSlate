# Actors

Actors are the objects in a scene. Each actor has a position, rotation and scale, and a list of components that give it its look and behaviour: a mesh, a light, a sprite, a collider.

## Place an actor

1. Tap **Add actor** (**+**) in the **Outliner** toolbar, or press <kbd>Alt</kbd>+<kbd>A</kbd>. **Place Actors** opens on **Featured**.
2. Pick an entry:
   - **Content > Models** lists your project's Model assets.
   - **Content > Project** lists Classes, Prefabs, sounds, particle systems, water, sprites and tilemaps from your project.
   - **Engine** holds the built-in categories: Shapes, Lights, Camera, Environment, Water, Rendering, Navigation, Physics, Audio, Particles and Empty.
3. The actor appears at the centre of the viewport.

Search matches names, categories, asset types and folders. To place a copy of an existing actor at a spot, drag its row from the **Outliner** onto the viewport.

## Select actors

- Tap an actor in the viewport or the **Outliner**. Hold <kbd>Mod</kbd> or <kbd>Shift</kbd> while tapping to add to the selection.
- Turn on **Drag Select** (<kbd>Q</kbd>) and drag a box. In 2D you can also hold, then drag.
- Locked actors cannot be picked in the viewport. Select them in the **Outliner**. Locking an actor removes it from the selection.

## Move, rotate and scale

Drag the gizmo handles, or type values in the **Inspector**. When several actors are selected, the gizmo moves them together and keeps their spacing. Each drag is one undo step. See [Scenes](index.md) for snapping, **Drop** and the gizmo tools.

## Organise the Outliner

| Action | How |
| --- | --- |
| Attach to a parent | Drag a row onto the middle of another row. The child then moves with its parent. |
| Reorder | Drag a row to the top or bottom edge of another row. |
| Detach | Drag the row onto empty space in the tree. |
| Group | Tap **New Folder** (<kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>N</kbd>), then drag rows into it. Folders only organise the list; the game ignores them. |
| Hide or lock | Use the eye and lock buttons on a row. |
| Rename | Double-tap the name, or press <kbd>F2</kbd>. |
| Copy and paste | <kbd>Mod</kbd>+<kbd>C</kbd> and <kbd>Mod</kbd>+<kbd>V</kbd>, also between scenes in the same project. **Paste Actors** in the toolbar does the same, even in an empty scene. |
| Duplicate | <kbd>Mod</kbd>+<kbd>D</kbd>, or **Duplicate** in the row menu. |
| Delete | <kbd>Delete</kbd> or <kbd>Backspace</kbd>. Attached children are deleted too. |

The row menu (**⋯**) also has **Select** / **Deselect**, **Frame Selection** and, for actors made from one of your Classes, **Open Actor**.

Deleting from the row menu with several actors selected offers **Delete This Object** or **Delete Selected**. Deleting a folder offers **Folder Only**, which moves its contents up a level, or **Folder And Contents**. All of these can be undone.

## Edit in the Inspector

Selecting an actor shows its **Name**, **Position**, **Rotation** (in degrees), **Scale**, **Visible** and **Locked**. In a 2D scene, Position and Scale show X and Y, Rotation shows Z, and **Z-Order** sets which actors draw in front: a higher Z-Order is nearer the camera.

With several actors selected, the heading reads **N Actors** and edits apply to all of them; values that differ show as mixed. The **Primary Actor** section holds the name and lock of the actor whose components are shown.

Use **Filter Properties** at the top to find a field by name.

## Add components

1. Select an actor and tap **Add Component**.
2. Search, or open a category. **Project** lists your Actor Component Classes and assets that bring their own component, such as Models and Sprites.
3. The component appears as a card. Tap its header to collapse it, double-tap its name to rename it, or use its remove button to delete it.

Some components work only in world scenes and others only in [Scene Layers](scene-layers.md); the menu shows only those that fit. See [Components](../components/index.md) for every component.

## Actors in scripts

- [Spawn Actor](../scripting/class/spawn-actor.md) and [Destroy Actor](../scripting/class/destroy-actor.md) create and remove actors during Play.
- [Get Actor Of Class](../scripting/class/get-actor-of-class.md) and [Get All Actors Of Class](../scripting/class/get-all-actors-of-class.md) find placed actors.
- [Set Actor Location](../scripting/class/set-actor-location.md) and [Attach Actor](../scripting/class/attach-actor.md) move and parent them.

To give an actor its own events and variables, make it from a Class. See [Classes](../scripting/classes.md) and [Prefabs](prefabs.md).
