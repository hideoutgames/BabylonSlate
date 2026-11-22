---
node: output.decal
---

# Decal Output

Receives what a Decal Material draws on the surfaces inside a decal's box.

## Inputs

| Pin | Type | Default | Description |
| --- | --- | --- | --- |
| Base Color | Vector3 | (0.8, 0.8, 0.8) | Colour before lighting. With the Unlit shading model it is the final colour. The decal's **Tint** multiplies it. |
| Opacity | Float | 1 | From 0 (no decal) to 1. The decal's **Opacity** and its edge and angle fade multiply it. Used by the Translucent, Additive and Multiply blend modes, and by Masked against Alpha Cutoff. |
| Normal | Vector3 |  | World-space normal used for lighting, such as the output of [**Normal Map**](normal-map.md). When unconnected, the surface's own normal applies. PBR shading model only. |
| Roughness | Float | 0.5 | 0 is mirror-smooth and 1 is fully rough. PBR shading model only. |
| Metallic | Float | 0 | 0 is a non-metal and 1 is a metal. PBR shading model only. |
| Emissive | Vector3 | (0, 0, 0) | Colour the decal gives out, added on top of lighting. The decal's **Tint** multiplies it. |

## Notes

- Every Decal material needs exactly one.
- [**UV**](uv.md) gives the decal's projected coordinates: 0 to 1 across the box's local X and Z. Texture Sample uses them when its UV is unconnected.
- Blend Mode decides how the decal meets the surface: **Opaque** and **Masked** replace it (Masked where Opacity is above Alpha Cutoff), **Translucent** blends over it, **Additive** adds light to it, and **Multiply** darkens it by the colour.
- Only in Decal materials. Assign the material to a [Decal](../../components/decal.md) component or to [Spawn Decal](../class/spawn-decal.md).
