# Animation Graph

Plays clips on a character and switches between them. Each graph is one State Machine: its states each have a state graph that picks what they play, and its transitions switch between them. There are two types, which never convert into each other:

| Type | Plays | Its graphs pass |
| --- | --- | --- |
| 3D Animation Graph | [Animations](animation.md) on the graph's [Skeleton](skeleton.md). | Poses |
| 2D Animation Graph | [Sprite Animations](sprite-animation.md). | Frames |

## Create

In the **Content Browser**, choose **New Asset > Animation > 3D Animation Graph** or **2D Animation Graph**. For a 3D graph, pick its **Skeleton** in the New Asset dialog, or set it later in the graph's **Inspector**.

To make a 3D graph on a rig, right-click its Skeleton or one of its Models and choose **Create Animation Graph**. The graph is named after it and set to its Skeleton.

## Editor

Double-tap an Animation Graph to open it. Its **Graph** window shows the graph's State Machine; the **Animation Object** window, a tab beside it, shows the graph's script. Both are windows like any other: drag a tab to see them side by side, or reopen a closed one from **Windows**.

**Graph**

The Graph opens on the State Machine. A bar above the canvas shows where you are: **State Machine**, then the state's name while you are in its state graph, such as **State Machine › Run**. Tap **State Machine** in it, or tap **Back**, to step out.

- **State Machine**: each state is a node, and the graph starts in the entry state. Drag from any side of a state onto another state to add a transition from the state you dragged: it leaves by the side you dragged from and enters the side you release on, or the side facing the first state when you release near the middle. Dragging between the same two states again moves that transition to the new sides. Select a wire or its blend dot to edit that transition. Double-tap a state to open its state graph, or a wire to open its transition's rule.
- **Two-way transitions**: a transition back between the same two sides shares the first one's wire, with an arrow at each end. Double-tapping a shared wire opens the rule of the direction whose arrowhead is nearer where you tapped. A transition back on other sides is a wire of its own.
- **State graph**: each state's own graph, ending in its **Output Pose** (2D: **Output Frame**), which you cannot delete. Its result is what the state plays. A new state has one [Sequence Player](../scripting/animation/sequence-player.md) (2D: [Sprite Animation Player](../scripting/animation/sprite-animation-player.md)) wired to the output. Add nodes such as [Blend](../scripting/animation/blend.md) or [Blend Poses By Bool](../scripting/animation/blend-poses-by-bool.md) to mix clips in one state, or [Flip Frame](../scripting/animation/flip-frame.md) to face a sprite the other way.
- **Transition rule**: the graph that decides when a transition fires. **Back To State Machine** returns with the transition selected.

Pose and frame wires are thick and connect only to pins of their own type. The other inputs, such as **Play Rate**, **Alpha** and **Active**, take a value on the node or a wire from pure nodes: a Get Variable node, math, or the [state nodes](../scripting/animation/index.md#state) such as Get Normalized Time.

The panels show:

- **Variables**: the graph's variables and its states. **Add Variable** and **Add State** add rows; the entry state shows an **Entry** badge. Tap a state to select it on the State Machine.
- **Inspector**: follows the canvas you last used. On the State Machine, it shows settings for the selected state or transition, or the graph's own settings (3D: **Skeleton**) when nothing is selected. With several states selected, it shows the **Clip** and **Playback** settings they all have, with **Mixed Values** where they differ. An edit changes every selected state, and typing a sum such as `Mixed Values+4` in **Speed** changes each from its own value ([multi-selection](../start/editor-tour.md#scene-panels)). Names, the entry state and transitions are edited one state at a time. A state's outgoing transitions are listed under **Transitions**, one card each; collapse a card to see only its blend time and direction. In a state graph, a transition rule or the **Animation Object**, it shows the selected node's settings, such as a player's **Animation** and **Loop**.
- **Compiler Results**: errors and warnings.

**Animation Object**

The **Animation Object** window holds a script graph that runs for each Animation Graph component using the graph. It starts with [Event Initialize Animation](../scripting/animation/event-initialize-animation.md) and [Event Update Animation](../scripting/animation/event-update-animation.md). Use it to set the graph's variables.

## Settings

**State**

| Setting | Description |
| --- | --- |
| Name | The state's name. Names must be unique in the graph. |
| Entry State | Turn on to make this the state the graph starts in. |
| Animation | 3D graphs. The [Animation](animation.md) the state plays. The picker lists only Animations on the graph's Skeleton. |
| Sprite Animation | 2D graphs. The [Sprite Animation](sprite-animation.md) the state plays. |
| Speed | Playback speed multiplier. At 0 the state holds its clip's first frame. |
| Loop | Whether the clip repeats. |
| Open State Graph | Opens the state's graph. |

**Animation**, **Sprite Animation**, **Speed** and **Loop** edit the state's player while its graph is one player wired to the output. Once you add other nodes, edit the graph's nodes instead; the state's card then shows **State Graph**. A state's time, length and looping, which its transition rules read, follow the player reached from the output through each node's first pose input.

**Graph** (3D)

| Setting | Description |
| --- | --- |
| Skeleton | The [Skeleton](skeleton.md) every Animation in the graph must be on. Any Model on it can run the graph. With **None**, the graph plays Animations that have no Skeleton, such as a door's. After a change, **Compiler Results** lists each state whose Animation is on another Skeleton. |

**Transition**

| Setting | Description |
| --- | --- |
| Blend Time | How long the old clip blends into the new one. |
| Priority | When several transitions leave a state, the lower number is checked first. |
| Direction | **One Way** or **Both Ways**. Both Ways adds the reverse transition on the same two sides, sharing the wire. |
| Open Rule | Opens the transition's rule graph, as double-tapping its wire does. The transition fires when its **Exit State** and **Enter State** nodes are both true. An unconnected one counts as true. **Back To State Machine** returns to the State Machine with the transition selected. |
| Flip Direction | Swaps the source and target of a One Way transition. |

Variables can be Bool, Int, Float, String, Tag or Tag Container. Rule and state graphs read them with Get Variable nodes.

## Watch the graph run

Start a Simulation with the graph open and pick an actor in **Debug Instance**. On the State Machine's canvas the states it plays light up, and a transition lights up when it is taken. The **Animation Object** window lights up the nodes that run, like a Class. See [Watch a graph run](../debugging/index.md#watch-a-graph-run).

To stop the game when the graph enters a state, choose **Add Breakpoint** from the state's menu. To stop it when a transition is taken, select the transition or its state and choose **Add Breakpoint** in the **Inspector**; a Both Ways transition also has **Add Reverse Breakpoint**. **Edit Breakpoint…** makes one stop only on a given hit. See [Breakpoints](../debugging/index.md#breakpoints).

## Notes

- Add an [Animation Graph component](../components/animation-graph.md) to an actor to run the graph.
- Change variables and states from scripts with [Set Anim Graph Variable](../scripting/class/set-anim-graph-variable.md) and [Jump To State](../scripting/class/jump-to-state.md), and read the active state with [Get Current State](../scripting/class/get-current-state.md).
- A graph has exactly one State Machine, so it cannot layer a second set of states, such as upper-body gestures, over another.

## Related

- [Sprites](../2d/sprites.md)
- [Models](../graphics/models.md)
- [Animation Graph nodes](../scripting/animation/index.md)
- [Get Current State](../scripting/class/get-current-state.md)
