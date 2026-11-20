---
node: output.text
---

# Text Output

Sets the colour of text drawn with a Text material.

## Inputs

| Pin | Type | Default |
| --- | --- | --- |
| Color | Vector4 | (1, 1, 1, 1) |

## Notes

- The colour is multiplied by the glyph shape and any span colour, so letter edges are kept.
- The Material's **Blend Mode** decides how the letters meet what is behind them: **Translucent** (default), **Additive**, or **Multiply**, which darkens what is behind by the colour where the glyphs are ([Multiply on Scene Layers](../../assets/material.md#multiply-on-scene-layers)).
- Assign the material through **Text Material** on a 2D Text or 2D Rich Text component.
- Only in Text materials.
