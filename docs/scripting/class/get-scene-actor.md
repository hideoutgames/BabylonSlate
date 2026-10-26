---
node: scene.getOwnedActor
---

# Get Scene Actor

Returns an actor that this Scene or Scene Layer places, or null if it is gone.

## Outputs

| Pin | Type |
| --- | --- |
| Actor | Actor Reference |

## Notes

- Only in a [Scene Script or Scene Layer Script](../scene-scripts.md). Add Node lists one for each placed actor, titled with its name, such as **Get Player Start**.
- The reference is typed to the actor's Class, so its variables and functions connect without a cast.
- In a Scene Layer Script it returns the actor of this copy of the layer.
