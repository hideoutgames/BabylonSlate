# Material Instance

Parameter values for a parent Material. It shares the parent's compiled shader, so edits and variants cost no recompile.

## Create

In the **Content Browser**, choose **New Asset > Rendering > Material Instance**, then set its **Parent**.

## Editor

Double-tap a Material Instance to open it.

- **Preview**: the instance on a shape, with the same shape choices as a Material.
- **Inspector**: the **Parent** and one row for each parameter the parent exposes.

## Settings

| Setting | Description |
| --- | --- |
| Parent | A Material or another Material Instance. |
| Parameters | One row per parameter, showing the inherited value. Edit a row to override it; the row is marked **Overridden**. Reset it, or set it back to the parent's value, to inherit again. |
| Remove Unused | Appears when the instance overrides parameters the parent no longer has. It clears those overrides. |

## Notes

- Parameter types are float, colour and texture. They come from [Float Parameter](../scripting/material/float-parameter.md), [Color Parameter](../scripting/material/color-parameter.md) and [Texture Parameter](../scripting/material/texture-parameter.md) nodes in the parent Material.
- Every Material picker also lists Material Instances of the matching domain.
- Change a parameter on one mesh from a script with [Set Material Float Parameter](../scripting/class/set-material-float-parameter.md), or swap a mesh to another instance with [Set Material Instance](../scripting/class/set-material-instance.md).

## Related

- [Materials](../graphics/materials.md)
- [Material](material.md)
