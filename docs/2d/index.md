# 2D

Haptic builds 2D games with the same scenes, actors, scripts and physics as 3D games, seen through an orthographic camera, with sprites and tilemaps on top. You can switch a scene between 2D and 3D at any time, which also makes 2.5D games possible.

## Start a 2D game

- On the Homepage, create a project from the **Basic 2D** starter. Its scene is 2D, uses 2D physics and has an orthographic camera, and **Pixel-Perfect Mode** is on.
- Or open any scene and press the **3D** / **2D** button in the viewport toolbar (<kbd>Alt</kbd>+<kbd>V</kbd>). The scene remembers the mode and opens in it next time. For 2D physics, also set **Physics World** to **2D (Rapier)** in **Scene Settings**.

See [Your First Project](../start/first-project.md) and [Scenes](../scenes/index.md).

## The 2D viewport

- Content lies on the X/Y plane: +X is right and +Y is up.
- Drag to pan and pinch or scroll to zoom. Hold, then drag, to box-select.
- The gizmo moves on X and Y, rotates around Z and scales X and Y.
- The **Inspector** shows Position X and Y, **Z-Order**, Rotation Z and Scale X and Y.
- The orange frame is a guide sized by **2D Camera Width** and **2D Camera Height** in **Scene Settings** (default 16 × 9). It does not change what the game camera shows.

## Units and pixels

**Project Settings > Game > 2D** holds the project-wide 2D settings:

| Setting | Description |
| --- | --- |
| Pixels Per Unit | Texture pixels per world unit. Default 100, so a 100-pixel tile is one unit wide. Sizes tilemaps and 2D text; each Sprite has its own value. |
| Pixel-Perfect Mode | Frames the 2D editor view 1:1 with nearest sampling. Play and exported games snap the game camera to the pixel grid. |
| Sorting Layers | Named draw layers, ordered back to front. Default **Background**, **Default**, **Foreground** and **UI**. |

With **Pixel-Perfect Mode** on, sprites and tiles sample their textures with nearest-neighbour filtering, so pixel art stays crisp.

## Draw order

- **Z-Order** sets depth. An actor with a higher Z-Order is nearer the camera and draws in front.
- At the same depth, **Sorting Layer** and **Order In Layer** decide. Layers later in the project list draw on top, and within a layer a higher order draws on top.

Sprite, Tilemap layers and Particle components each have a **Sorting Layer** and an **Order In Layer**.

## The game camera

The game looks through the scene's **Default Camera**. For 2D, set its **Projection Mode** to **Orthographic**; **Orthographic Size** is half the view height in world units (default 5). The camera in a new 2D scene is already set up this way. See [Cameras](../graphics/cameras.md).

## 2D physics

A scene with **Physics World** set to **2D (Rapier)** simulates on the X/Y plane. Use a [Rigid Body](../components/rigid-body.md) and a [Collider](../components/collider.md) with a 2D shape (box2d, circle or capsule2d); a sprite's collision box can size a box2d Collider for you. Tilemap layers with **Collision** on become solid ground with no extra components. In 2D, physics nodes such as [Line Trace](../scripting/class/line-trace.md) use the X and Y of their vectors.

A scene uses one physics world. Streamed scenes must match it. See [Physics](../physics/index.md).

## HUDs and menus

Build on-screen interfaces in [Scene Layers](../scenes/scene-layers.md). They work the same over 2D and 3D scenes.

## In this section

- [Sprites](sprites.md)
- [Tilemaps](tilemaps.md)
