# Animation Graph Nodes

Nodes that only exist in Animation Graphs: in the Animation Object's event graph, in transition rules, and in the pose graphs of the Anim Graph and each state. Rule and pose graphs can also use pure [Class nodes](../class/index.md), such as math on a variable.

## Events

| Node | Description |
| --- | --- |
| [Event Initialize Animation](event-initialize-animation.md) | Runs once when an Animation Graph component first starts running this graph. |
| [Event Update Animation](event-update-animation.md) | Runs every update, before the state machine checks its transitions. |

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

Nodes of a 3D Animation Graph's pose graphs. Their **Pose** wires carry a whole Skeleton pose and connect only to other Pose pins.

| Node | Description |
| --- | --- |
| [Output Pose](output-pose.md) | The pose this graph produces. Every pose graph ends in one. |
| [State Machine](state-machine-pose.md) | The pose of a State Machine's active state, blended through its transitions. |
| [Sequence Player](sequence-player.md) | Plays an Animation. |
| [Sequence Evaluator](sequence-evaluator.md) | Holds an Animation at a normalized time. |
| [Rest Pose](rest-pose.md) | The Skeleton's rest pose. |
| [Blend](blend.md) | Blends two poses by Alpha: 0 is A, 1 is B. |
| [Blend Poses By Bool](blend-poses-by-bool.md) | Blends to True Pose or False Pose as Active changes. |
| [Blend Poses By Int](blend-poses-by-int.md) | Blends to the pose Active Index picks. |

## Frames

Nodes of a 2D Animation Graph's frame graphs. Their **Frame** wires carry the Sprite Animation frame to show and connect only to other Frame pins.

| Node | Description |
| --- | --- |
| [Output Frame](output-frame.md) | The frame this graph shows. Every frame graph ends in one. |
| [State Machine](state-machine-frame.md) | The frame of a State Machine's active state. |
| [Sprite Animation Player](sprite-animation-player.md) | Plays a Sprite Animation. |
| [Select Frame By Bool](select-frame-by-bool.md) | Shows True Frame or False Frame as Active changes. |
| [Select Frame By Int](select-frame-by-int.md) | Shows the frame Active Index picks. |
| [Flip Frame](flip-frame.md) | Mirrors a frame, so one clip faces both ways. |
