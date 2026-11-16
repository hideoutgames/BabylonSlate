# Animation Graph Nodes

Nodes that only exist in Animation Graphs: in the Animation Object's event graph, in transition rules, and in each state's graph. Rule and state graphs can also use pure [Class nodes](../class/index.md), such as math on a variable.

## Events

| Node | Description |
| --- | --- |
| [Event Initialize Animation](event-initialize-animation.md) | Runs once when an Animation Graph component first starts running this graph. |
| [Event Update Animation](event-update-animation.md) | Runs every update, before the state machine checks its transitions. |
| [Animation Event](animation-event.md) | Runs when this graph fires the Animation Event it is named after, such as a footstep. |

## Rules

| Node | Description |
| --- | --- |
| [Enter State](enter-state.md) | Decides whether the transition may enter its target state. |
| [Exit State](exit-state.md) | Decides whether the transition may leave its source state. |

## State

| Node | Description |
| --- | --- |
| [Get Duration Seconds](get-duration-seconds.md) | Returns the length in seconds of the current state's clip. |
| [Get Elapsed Seconds](get-elapsed-seconds.md) | Returns how many seconds the current state's clip has played. |
| [Exit Time Reached](exit-time-reached.md) | Returns true in the update where the clip passes a given point in time. |
| [Is Looping](is-looping.md) | Returns whether the current state's clip loops. |
| [Just Finished](just-finished.md) | Returns true only in the update where a non-looping clip reaches its end. |
| [Just Looped](just-looped.md) | Returns true only in the update where a looping clip wraps back to the start. |
| [Get Loop Count](get-loop-count.md) | Returns how many times the current clip has looped since the state started. |
| [Get Normalized Time](get-normalized-time.md) | Returns how far through its clip the current state is, from 0 to 1. |
| [Get Remaining Ratio](get-remaining-ratio.md) | Returns the fraction of the current clip still to play, from 1 down to 0. |
| [Get Remaining Seconds](get-remaining-seconds.md) | Returns how many seconds are left before the current clip ends or loops. |

## Poses

Nodes of a 3D Animation Graph's state graphs. Their **Pose** wires carry a whole Skeleton pose and connect only to other Pose pins. A pose output connects to one input; use [Save Cached Pose](save-cached-pose.md) to use a pose in more than one place.

| Node | Description |
| --- | --- |
| [Output Pose](output-pose.md) | The pose this graph produces. Every state graph ends in one. |
| [Sequence Player](sequence-player.md) | Plays an Animation. |
| [Sequence Evaluator](sequence-evaluator.md) | Holds an Animation at a normalized time. |
| [Blend Space Player](blend-space-player.md) | Plays a Blend Space: the Animations around X and Y, in step. |
| [Rest Pose](rest-pose.md) | The Skeleton's rest pose. |
| [Blend](blend.md) | Blends two poses by Alpha: 0 is A, 1 is B. |
| [Blend Poses By Bool](blend-poses-by-bool.md) | Blends to True Pose or False Pose as Active changes. |
| [Blend Poses By Int](blend-poses-by-int.md) | Blends to the pose Active Index picks. |
| [Apply Additive](apply-additive.md) | Adds an additive Animation's change from its base pose, by Alpha, to the Base pose. |
| [Layered Blend Per Bone](layered-blend-per-bone.md) | Blends each Blend Pose onto the Base Pose by its Blend Weight, on the bones of its branch filters only. |
| [Slot](slot.md) | Shows the Animations scripts play on this slot with Play Slot Animation over the Source pose. |
| [Save Cached Pose](save-cached-pose.md) | Saves a pose under a name, so Use Cached Pose nodes in any state reuse it, evaluated once a frame. |
| [Use Cached Pose](use-cached-pose.md) | The pose a Save Cached Pose saved under this name. |

## Skeletal Controls

Nodes of a 3D Animation Graph's state graphs that change bones of the pose they take.

| Node | Description |
| --- | --- |
| [Transform Bone](transform-bone.md) | Changes one bone's translation, rotation and scale: each replaced or added to, in actor, parent or bone space, blended in by Alpha. |
| [Look At](look-at.md) | Turns one bone so its Aim Axis points at Target, within an angle limit, optionally keeping its Up Axis up, blended in by Alpha. |
| [Two Bone IK](two-bone-ik.md) | Moves a hand or foot to Effector by turning its parent and grandparent, bending toward Joint Target, blended in by Alpha. |
| [Spring Bones](spring-bones.md) | Simulates the bones below a Root Bone as springs that trail the pose, such as a tail, hair or a cape, blended in by Alpha. |
| [Foot Placement](foot-placement.md) | Plants each foot on the ground beneath it with Two Bone IK, lowering the pelvis so the lower foot reaches, blended in by Alpha. |

## Frames

Nodes of a 2D Animation Graph's state graphs. Their **Frame** wires carry the Sprite Animation frame to show and connect only to other Frame pins.

| Node | Description |
| --- | --- |
| [Output Frame](output-frame.md) | The frame this graph shows. Every state graph ends in one. |
| [Sprite Animation Player](sprite-animation-player.md) | Plays a Sprite Animation. |
| [Sprite Blend Space Player](sprite-blend-space-player.md) | Plays the Sprite Animation of a Sprite Blend Space nearest X and Y. |
| [Select Frame By Bool](select-frame-by-bool.md) | Shows True Frame or False Frame as Active changes. |
| [Select Frame By Int](select-frame-by-int.md) | Shows the frame Active Index picks. |
| [Flip Frame](flip-frame.md) | Mirrors a frame, so one clip faces both ways. |
| [Frame Slot](frame-slot.md) | Shows the Sprite Animations scripts play on this slot with Play Slot Animation instead of the Source frame. |
