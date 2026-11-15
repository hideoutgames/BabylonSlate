---
node: anim.frame.flip
---

# Flip Frame

Mirrors a frame, so one clip faces both ways.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Frame | Frame | The frame to mirror. |
| Flip X | Boolean | Mirror left to right. Defaults to false. |
| Flip Y | Boolean | Mirror top to bottom. Defaults to false. |

## Outputs

| Pin | Type |
| --- | --- |
| Frame | Frame |

## Notes

- The frame mirrors about its pivot, and so does its collision box.
- Wire a variable into **Flip X** to face the direction the character moves.
