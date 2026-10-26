---
node: scene.getOwnedComponent
---

# Get Scene Actor Component

Returns a component of an actor that this Scene or Scene Layer places, or null if it is gone.

## Outputs

| Pin | Type |
| --- | --- |
| Component | Component Reference |

## Notes

- Only in a [Scene Script or Scene Layer Script](../scene-scripts.md). Add Node lists one for each component of each placed actor, titled with both names, such as **Get Point Light (Lamp)**.
- The reference is typed to the component's type, so its properties and functions connect directly.
- In a Scene Layer Script it returns the component of this copy of the layer.
