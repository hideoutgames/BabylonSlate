# Animation Graph

A state machine that plays Animation or Sprite Animation clips and switches between them.

## Create

In the **Content Browser**, choose **New Asset > Animation > Animation Graph**.

## Editor

Double-tap an Animation Graph to open it. A mode switch at the top of the editor changes between **State Machine** and **Animation Object**.

**State Machine**

- **Graph**: each state is a node. Drag from one state to another to add a transition. Select the blend dot on a wire to edit that transition.
- **Variables**: the graph's variables and its states. **Add Variable** and **Add State** add rows; the entry state shows an **Entry** badge.
- **Inspector**: settings for the selected state or transition.
- **Compiler Results**: errors and warnings.

**Animation Object**

A script graph that runs for each Animation Graph component using the graph. It starts with [Event Initialize Animation](../scripting/animation/event-initialize-animation.md) and [Event Update Animation](../scripting/animation/event-update-animation.md). Use it to set the graph's variables.

## Settings

**State**

| Setting | Description |
| --- | --- |
| Name | The state's name. Names must be unique. |
| Entry State | Turn on to make this the state the graph starts in. |
| Clip Kind | **Animation** or **Sprite**. |
| Clip Asset | An [Animation](animation.md) or a [Sprite Animation](sprite-animation.md), matching Clip Kind. |
| Speed | Playback speed multiplier. At 0 the state holds its clip's first frame. |
| Loop | Whether the clip repeats. |

**Transition**

| Setting | Description |
| --- | --- |
| Blend Time | How long the old clip blends into the new one. |
| Priority | When several transitions leave a state, the lower number is checked first. |
| Direction | **One Way** or **Both Ways**. Both Ways adds the reverse transition. |
| Open Rule | Opens the transition's rule graph. The transition fires when its **Exit State** and **Enter State** nodes are both true. An unconnected one counts as true. |
| Flip Direction | Swaps the source and target of a One Way transition. |

Variables can be Bool, Int, Float, String, Tag or Tag Container. Rule graphs read them with Get Variable nodes.

## Watch the graph run

Start a Simulation with the graph open and pick an actor in **Debug Instance**. In **State Machine** mode the states the graph plays light up, and a transition lights up when it is taken. **Animation Object** mode lights up the nodes that run, like a Class. See [Watch a graph run](../debugging/index.md#watch-a-graph-run).

To stop the game when the graph enters a state, choose **Add Breakpoint** from the state's menu. To stop it when a transition is taken, select the transition or its state and choose **Add Breakpoint** in **Details**; a Both Ways transition also has **Add Reverse Breakpoint**. **Edit Breakpoint…** makes one stop only on a given hit. See [Breakpoints](../debugging/index.md#breakpoints).

## Notes

- Add an [Animation Graph component](../components/animation-graph.md) to an actor to run the graph.
- Change variables and states from scripts with [Set Anim Graph Variable](../scripting/class/set-anim-graph-variable.md) and [Jump To State](../scripting/class/jump-to-state.md).

## Related

- [Sprites](../2d/sprites.md)
- [Models](../graphics/models.md)
- [Animation Graph nodes](../scripting/animation/index.md)
- [Get Current State](../scripting/class/get-current-state.md)
