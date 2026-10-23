---
node: input.waterFoam
---

# Water Foam

Returns the foam built-in water draws, as masks from 0 to 1: whitecaps, shorelines and foam around objects.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Foam | Float | All of the foam below together, as built-in water combines it. |
| Crest Foam | Float | Whitecaps on breaking crests, from the [**Water Waves**](water-waves.md) node. 0 without one. |
| Shore Foam | Float | Foam where the water over terrain is shallow, as wide as the asset's **Foam Width**. |
| Contact Foam | Float | A ring of foam around objects crossing the surface, as wide as the asset's **Contact Foam Width**. |

## Notes

- The asset's **Foam Amount** scales every mask. Shore Foam and Contact Foam are lacy: thick at the waterline, breaking into foam with holes that thin out with distance. They churn slowly in place and drift with the current, and on shores bands of foam wash in.
- Use Foam to blend toward the [**Water Colors**](water-colors.md) Foam Color with [**Mix**](mix.md).
- On meshes that are not water, every output is 0.
- Only in Surface and Landscape materials.
