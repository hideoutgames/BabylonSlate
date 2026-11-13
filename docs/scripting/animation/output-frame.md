---
node: anim.frame.output
---

# Output Frame

The frame this graph shows. Every state graph ends in one.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Frame | Frame | The frame to show. |

## Notes

- Haptic adds it to every state graph of a 2D Animation Graph, and you cannot delete it.
- Its frame is the state's frame. During a transition with a blend time, the sprite shows the frame with more weight.
