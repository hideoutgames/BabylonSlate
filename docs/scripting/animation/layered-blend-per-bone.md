---
node: anim.pose.layeredBlendPerBone
---

# Layered Blend Per Bone

Blends each Blend Pose onto the Base Pose by its Blend Weight, on the bones of its branch filters only.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Base Pose | Pose | The pose every bone starts from. |
| Blend Pose0 | Pose | The pose blended onto its branches. |
| Blend Weight0 | Float | How much of Blend Pose0 its branches take, from 0 to 1. Defaults to 1. |

## Outputs

| Pin | Type |
| --- | --- |
| Pose | Pose |

## Notes

- Set **Blend Poses**, the number of blend inputs from 1 to 16, in the **Inspector**. Each adds a **Blend Pose** and a **Blend Weight** pin.
- Under each **Blend Pose N Branches** list, **Add Branch** picks a bone from the graph's **Skeleton**. The input plays on that bone and every bone below it.
- A branch's **Blend Depth** sets how its weight ramps in down the branch:

  | Blend Depth | Effect |
  | --- | --- |
  | 0 | The bone and every bone below it take the full Blend Weight. |
  | N above 0 | The weight ramps in over N bones: the branch's bone takes 1/N of it, the bone N − 1 below it all of it. |
  | -1 | Leaves this bone and the bones below it out of an enclosing branch. |

  Where branches nest, the nearest one up a bone's chain decides.
- Where the blend inputs' weights on a bone add up to more than 1, they share it and the Base Pose takes none; below 1, the Base Pose takes the rest.
- A bone that the blend input's Animation has no key for takes the Skeleton's rest pose for its share.
- Every input keeps playing whatever its weight, so a clip does not restart when its weight rises again.
- Bones blend in their parent's space, so an upper-body layer follows the Base Pose's hips and spine below its branch.
- The state's time follows the Base Pose.
- Morph targets follow the Base Pose.
