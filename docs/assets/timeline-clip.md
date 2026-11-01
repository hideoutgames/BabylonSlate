# Timeline Clip

A **2D Timeline Clip** or **3D Timeline Clip** asset holds one Timeline Clip in its own file. Instead of actors placed in a Scene, it animates **Proxies**: stand-ins for an actor or a component of a chosen Class. Each instance of the clip that a script creates binds its proxies to real objects, so one clip can drive any door, any HUD element, or the actor that plays it.

The two are separate asset types: a clip stays 2D or 3D for good.

## Create

In the **Content Browser**, choose **New Asset > Animation > 2D Timeline Clip** or **3D Timeline Clip**. A clip needs a [Timeline](timeline.md) asset, through which scripts reach it: pick one under **Timeline Asset**, or leave **New Timeline Asset** to create one beside the clip, named after it. The clip's name is the asset's name, and it must be unique within its Timeline Asset.

## Proxies

Double-tap the asset to open it. The **Proxies** window lists the clip's stand-ins.

- Tap **Proxy**, then **Actor Proxy…** or **Component Proxy…**, pick the Class the proxy stands in for and tap **Add Proxy**. A 3D clip offers world components; a 2D clip offers overlay components. The proxy takes the Class's name; rename it in the list or in the **Inspector**. Proxy names are unique within the clip.
- Each row shows what the proxy represents and its Class. The trash button removes the proxy and its tracks.

## Timeline

The **Timeline** window below the proxies is the [Timeline](../scenes/timeline.md) of a Scene's clips, with one row per proxy. It works the same way: set keys, drag them, change their interpolation and use the Curves view.

- Tap **+** on a proxy's row to add tracks. An Actor proxy offers **Location**, **Rotation**, **Scale** and **Visible**, its Class's variables and the properties of the components its Class defines. A Component proxy offers that component's properties.
- A proxy's row stays as long as the proxy: add and remove proxies in **Proxies**. **Track** in the toolbar adds Custom Event Tracks.
- Select a key or a track to edit it in the **Inspector**, above the proxy and clip settings.

## Inspector

- **Proxy**: the selected proxy's **Name**, what it represents and its Class.
- **Editor Preview**: how the editor draws the proxy. **Color**; **Representation**: an **Outline**, a **Model** (3D), a **Material** or **Texture** (2D), or its **Class**'s own look; **Size**; the preview **Location** and **Rotation**; and **Preview As**, which shows transform keys as offsets from the preview placement (**Relative**) or as exact values (**Absolute**). In Play, each binding chooses. The Editor Preview never leaves the editor: Play and exports leave it out, and the Models, Materials and Textures picked here never ship with the game.
- **2D Timeline Clip** or **3D Timeline Clip**: the **Timeline Asset** (required: you can change it, not clear it), **Length**, **Frame Rate**, **Play Rate**, **Loop Mode** and **When Finished**.

The Timeline asset lists the clip with its scene clips; **Open** there opens the clip asset.
