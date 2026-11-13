# Animation Graph

A state machine that plays clips and switches between them. There are two types, which never convert into each other:

| Type | Plays |
| --- | --- |
| 3D Animation Graph | [Animations](animation.md) on the graph's [Skeleton](skeleton.md). |
| 2D Animation Graph | [Sprite Animations](sprite-animation.md). |

## Create

In the **Content Browser**, choose **New Asset > Animation > 3D Animation Graph** or **2D Animation Graph**. For a 3D graph, pick its **Skeleton** in the New Asset dialog, or set it later in the graph's **Inspector**.

To make a 3D graph on a rig, right-click its Skeleton or one of its Models and choose **Create Animation Graph**. The graph is named after it and set to its Skeleton.

## Editor

Double-tap an Animation Graph to open it. A mode switch at the top of the editor changes between **State Machine** and **Animation Object**.

**State Machine**

- **Graph**: each state is a node. Drag from one state to another to add a transition. Select a wire or its blend dot to edit that transition.
- **Variables**: the graph's variables and its states. **Add Variable** and **Add State** add rows; the entry state shows an **Entry** badge.
- **Inspector**: settings for the selected state or transition, or the graph's **Skeleton** (3D) when nothing is selected. With several states selected, it shows the **Clip** and **Playback** settings they all have, with **Mixed Values** where they differ. An edit changes every selected state, and typing a sum such as `Mixed Values+4` in **Speed** changes each from its own value ([multi-selection](../start/editor-tour.md#scene-panels)). Names, the entry state and transitions are edited one state at a time. A state's outgoing transitions are listed under **Transitions**, one card each; collapse a card to see only its blend time and direction.
- **Compiler Results**: errors and warnings.

**Animation Object**

A script graph that runs for each Animation Graph component using the graph. It starts with [Event Initialize Animation](../scripting/animation/event-initialize-animation.md) and [Event Update Animation](../scripting/animation/event-update-animation.md). Use it to set the graph's variables.

## Settings

**State**

| Setting | Description |
| --- | --- |
| Name | The state's name. Names must be unique. |
| Entry State | Turn on to make this the state the graph starts in. |
| Animation | 3D graphs. The [Animation](animation.md) the state plays. The picker lists only Animations on the graph's Skeleton. |
| Sprite Animation | 2D graphs. The [Sprite Animation](sprite-animation.md) the state plays. |
| Speed | Playback speed multiplier. At 0 the state holds its clip's first frame. |
| Loop | Whether the clip repeats. |

**Graph** (3D)

| Setting | Description |
| --- | --- |
| Skeleton | The [Skeleton](skeleton.md) every Animation in the graph must be on. Any Model on it can run the graph. With **None**, the graph plays Animations that have no Skeleton, such as a door's. After a change, **Compiler Results** lists each state whose Animation is on another Skeleton. |

**Transition**

| Setting | Description |
| --- | --- |
| Blend Time | How long the old clip blends into the new one. |
| Priority | When several transitions leave a state, the lower number is checked first. |
| Direction | **One Way** or **Both Ways**. Both Ways adds the reverse transition. |
| Open Rule | Opens the transition's rule graph. The transition fires when its **Exit State** and **Enter State** nodes are both true. An unconnected one counts as true. **Back To State Machine** returns to the graph with the transition selected. |
| Flip Direction | Swaps the source and target of a One Way transition. |

Variables can be Bool, Int, Float, String, Tag or Tag Container. Rule graphs read them with Get Variable nodes.

## Watch the graph run

Start a Simulation with the graph open and pick an actor in **Debug Instance**. In **State Machine** mode the states the graph plays light up, and a transition lights up when it is taken. **Animation Object** mode lights up the nodes that run, like a Class. See [Watch a graph run](../debugging/index.md#watch-a-graph-run).

To stop the game when the graph enters a state, choose **Add Breakpoint** from the state's menu. To stop it when a transition is taken, select the transition or its state and choose **Add Breakpoint** in the **Inspector**; a Both Ways transition also has **Add Reverse Breakpoint**. **Edit Breakpoint…** makes one stop only on a given hit. See [Breakpoints](../debugging/index.md#breakpoints).

## Notes

- Add an [Animation Graph component](../components/animation-graph.md) to an actor to run the graph.
- Change variables and states from scripts with [Set Anim Graph Variable](../scripting/class/set-anim-graph-variable.md) and [Jump To State](../scripting/class/jump-to-state.md).

## Related

- [Sprites](../2d/sprites.md)
- [Models](../graphics/models.md)
- [Animation Graph nodes](../scripting/animation/index.md)
- [Get Current State](../scripting/class/get-current-state.md)
