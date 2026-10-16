# Water Buoyancy

Makes an actor float on water: it rides the waves and reacts to impacts.

## Add it

Select an actor, then choose **Add Component > Water > Water Buoyancy**.

## Settings

| Setting | Description |
| --- | --- |
| Enabled | Turns buoyancy on or off. Default on. |
| Volume | Floating volume in cubic metres, scaled with the component. 0 sizes it automatically so the body floats about half submerged. In default water, 0.002 floats 1 kg halfway. Default 0. |
| Width | Size of the floating box along local X. Default 1. |
| Length | Size along local Z. Default 1. |
| Height | Size along local Y. Default 1. |
| Drag | How strongly water slows linear motion, 0 to 50. Default 2.5. |
| Angular Drag | How strongly water slows spinning, 0 to 50. Default 1. |
| Offset | Moves the floating box from the component's origin. |

## Notes

- World scenes only. It works with 3D physics.
- Add it alone and the actor floats as a physical body. If the actor has a [Rigid Body](rigid-body.md) and [Collider](collider.md), those set its mass and collisions instead.
- A larger Volume floats higher. Extra weight pushes it deeper. Too small a Volume sinks.
- Objects rock in place with the waves. Only the current carries them along.
- Disabled water and water inside a [Water Removal Volume](water-removal-volume.md) give no lift.
- A [Movement](movement.md) component does not work on an actor that also has Water Buoyancy.

## Related

- [Water](../graphics/water.md)
- [Physics](../physics/index.md)
- [Sample Water Surface](../scripting/class/sample-water-surface.md)
