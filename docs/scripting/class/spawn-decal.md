---
node: decals.spawn
---

# Spawn Decal

Projects a pooled runtime decal onto opaque world surfaces at a world location and orientation, without spawning an actor.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Texture | Texture | The RGBA Texture to project. |
| Location | Vector | World position of the decal box centre. |
| Rotation | Rotator | Orientation of the decal volume. Projection runs along local -Y. |
| Size | Vector | Local projection extents (X width, Y depth, Z height). Default (1, 1, 1). |
| Lifetime | Float | Seconds before the decal expires. 0 keeps it until recycled by the pool. Default 10. |
| Fade Out Duration | Float | Seconds at the end of **Lifetime** over which opacity fades linearly to 0. Default 1. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |

## Notes

- Dynamic decals use a fixed-size ring buffer (64 on Low and Medium Geometry quality, 128 on High and Ultra). Spawning past the cap recycles the oldest slot.
- If **Texture** is empty, nothing is spawned.
- For decals placed in the scene editor, use the [Decal](../../components/decal.md) component.
