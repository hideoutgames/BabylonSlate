# Timeline Clip

A **2D Timeline Clip** or **3D Timeline Clip** asset holds one Timeline Clip in its own file. Instead of actors placed in a Scene, it animates **Proxies**: stand-ins for an actor or a component of a chosen Class. Each instance of the clip that a script creates binds its proxies to real objects, so one clip can drive any door, any HUD element, or the actor that plays it.

The two are separate asset types: a clip stays 2D or 3D for good.

## Create

In the **Content Browser**, choose **New Asset > Animation > 2D Timeline Clip** or **3D Timeline Clip**. A clip needs a [Timeline](timeline.md) asset, through which scripts reach it: pick one under **Timeline Asset**, or leave **New Timeline Asset** to create one beside the clip, named after it. The clip's name is the asset's name, and it must be unique within its Timeline Asset.

## Proxies

Double-tap the asset to open it. The **Proxies** window, beside the **Viewport**, lists the clip's stand-ins.

- Tap **Proxy**, then **Actor Proxy…** or **Component Proxy…**, give it a **Name**, pick the Class the proxy stands in for and tap **Add Proxy**. A 3D clip offers world components; a 2D clip offers overlay components. Without a name, the proxy takes the Class's name; rename it later in the list or in the **Inspector**. Proxy names are unique within the clip, so a name that is taken gets a number.
- Each row shows what the proxy represents and its Class. The trash button removes the proxy and its tracks.

## Viewport

The **Viewport** window previews the clip: each proxy is drawn the way its **Editor Preview** says and moves with the clip as you scrub or play the Timeline. A 3D clip previews in 3D, and a 2D clip in a 2D overlay frame.

- An **Outline** is a box in a 3D clip and a square in a 2D clip, in the proxy's **Color**, **Size** wide. A **Model**, **Material** or **Texture** draws that asset at **Size**; with none picked, the proxy is an Outline. **Class** draws the Class's own components, and a Component proxy also draws its component.
- A **Relative** proxy stands at its preview **Location**, **Rotation** and **Scale**, and its transform keys move it from there: **Scale** keys multiply its preview **Scale**. An **Absolute** proxy stands exactly where its keys put it.
- Tap a proxy to select it in **Proxies** and the **Inspector**, and drag its gizmo to move, turn or scale it, as in a Scene's Timeline mode:
  - A channel whose track has keys (**Location**, **Rotation** or **Scale**) takes a key at the playhead with **Auto Key** on. With it off, the change waits as an unkeyed value, shown amber on the track, until you key it.
  - **Location**, **Rotation** or **Scale** without a track, or whose track has no keys yet, overwrites the proxy's preview placement, with **Auto Key** on or off, the same as editing them in the **Inspector**. The placement stays when you change the **Representation**.
- The camera, shading, grid and gizmo controls work as in a Scene.

## Timeline

The **Timeline** window below the Viewport is the [Timeline](../scenes/timeline.md) of a Scene's clips, with one row per proxy. It works the same way: set keys, drag them, change their interpolation and use the Curves view.

- Tap **+** on a proxy's row to add tracks. An Actor proxy offers **Location**, **Rotation**, **Scale** and **Visible**, its Class's variables and the properties of the components its Class defines. A Component proxy offers that component's properties.
- A proxy's row stays as long as the proxy: add and remove proxies in **Proxies**. **Track** in the toolbar adds Custom Event Tracks.
- Select a key or a track to edit it in the **Inspector**, above the proxy and clip settings.

## Inspector

- **Proxy**: the selected proxy's **Name**, what it represents and its Class.
- **Editor Preview**: how the editor draws the proxy. **Color**; **Representation**: an **Outline**, a **Model** (3D), a **Material** or **Texture** (2D), or its **Class**'s own look; **Size**; the preview **Location**, **Rotation** and **Scale**; and **Preview As**, which records and shows transform keys as offsets from the preview placement (**Relative**) or as exact values (**Absolute**). In Play, each binding chooses ([Play a clip asset](#play-a-clip-asset)). The Editor Preview never leaves the editor: Play and exports leave it out, and the Models, Materials and Textures picked here never ship with the game.
- **2D Timeline Clip** or **3D Timeline Clip**: the **Timeline Asset** (required: you can change it, not clear it), **Length**, **Frame Rate**, **Play Rate**, **Loop Mode** and **When Finished**.

The Timeline asset lists the clip with its scene clips; **Open** there opens the clip asset.

## Play a clip asset

A clip asset never plays by itself: a script creates an instance of it, and each instance has its own playhead, Play Rate and proxy bindings.

1. Get the Timeline of the clip's Timeline asset with [Get Timeline Object Reference From Timeline Asset](../scripting/class/get-timeline-object-reference-from-timeline-asset.md).
2. Drag from its **Timeline** pin and add the clip's [Create Timeline Clip](../scripting/class/create-timeline-clip.md) node, titled with its name, such as **Create Door Swing Timeline Clip**. It has one input per proxy, typed to the proxy's Class.
3. Connect the objects to animate, for example **Get Self** to the Door proxy and the door's light to Handle Glow, and store the **Timeline Clip** in a variable.
4. Play it with the [Timeline Clip nodes](../scenes/timeline.md#control-a-clip-from-a-script), and Bind to its events, such as **On Swing Open**, or to the Timeline's **On Swing Open (Door Swing)**.

- Create binds each connected proxy **Relative**: transform keys offset the object from where it stood when it was bound, turned with it, so one swing works on every door whatever its position and facing. Scale keys multiply its scale.
- A proxy with nothing connected is unbound: its tracks are skipped, and the **Output Log** warns once, such as **Door Swing: the Handle Glow proxy is not bound.** A bound object that is destroyed unbinds itself.
- An instance lives while a variable, array, map or structure holds it, or while it plays, and is then collected. Every placed actor that creates one gets its own; there is no limit.
- The clip asset ships with the game when a script creates it. Play and exports carry its keys, events and proxies, never its Editor Preview.

### Rebind proxies

Drag from an instance's **Timeline Clip** pin for each proxy's nodes, titled with its name:

| Node | Does |
| --- | --- |
| [Bind Actor to Timeline Proxy](../scripting/class/bind-actor-to-timeline-proxy.md), such as **Bind Door Proxy** | Binds an Actor proxy to an actor. |
| [Bind Component to Timeline Proxy](../scripting/class/bind-component-to-timeline-proxy.md), such as **Bind Handle Glow Proxy** | Binds a Component proxy to a component. |
| [Unbind Timeline Proxy](../scripting/class/unbind-timeline-proxy.md) | Clears the proxy: its tracks stop applying. |
| [Get Timeline Proxy](../scripting/class/get-timeline-proxy.md) | Returns the object bound to the proxy, or None. |
| [Unbind All Timeline Proxies](../scripting/class/unbind-all-timeline-proxies.md) | Clears every proxy of the instance. |

- **Proxy** in the **Inspector** picks which proxy a node acts on.
- A Bind node's **Absolute Transform** decides how transform keys apply. Off (Relative): they offset the object from where it stands when it is bound. On: they set an actor's world transform, or a component's transform relative to its parent.
- A new binding applies from the next frame, while the instance plays.
- When Finished: Restore State puts back the values of the objects bound when the instance started playing.

## Checks

**Compiler Results**, from the **Windows** menu, lists what stops the clip from working:

- **Error**: the clip has no Timeline Asset, or it was deleted.
- **Error**: two proxies share a name, or a proxy's Class was deleted.
- **Warning**: a Component proxy's Class does not suit the clip, such as a 2D component in a 3D clip.
- **Warning**: a track's property can no longer be animated or changed type, or a component an Actor proxy's Class defined is gone. The Timeline draws such tracks in red.

In scripts, a Bind, Unbind or Get node whose proxy was removed, or that picks none, shows an error, as does a Bind Actor node on a Component proxy or the other way round.
