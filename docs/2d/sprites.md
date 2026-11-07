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

1. Import each frame as its own Texture, or the whole sprite sheet as one Texture.
2. In the **Content Browser**, select the frames' Textures, right-click one and choose **Convert to 2D > Create Animation** (with Sprites among them, **Create Sprite Animation**). The animation opens with one frame per asset, in name order.
3. For a sprite sheet, select its Texture and choose **Convert to 2D > Create Sheet Animation**. It starts with square cells along a strip; adjust **Cell Width** and **Cell Height** for other grids, then choose **Use All Cells**, or pick each frame's **Cell**.

Under **Animation** in the **Inspector**, **Frame Duration** sets the length of every frame in milliseconds (default 100). **Add Frame** adds a frame and the remove button deletes the selected one. Each frame has its own **Pivot** and **Collision**, and **Frame Duration Override** gives that frame its own duration.

Use Sprites as frames when you have already set their pivot and collision box: the animation uses the Sprite's, and **Open Sprite** takes you to it. See [Sprite Animation](../assets/sprite-animation.md).

The **Preview** has **Play** / **Pause**, **Loop**, a scrubber with the current frame and time, and a strip of frames: tap a frame to select and edit it. In Sheet mode, **Sheet** shows the whole sheet; tap a cell to use it for the selected frame.

## Play it in the game

1. Create an [Animation Graph](../assets/animation-graph.md) (**New Asset > Animation > Animation Graph**).
2. Select a state, set **Clip Kind** to **Sprite**, and set **Clip Asset** to your Sprite Animation.
3. Add an **Animation Graph** component to the actor that has the Sprite component, and set its **Animation Graph**.

Switch states from scripts with [Jump To State](../scripting/class/jump-to-state.md) or by setting graph variables with [Set Anim Graph Variable](../scripting/class/set-anim-graph-variable.md).

## Collision

Give the actor a [Rigid Body](../components/rigid-body.md) and a [Collider](../components/collider.md) with the box2d shape. The box then takes its size and position from the sprite's collision box and the pivot. While a Sprite Animation plays, it follows each frame's collision box.

## Things to know

- Sprites sample their textures with nearest-neighbour filtering, so pixel art stays sharp.
- Transparent parts of the image are cut out.
- Circle and capsule colliders keep the size you set; only box2d follows the sprite.

## Related

- [Sprite](../assets/sprite.md)
- [Sprite Animation](../assets/sprite-animation.md)
- [Tilemaps](tilemaps.md)
