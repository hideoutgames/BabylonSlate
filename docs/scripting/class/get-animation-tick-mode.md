---
node: anim.actor.getTickMode
---

# Get Animation Tick Mode

Returns when an Animation Graph runs: Always, When Visible or Never.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Target | AnimationGraphComponent Reference | The Animation Graph component to read. |

## Outputs

| Pin | Type |
| --- | --- |
| Tick Mode | AnimationTickMode |

## Notes

- Returns the component's **Tick Mode**, as the [Animation Graph component](../../components/animation-graph.md) sets it or [Set Animation Tick Mode](set-animation-tick-mode.md) last changed it.
- Returns **Always** when Target is not an Animation Graph component.
