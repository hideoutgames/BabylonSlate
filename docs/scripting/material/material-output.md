# Material Output

Receives the final surface settings of a material, such as colour, roughness and opacity.

## Inputs

| Pin | Type | Default | Description |
| --- | --- | --- | --- |
| Base Color | Vector 3 | (0.8, 0.8, 0.8) | Surface colour before lighting. With the Unlit shading model it is the final colour. |
| Metallic | Float | 0 | 0 is a non-metal and 1 is a metal. PBR shading model only. |
| Roughness | Float | 0.5 | 0 is a mirror-smooth surface and 1 is fully rough. PBR shading model only. |
| Environment Influence | Float | 1 | Scales lighting from the environment, from 0 to 1; direct lights and Emissive are unaffected. |
| Normal | Vector 3 |  | World-space normal used for lighting, such as the output of [**Normal Map**](normal-map.md). When unconnected, the material's Default Normals setting applies. |
| Emissive | Vector 3 | (0, 0, 0) | Colour the surface gives out, added on top of lighting; it does not light other objects. |
| Opacity | Float | 1 | From 0 (invisible) to 1 (solid). Used by the Translucent and Additive blend modes, and by Masked when **Alpha Clip** is unconnected. |
| Alpha Clip | Float |  | Used by the Masked blend mode: pixels where this value is below Alpha Cutoff are discarded. When unconnected, **Opacity** is used. |
| World Position Offset | Vector 3 | (0, 0, 0) | Offset in metres added to each vertex position in world space. Only vertex-stage nodes can feed it. |

## Notes

- Every Surface and Landscape material needs exactly one.
- Shading Model, Blend Mode, Two Sided and Alpha Cutoff are set in the **Inspector** when no node is selected.
- Displacement from World Position Offset does not enlarge the mesh bounds. Raise Bounds Padding (Local) if the mesh disappears near the screen edge.
