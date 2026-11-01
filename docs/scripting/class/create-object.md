---
node: object.create
---

# Create Object

Creates an object of a Class whose parent is Object, runs its **Event On Init**, and returns it.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Class | Object Class | The Class to create. The list shows only Classes whose parent is Object. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Object | Object Reference | The new object, typed as the picked Class. |

## Notes

- The object lives while a variable, array, map or structure holds it, or while the event that created it is still waiting on a node such as a Delay. It is collected once nothing does. See [Objects and lifetime](../object-lifetime.md).
- It ticks only when its Class implements the **Tickable Object** interface.
- Picking an Actor, component, Game Instance, subsystem or other engine Class is an error in **Compiler Results**. A Class of the wrong kind connected to **Class** returns an empty reference and logs an error. Use [Spawn Actor](spawn-actor.md) for actors.
