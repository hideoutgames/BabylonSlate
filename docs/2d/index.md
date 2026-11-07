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
- The orange outline shows what the scene's Layer Camera frames when Play starts: **Layer Camera Width** × **Layer Camera Height** (default 16 × 9) centred on **Layer Camera Location**, in **Scene Settings**. It is hidden while the scene starts on a Default Camera actor.

## 2D lighting

Sprites and Tilemaps draw unlit until a scene holds a [2D Light](../components/light-2d.md). Add one from **Place Actors > Lights** (**2D Point Light** or **2D Global Light**) and the scene's Sprites and Tilemaps are lit by its 2D lights, with a **Global** light setting how dark the rest is.

Each Sprite and Tilemap has a **Shading Mode**:

| Mode | Lit by |
| --- | --- |
| 2D | The scene's 2D Lights. Unlit while the scene has none. Default. |
| 3D | 3D lights and environment lighting, as a Material surface is. Use it for 2D elements in a 3D game. |
| Unlit | Nothing: always drawn as it is, for glowing items, backdrops or HUD-like figures. |

## Units and pixels

**Project Settings > Game > 2D** holds the project-wide 2D settings:

| Setting | Description |
| --- | --- |
| Pixels Per Unit | Texture pixels per world unit. Default 100, so a 100-pixel tile is one unit wide. Sizes tilemaps and 2D text; each Sprite has its own value. |
| Pixel-Perfect Mode | Frames the 2D editor view 1:1. Play and exported games snap the game camera to the pixel grid. |
| Nearest Texture Filtering | Samples every Material texture with nearest-neighbour filtering, in 3D too. Only available while **Pixel-Perfect Mode** is on. |
| Sorting Layers | Named draw layers, ordered back to front. Default **Background**, **Default**, **Foreground** and **UI**. |

Sprites, tiles and 2D images always sample their textures with nearest-neighbour filtering, so pixel art stays crisp. Materials blend neighbouring texels unless a [Texture Sample](../scripting/material/texture-sample.md)'s **Filter** is **Nearest**.

To give a whole project the pixel-art look, turn on **Pixel-Perfect Mode** and then **Nearest Texture Filtering**. Every Material texture then draws each texel as a hard-edged square, on 3D models as well, in the editor, Play and exported games. The change shows at once, so you can compare both looks and turn it off again.

## Draw order

- **Z-Order** sets depth. An actor with a higher Z-Order is nearer the camera and draws in front.
- At the same depth, **Sorting Layer** and **Order In Layer** decide. Layers later in the project list draw on top, and within a layer a higher order draws on top.

Sprite, Tilemap layers and Particle components each have a **Sorting Layer** and an **Order In Layer**.

## The game camera

A 2D game can look through the scene's **Layer Camera**: set **Default Camera** to **None** in **Scene Settings**, then set **Layer Camera Location**, **Layer Camera Width** and **Layer Camera Height**. Scripts move, turn and zoom it through [Get Scene Camera Manager](../scripting/class/get-scene-camera-manager.md) and **Get Layer Camera**.

A camera actor works too. The camera in a new 2D scene is the Default Camera and is already orthographic; **Orthographic Size** is half the view height in world units (default 5). See [Cameras](../graphics/cameras.md).

## 2D physics

A scene with **Physics World** set to **2D (Rapier)** simulates on the X/Y plane. Use a [Rigid Body](../components/rigid-body.md) and a [Collider](../components/collider.md) with a 2D shape (box2d, circle or capsule2d); a sprite's collision box can size a box2d Collider for you. Tilemap layers with **Collision** on become solid ground with no extra components. In 2D, physics nodes such as [Line Trace](../scripting/class/line-trace.md) use the X and Y of their vectors.

A scene uses one physics world. Streamed scenes must match it. See [Physics](../physics/index.md).

## HUDs and menus

Build on-screen interfaces in [Scene Layers](../scenes/scene-layers.md). They work the same over 2D and 3D scenes.

## In this section

- [Sprites](sprites.md)
- [Tilemaps](tilemaps.md)
