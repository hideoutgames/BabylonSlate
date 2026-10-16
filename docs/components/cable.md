# Cable

A simulated rope or wire that hangs between two points as a tube, with optional collision.

## Add it

Select an actor, then choose **Add Component > Physics > Cable**. You can also place a ready-made actor from **Place Actors > Environment > Cable**.

## Settings

| Setting | Description |
| --- | --- |
| Enabled | Simulates and draws the cable. Default on. |
| Material | The Material for the tube. |
| Cable Length | Rest length in units. A length longer than the gap between the ends makes the cable sag. Default 4. |
| Segments | Simulation segments, 1 to 64. More cost more. Default 16. |
| Cable Width | Tube diameter. Default 0.05. |
| Sides | Sides around the tube, 3 to 12. Default 6. |
| Tile Material | Texture repeats along the cable. Default 1. |
| Attach Start | Pins the start to this component. Default on. |
| Attach End | Pins the end to End Position. Default on. |
| Target Actor | The actor the end attaches to. **Self** uses the cable's own frame. |
| Target Component | A component on the target actor to attach to. |
| End Position | Offset of the end in the target's space. Default 3, 0, 0. |
| Gravity Scale, Cable Force | Gravity multiplier and an extra world-space push. Defaults 1 and 0, 0, 0. |
| Damping | Velocity lost over time, 0 to 1. Default 0.03. |
| Enable Stiffness | Resists bending. Costs more. Default off. |
| Enable Collision | Collides with the scene in Play. Default off. |
| Collision Friction | Grip on surfaces, 0 to 1. Default 0.2. |

**Solver Iterations** (6), **Substep Time**, **Max Substeps** (4), **Sleep Threshold** (0.01) and **Sleep Delay** (0.5) trade accuracy against cost.

## Notes

- World scenes only.
- The editor shows a gentle simulation without collision. Collision applies only in Play.
- Collision is one-way. The cable stops on scene colliders, but it does not push them or pull the actors it is attached to.
- A cable at rest sleeps and costs almost nothing. Moving an end wakes it.

## Related

- [Geometry](../graphics/geometry.md)
- [Physics](../physics/index.md)
