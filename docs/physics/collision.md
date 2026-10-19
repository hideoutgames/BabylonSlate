# Collision

Control which colliders touch, react to hits and overlaps in scripts, and query the world with traces.

## Collision layers

Layers decide which colliders interact. Set them up in **Project Settings > Physics > Collision Layers**: **Add Layer** creates a named layer, up to 32. Every project starts with **Default**.

Each Collider, collidable Mesh, Dynamic Runtime Mesh and Ragdoll has these settings:

| Setting | Description |
| --- | --- |
| Layer | The one layer this collider belongs to. |
| Collides With | **Project Matrix** follows the project Collision Matrix for this collider's Layer. **Custom** uses the collider's own Layers. New components use Project Matrix; components saved before the matrix existed stay Custom. |
| Layers | The layers it reacts to. With Project Matrix it shows the matrix row and is read only; switching to Custom starts from that row. |

Two colliders interact only when each one's **Layers** includes the other's **Layer**. If either side leaves the other out, they pass through each other and raise no events.

### Collision Matrix

**Project Settings > Physics > Collision Matrix** is a grid of every pair of layers. Clear a box and the two layers stop colliding for every Project Matrix collider on them. All pairs collide by default.

Engine-made colliders (the Movement capsule, Blocking Volumes and tilemap collision) sit on **Default** and follow its matrix row. Landscape collision also follows the matrix.

Layers are stored by position: removing or reordering a layer in the list moves the matrix rows with it, as it does for every collider's Layer.

A script that sets a component's **Mask** switches it to Custom.

## Hits and overlaps

| Pair | Result |
| --- | --- |
| Two solid colliders | They block each other. [Event On Hit](../scripting/class/event-on-hit.md) runs on both actors for every physics step they touch. |
| At least one collider with **Is Trigger** on | They pass through. [Event On Begin Overlap](../scripting/class/event-on-begin-overlap.md) runs when they start overlapping and [Event On End Overlap](../scripting/class/event-on-end-overlap.md) when they separate. No hit is reported. |

To handle these events, add **Event On Hit**, **Event On Begin Overlap** or **Event On End Overlap** to the actor's Class graph. On Hit gives you the other actor, the contact location and the normal.

Each Actor class has **Generate Hit Events** and **Generate Overlap Events** under **Actor Defaults**, shown when you select the Prefab Root in the Class editor. Both are on by default. Turn one off when the actor never needs that event.

::: tip
Use a trigger for pickups, checkpoints and damage zones. Pair the trigger Collider with a Rigid Body set to Static so it stays in place. A Collider with no Rigid Body is not simulated, so it never raises an overlap. A Collider beside a collidable Mesh or a Blocking Volume does not need one.
:::

An overlap that already exists when Play starts also runs **Event On Begin Overlap**.

## Traces and queries

Query nodes look into the physics world and return a result straight away, on the same execution pin.

| Node | What it does |
| --- | --- |
| [Line Trace](../scripting/class/line-trace.md) | Casts a ray between two points and reports the first hit. |
| [Sphere Shape Sweep](../scripting/class/sphere-shape-sweep.md) | Moves a sphere between two points and reports the first hit. |
| [Sphere Overlap Actors](../scripting/class/sphere-overlap-actors.md) | Lists the actors whose colliders overlap a sphere. |
| [Project Cursor To Scene](../scripting/class/project-cursor-to-scene.md) | Casts a ray from the camera through the cursor or touch point. |

A hit returns **Hit**, **Location**, **Normal**, **Distance** and the **Actor**. A miss returns false, zeros and an empty Actor. **Line Trace** also takes **Actors To Ignore**, so the actor doing the trace cannot block itself.

## Collision channels

Every query has a **Channel** that limits what it can find. Channels are fixed categories, not project settings.

| Channel | Finds |
| --- | --- |
| All | Everything, including triggers. The default. |
| Static | Static bodies, including Mesh collision and Blocking Volumes. |
| Dynamic | Dynamic and kinematic bodies, including active ragdolls. |
| Character | Actors with a Movement component. |
| Solid | Everything except triggers. |
| Triggers | Only triggers. |

## Notes

- **Line Trace** draws its ray for one frame while **Draw Debug** is on (the default). Release exports never draw it.
- A query sees bodies as they were after the last physics step, plus any moves your scripts made since.
- Scripts in a Scene Layer query that layer's own physics world. In a layer without **Enable Physics**, every query misses.

## Related

- [Physics](index.md)
- [Collider](../components/collider.md)
- [Rigid Body](../components/rigid-body.md)
- [Blocking Volume](../components/blocking-volume.md)
