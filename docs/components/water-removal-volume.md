# Water Removal Volume

Removes water inside a box, sphere, cylinder or capsule, such as the inside of a boat hull.

## Add it

Select an actor, then choose **Add Component > Water > Water Removal Volume**. You can also place a ready-made actor from **Place Actors > Water > Water Removal Volume**.

## Settings

| Setting | Description |
| --- | --- |
| Enabled | Removes water. Default on. |
| Shape | **Box**, **Sphere**, **Cylinder** or **Capsule**. Default Box. |
| Width | Size along local X for a box. Named **Diameter** for the round shapes. Default 4. |
| Height | Size along local Y. Hidden for a sphere. For a cylinder or capsule it is the total height, including a capsule's rounded ends. Default 4. |
| Length | Size along local Z. Box only. Default 4. |

Each size is 0.01 to 10,000.

## Notes

- World scenes only.
- Water inside the shape is removed from every water body. It affects drawing, water queries and buoyancy.
- Disabling it brings the water back.

## Related

- [Water](../graphics/water.md)
- [Sample Water Surface](../scripting/class/sample-water-surface.md)
