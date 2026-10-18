# Scenes

A scene is a world: the actors you place in 3D or 2D space, plus settings for the environment, physics and the editing grid. Your game plays one world scene at a time. [Scene Layers](scene-layers.md) draw HUDs and menus on top of it, and [Scene Streaming](streaming.md) adds other scenes into it while the game runs.

## Open a scene

1. In the **Content Browser**, choose **New Asset > World > Scene**, or use an existing Scene.
2. Double-tap the Scene to open it. The **Viewport**, **Outliner** and **Inspector** open with it.

Only one scene is open at a time. Opening another scene closes the current one; if it has unsaved changes, the editor asks you to save or discard them first.

A new Scene starts in 3D with an empty actor, a skybox, a directional light and a camera. The **Basic 2D** starter on the Homepage creates a 2D scene with only a camera. See [2D](../2d/index.md).

## Move around the viewport

- **3D**: drag with one finger or the mouse to look around, pinch or scroll to zoom, and use three fingers or <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> to fly. Turn on **Pivot Around Center** to orbit instead of looking.
- **2D**: drag to pan, pinch or scroll to zoom. Hold, then drag, to box-select actors.
- The on-screen **Joystick** moves the editor camera too.
- Press <kbd>F</kbd> to frame the selection, or double-tap an actor's icon or the blank space beside its name in the **Outliner**. Double-tapping the name renames it.

See [Touch Gestures](../start/gestures.md) for the full list.

## The viewport toolbar

| Control | What it does |
| --- | --- |
| **Move**, **Rotate**, **Scale** | Gizmo for the selection. Keys <kbd>1</kbd>, <kbd>2</kbd>, <kbd>3</kbd>. In 2D the gizmo moves on X and Y, rotates around Z and scales X and Y. |
| **World Space** / **Local Space** | Aligns the gizmo with the world axes or the actor's own axes. |
| **Snap Grid** | Snaps gizmo moves to the increment shown on the button (<kbd>G</kbd>). Hold or right-click it for **Grid Settings**. |
| **Drag Select** | The next drag draws a selection box (<kbd>Q</kbd>). |
| **Drop** | Drops the selected actors straight down onto the nearest collision surface (<kbd>End</kbd>). |
| **Viewport Settings** | **Viewport Mode** (PBR or CEL, Unlit, Wireframe), **Show Grid**, **Show Navmesh**, **Show Collisions**, **Joystick**, **Pivot Around Center**, **Game Camera** (look through the scene's Default Camera), and **Settings > Grid Settings** or **Camera Speed**. |
| **3D** / **2D** | Switches the scene between 3D and 2D (<kbd>Alt</kbd>+<kbd>V</kbd>). |

**Grid Settings** holds **Grid Size** (visible cell spacing), **Grid Snap** (move increment), **Rotation Snap (Degrees)** and **Scale Snap**. New scenes use 1, 1, 15 and 0.25. **Camera Speed** (default 8 units per second) and **Drop Distance** (default 10,000 units) are in **Engine Settings > Viewport**.

## Scene Settings

Tap empty space in the viewport, or clear the selection, to show **Scene Settings** in the **Inspector**.

| Setting | Description |
| --- | --- |
| Name | The scene's display name. |
| Game Instance | Read-only. Set it in **Project Settings > Game**. |
| Viewport | 3D or 2D. The same as the 3D / 2D toolbar button. |
| Physics World | **3D (Havok)** or **2D (Rapier)**. A scene uses one or the other. |
| Environment | Background colour. |
| Fog | Distance fog, with **Fog Mode**, **Fog Color** and its distance or density settings. See [Sky and Fog](../graphics/sky-and-fog.md). |
| Default Camera | The camera Play looks through. See [Cameras](../graphics/cameras.md). |
| Joystick | Shows the on-screen joystick for the editor camera. |
| Gravity | Default 0, −9.81, 0. |
| Snap Step, Tile Size, Tile Subdivisions | Grid Snap, Grid Size, and how many subdivisions each grid cell has. |
| 2D Camera Width, 2D Camera Height | Size of the orange guide frame drawn in 2D. Default 16 × 9. |

Below the settings are **Post Processing** passes, **Environment Lighting**, **Shadows** and, in the CEL render mode, **CEL Shading** overrides for this scene, and the **Scene Layers** that appear with it. See [Post-Processing](../graphics/post-processing.md), [Shadows](../graphics/shadows.md) and [Scene Layers](scene-layers.md).

::: tip
Changing **Viewport** to 2D does not change **Physics World**. Set both for a 2D game.
:::

## Scene modes

The **Scene Mode** picker in the toolbar switches the open scene between **Design** (placing and editing actors), **Landscape** (sculpting terrain) and **Foliage** (painting instanced models). See [Landscape and Foliage](landscape.md).

## Play a scene

When **Debug > Play from Scene** is on (the default), Play and Preview Build start from the open scene. Otherwise they start from the **Startup Scene** in **Project Settings > Game**, which is also where exported games start. To move to another scene during the game, use [Change Scene](../scripting/class/change-scene.md).

## In this section

- [Actors](actors.md)
- [Prefabs](prefabs.md)
- [Scene Streaming](streaming.md)
- [Scene Layers](scene-layers.md)
- [Landscape and Foliage](landscape.md)
