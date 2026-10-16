# Scene

A 3D or 2D world: the actors you place, plus settings for the environment, physics and the editing grid.

## Create

In the **Content Browser**, choose **New Asset > World > Scene**. A new Scene is 3D. It starts with an empty Actor, a skybox, a directional light and a camera that is set as the Default Camera.

The **Basic 2D** starter on the Homepage begins with a 2D Scene that holds only a camera.

## Editor

Double-tap a Scene to open it.

- **Viewport**: place, select and move actors. The toolbar switches between 3D and 2D and holds gizmos, snapping and viewport options.
- **Outliner**: the actor hierarchy. Tap **+** to place actors.
- **Inspector**: the selected actor's components, or **Scene Settings** when nothing is selected.
- **Output Log** and **Compiler Results**: messages and script errors, docked below the viewport.
- **Scene Mode** picker: **Design**, **Landscape** or **Foliage**.

## Settings

Clear the selection to show **Scene Settings** in the **Inspector**.

| Setting | Description |
| --- | --- |
| Name | The Scene's display name. |
| Game Instance | Read-only. Set it in **Project Settings > Game**. |
| Viewport | **3D** or **2D**. The same as the toolbar button. |
| Physics World | **3D (Havok)** or **2D (Rapier)**. A Scene uses one or the other. Changing Viewport does not change it. |
| Environment | Background colour. |
| Fog | Turns on distance fog. Shows **Fog Mode** (**Linear**, **Exponential** or **Exponential Squared**) and **Fog Color**, then **Fog Start** and **Fog End** for Linear, or **Fog Density** for the others. |
| Default Camera | The camera Play looks through. |
| Joystick | Shows the on-screen joystick for the editor camera. |
| Gravity | Default 0, −9.81, 0. |
| Snap Step | Movement increment for the snap grid. Default 1. |
| Tile Size | Spacing of the visible grid cells. Default 1. |
| Tile Subdivisions | Minor lines per grid cell. Default 4. |
| 2D Camera Width, 2D Camera Height | Size of the orange guide frame drawn in 2D. Default 16 × 9. |

Below the settings are collapsible sections:

| Section | Description |
| --- | --- |
| Post Processing | Ordered full-screen passes. **Add Pass** picks a post-process Material; each pass has **Enabled** and **Scalable** switches. |
| Environment Lighting | Image-based lighting for this Scene, including **Environment Texture**. |
| Shadows | Shadow overrides for this Scene. |
| CEL Shading | Overrides for this Scene. Shown only when the project uses the CEL render mode. |
| Scene Layers | **Add Layer** picks a [Scene Layer](scene-layer.md) to show with this Scene. Each entry has an enable switch and a **Z-Order**; higher values draw on top. |

## Related

- [Scenes](../scenes/index.md)
- [Actors](../scenes/actors.md)
- [Scene Layers](../scenes/scene-layers.md)
- [Post-Processing](../graphics/post-processing.md)
- [Lighting](../graphics/lighting.md)
- [Shadows](../graphics/shadows.md)
- [Sky and Fog](../graphics/sky-and-fog.md)
