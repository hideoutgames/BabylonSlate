# Animation Graph

Plays clips on a character and switches between them. A graph is built from pose graphs and State Machines. There are two types, which never convert into each other:

| Type | Plays | Its graphs pass |
| --- | --- | --- |
| 3D Animation Graph | [Animations](animation.md) on the graph's [Skeleton](skeleton.md). | Poses |
| 2D Animation Graph | [Sprite Animations](sprite-animation.md). | Frames |

## Create

In the **Content Browser**, choose **New Asset > Animation > 3D Animation Graph** or **2D Animation Graph**. For a 3D graph, pick its **Skeleton** in the New Asset dialog, or set it later in the graph's **Inspector**.

To make a 3D graph on a rig, right-click its Skeleton or one of its Models and choose **Create Animation Graph**. The graph is named after it and set to its Skeleton.

## Editor

Double-tap an Animation Graph to open it. A mode switch at the top of the editor changes between **State Machine** and **Animation Object**.

**State Machine**

The graph has three levels. A bar above the canvas shows where you are, such as **Anim Graph › Locomotion › Run**. Tap a name in it to go there, or tap **Back** to step out one level.

- **Anim Graph**: the top level, a pose graph that ends in **Output Pose** (2D: **Output Frame**). Its result is what the [Animation Graph component](../components/animation-graph.md) plays. A new graph has one [State Machine](../scripting/animation/state-machine-pose.md) node wired to the output. Add more State Machine nodes and blend them, for example a locomotion State Machine with an upper-body one. Adding a State Machine node adds a State Machine; deleting the node deletes it. Double-tap a State Machine node to open it.
- **State Machine**: each state is a node. Drag from one state to another to add a transition. Select a wire or its blend dot to edit that transition. Double-tap a state to open its state graph.
- **State graph**: each state's own pose graph, ending in **Output Pose** or **Output Frame**. A new state has one [Sequence Player](../scripting/animation/sequence-player.md) (2D: [Sprite Animation Player](../scripting/animation/sprite-animation-player.md)) wired to the output. Add nodes such as [Blend](../scripting/animation/blend.md) or [Blend Poses By Bool](../scripting/animation/blend-poses-by-bool.md) to mix clips in one state, or [Flip Frame](../scripting/animation/flip-frame.md) to face a sprite the other way.

Pose and frame wires are thick and connect only to pins of their own type. The other inputs, such as **Play Rate**, **Alpha** and **Active**, take a value on the node or a wire from pure nodes: a Get Variable node, math, or in a state graph the [state nodes](../scripting/animation/index.md#state) such as Get Normalized Time.

The panels show:

- **Variables**: the graph's variables and the open State Machine's states. **Add Variable** and **Add State** add rows; the entry state shows an **Entry** badge. Tap a state to select it on its State Machine.
- **Inspector**: in a State Machine, settings for the selected state or transition, or the State Machine's **Name** and the graph's **Skeleton** (3D) when nothing is selected. With several states selected, it shows the **Clip** and **Playback** settings they all have, with **Mixed Values** where they differ. An edit changes every selected state, and typing a sum such as `Mixed Values+4` in **Speed** changes each from its own value ([multi-selection](../start/editor-tour.md#scene-panels)). Names, the entry state and transitions are edited one state at a time. A state's outgoing transitions are listed under **Transitions**, one card each; collapse a card to see only its blend time and direction. In the Anim Graph or a state graph it shows the selected node's settings, such as a player's **Animation** and **Loop**.
- **Compiler Results**: errors and warnings.

**Animation Object**

A script graph that runs for each Animation Graph component using the graph. It starts with [Event Initialize Animation](../scripting/animation/event-initialize-animation.md) and [Event Update Animation](../scripting/animation/event-update-animation.md). Use it to set the graph's variables.

## Settings

**State**

| Setting | Description |
| --- | --- |
| Name | The state's name. Names must be unique in its State Machine. |
| Entry State | Turn on to make this the state its State Machine starts in. |
| Animation | 3D graphs. The [Animation](animation.md) the state plays. The picker lists only Animations on the graph's Skeleton. |
| Sprite Animation | 2D graphs. The [Sprite Animation](sprite-animation.md) the state plays. |
| Speed | Playback speed multiplier. At 0 the state holds its clip's first frame. |
| Loop | Whether the clip repeats. |
| Open State Graph | Opens the state's graph. |

**Animation**, **Sprite Animation**, **Speed** and **Loop** edit the state's player while its graph is one player wired to the output. Once you add other nodes, edit the graph's nodes instead; the state's card then shows **State Graph**. A state's time, length and looping, which its transition rules read, follow the player reached from the output through each node's first pose input.

**State Machine**

| Setting | Description |
| --- | --- |
| Name | The State Machine's name, shown on its node in the Anim Graph. Names must be unique. |

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

Variables can be Bool, Int, Float, String, Tag or Tag Container. Rule and pose graphs read them with Get Variable nodes.

## Watch the graph run

Start a Simulation with the graph open and pick an actor in **Debug Instance**. On a State Machine's canvas the states it plays light up, and a transition lights up when it is taken; each State Machine shows its own. **Animation Object** mode lights up the nodes that run, like a Class. See [Watch a graph run](../debugging/index.md#watch-a-graph-run).

To stop the game when the graph enters a state, choose **Add Breakpoint** from the state's menu. To stop it when a transition is taken, select the transition or its state and choose **Add Breakpoint** in the **Inspector**; a Both Ways transition also has **Add Reverse Breakpoint**. **Edit Breakpoint…** makes one stop only on a given hit. See [Breakpoints](../debugging/index.md#breakpoints).

## Notes

- Add an [Animation Graph component](../components/animation-graph.md) to an actor to run the graph.
- Change variables and states from scripts with [Set Anim Graph Variable](../scripting/class/set-anim-graph-variable.md) and [Jump To State](../scripting/class/jump-to-state.md). Jump To State and [Get Current State](../scripting/class/get-current-state.md) use the first State Machine the Anim Graph plays.

## Related

- [Sprites](../2d/sprites.md)
- [Models](../graphics/models.md)
- [Animation Graph nodes](../scripting/animation/index.md)
- [Get Current State](../scripting/class/get-current-state.md)
