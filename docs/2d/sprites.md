# Sprites

A Sprite shows a 2D image in your scene. A Sprite Animation plays a series of images frame by frame, driven by an Animation Graph.

## Make a Sprite

1. Import your image as a Texture. See [Importing](../editor/importing.md).
2. In the **Content Browser**, choose **New Asset > 2D > Sprite**, then double-tap it.
3. In the **Inspector**, set **Texture**.

The **Preview** shows the image with a crosshair at the pivot and a dashed collision box. Drag the box or its handles to change the collision.

| Setting | Description |
| --- | --- |
| Texture | The image to show. |
| Pixels Per Unit | Scales the sprite in the world: a higher value makes it smaller. Default 100. |
| Pivot | The point of the image that sits at the actor's position, as fractions of the image: 0.5, 0.5 is the centre and 0, 0 the top-left corner. |
| Collision | The collision box as fractions of the image (X, Y, width, height). The default covers the whole image. |

## Place a sprite

- In **Place Actors**, choose **Rendering > Sprite**, then set **Asset** on its Sprite component.
- Or pick your Sprite under **Content > Project**; it is placed with the asset already set.
- Or select any actor and choose **Add Component > Rendering > Sprite**.

The [Sprite](../components/sprite.md) component has **Asset**, **Sorting Layer** and **Order In Layer**. It works in scenes and in Scene Layers. See [2D](index.md) for draw order.

## Make a Sprite Animation

1. Import each frame as its own Texture.
2. Choose **New Asset > Animation > Sprite Animation**, then double-tap it.
3. Under **Animation** in the **Inspector**, set **Frame Duration MS**, the length of every frame in milliseconds (default 100).
4. Under **Frame 1**, set **Texture**. Tap **Add Frame** for each further frame, and **Remove Frame** to delete the selected one.

Each frame also has its own **Pivot** and **Collision**, and **Frame Duration MS Override** gives that frame its own duration.

The **Preview** has **Play** / **Pause**, **Loop**, a scrubber, and a strip of frames: tap a frame to select and edit it. The header shows the frame count and total length.

## Play it in the game

1. Create an [Animation Graph](../assets/animation-graph.md) (**New Asset > Animation > Animation Graph**).
2. Select a state, set **Clip Kind** to **Sprite**, and set **Clip Asset** to your Sprite Animation.
3. Add an **Animation Graph** component to the actor that has the Sprite component, and set its **Animation Graph**.

Switch states from scripts with [Jump To State](../scripting/class/jump-to-state.md) or by setting graph variables with [Set Anim Graph Variable](../scripting/class/set-anim-graph-variable.md).

## Collision

Give the actor a [Rigid Body](../components/rigid-body.md) and a [Collider](../components/collider.md) with the box2d shape. The box then takes its size and position from the sprite's collision box and the pivot. While a Sprite Animation plays, it follows each frame's collision box.

## Things to know

- With **Pixel-Perfect Mode** on, sprites sample their textures with nearest-neighbour filtering, so pixel art stays sharp.
- Transparent parts of the image are cut out.
- Circle and capsule colliders keep the size you set; only box2d follows the sprite.

## Related

- [Sprite](../assets/sprite.md)
- [Sprite Animation](../assets/sprite-animation.md)
- [Tilemaps](tilemaps.md)
