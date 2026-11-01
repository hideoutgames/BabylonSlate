---
node: timeline.createClip
---

# Create Timeline Clip

Creates an instance of a 2D or 3D Timeline Clip asset, with its own playhead and proxy bindings, and binds the objects connected to its proxy inputs.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Target | Timeline Reference | The Timeline of the clip's Timeline asset, from [Get Timeline Object Reference From Timeline Asset](get-timeline-object-reference-from-timeline-asset.md). |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Timeline Clip | Timeline Clip Reference | The new instance, typed to the clip asset. None when the game does not hold the clip asset. |

## Notes

- Add Node lists one for each clip asset the Timeline asset holds, titled with its name, such as **Create Door Swing Timeline Clip**, when you drag from a Timeline typed to that asset.
- The node has one input per proxy, named after it and typed to its Class: an actor for an Actor proxy, a component for a Component proxy. Connect the objects the clip should animate, such as **Get Self** for the actor that plays it.
- Each connected proxy is bound **Relative**: its transform keys offset the object from where it stands when the instance is created, so one clip works on every door wherever it stands. An unconnected proxy stays unbound: its tracks are skipped, and the **Output Log** warns once.
- The instance lives while a variable, array, map or structure holds it, or while it plays. Store it in a variable to play it again later.
- Every instance has its own playhead and Play Rate. Play it with the [Timeline Clip nodes](../../scenes/timeline.md#control-a-clip-from-a-script), and Bind to its own events or to the Timeline's, such as **On Swing Open (Door Swing)**.
- Renaming the clip asset renames the node, and adding or removing a proxy updates its inputs. If the clip asset is deleted or moved to another Timeline asset, the node shows an error until you remove it.
