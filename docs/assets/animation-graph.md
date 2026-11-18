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

Double-tap an Animation Graph to open it. Its **Graph** window shows the graph's State Machine; the **Animation Object** window, a tab beside it, shows the graph's script. The **Preview** window sits above the **Inspector**, and **Preview Values** below **Variables**. All are windows like any other: drag a tab to move one, or reopen a closed one from **Windows**.

**Graph**

The Graph shows the State Machine. Each state's graph opens in a tab of its own beside it, named after the state, as a Class's functions open beside its Event Graph: double-tap the state, or select it and tap **Open State Graph** in the **Inspector**. Opening a state that already has a tab brings that tab forward. Renaming a state renames its tab, and deleting a state closes it. A transition's rule opens in the Graph itself, in place of the State Machine.

- **State Machine**: each state is a node, and the graph starts in the entry state. Drag from any side of a state onto another state to add a transition from the state you dragged: it leaves by the side you dragged from and enters the side you release on, or the side facing the first state when you release near the middle. Dragging between the same two states again moves that transition to the new sides. Release on empty canvas away from the state to open **Add Node** and add a state there with the transition. Release anywhere else, such as close to the state you dragged from, to remove every transition on that side of it. Select a wire or its blend dot to edit that transition. Double-tap a state to open its state graph in its own tab, or a wire to open its transition's rule in the Graph. Double-tap a state's title to rename it.
- **State Alias**: add one from **Add Node** on the State Machine. It plays nothing: its transitions leave from every state it covers (**Any State**, or the states ticked under **Leaves From** in the **Inspector**), but never into the state already playing. Use it for a Hit, Death or Fall that can happen from many states. Wires only leave an alias; none can enter one.
- **Two-way transitions**: a transition back between the same two sides shares the first one's wire, with an arrow at each end. Double-tapping a shared wire opens the rule of the direction whose arrowhead is nearer where you tapped. A transition back on other sides is a wire of its own.
- **State graph**: each state's own graph, in its own tab, ending in its **Output Pose** (2D: **Output Frame**), which you cannot delete. Its result is what the state plays. A new state has one [Sequence Player](../scripting/animation/sequence-player.md) (2D: [Sprite Animation Player](../scripting/animation/sprite-animation-player.md)) wired to the output. Add nodes such as [Blend](../scripting/animation/blend.md), [Blend Poses By Bool](../scripting/animation/blend-poses-by-bool.md) or a [Blend Space Player](../scripting/animation/blend-space-player.md) to mix clips in one state, [Flip Frame](../scripting/animation/flip-frame.md) to face a sprite the other way, or a [Sprite Blend Space Player](../scripting/animation/sprite-blend-space-player.md) to pick a sprite by direction or speed.
- **Transition rule**: the graph that decides when a transition fires. **Back To State Machine** returns with the transition selected.

Pose and frame wires are thick and connect only to pins of their own type. The other inputs, such as **Play Rate**, **Alpha** and **Active**, take a value on the node or a wire from pure nodes: a Get Variable node, math, or the [state nodes](../scripting/animation/index.md#state) such as Get Normalized Time.

The panels show:

- **Variables**: the graph's variables and its states. **Add Variable** and **Add State** add rows; the entry state shows an **Entry** badge. Tap a state to select it on the State Machine, which comes forward.
- **Inspector**: follows the canvas you last used. On the State Machine, it shows settings for the selected state or transition, or the graph's own settings (3D: **Skeleton**) when nothing is selected. With several states selected, it shows the **Clip** and **Playback** settings they all have, with **Mixed Values** where they differ. An edit changes every selected state, and typing a sum such as `Mixed Values+4` in **Speed** changes each from its own value ([multi-selection](../start/editor-tour.md#scene-panels)). Names, the entry state and transitions are edited one state at a time. A state's outgoing transitions are listed under **Transitions**, one card each; collapse a card to see only its blend time and direction. In a state graph, a transition rule or the **Animation Object**, it shows the selected node's settings, such as a player's **Animation** and **Loop**.
- **Compiler Results**: errors and warnings.

**Animation Object**

The **Animation Object** window holds a script graph that runs for each Animation Graph component using the graph. It starts with [Event Initialize Animation](../scripting/animation/event-initialize-animation.md) and [Event Update Animation](../scripting/animation/event-update-animation.md). Use it to set the graph's variables. Its **Add Node** also lists an **Event** node for each [Animation Event](#animation-events) the graph can fire, such as **Event Footstep**.

**Preview**

The **Preview** window plays the graph in the editor, without a Simulation. It runs the graph's transition rules on the values in **Preview Values**, and the State Machine's canvas lights the state that plays and each transition taken, as when you [watch the graph run](#watch-the-graph-run).

| Control | Description |
| --- | --- |
| Play / Pause | Starts or stops the graph. It plays while the window is visible. |
| Step | Pauses and advances one frame (1/60 s). |
| Restart | Returns to the entry state at time 0. Preview Values are kept. |
| Speed | 0.25× to 2×. |
| Preview Model | 3D. The Model the Preview shows, from the Models on the graph's Skeleton, or with no Skeleton, the Models its Animations come from. The choice is saved with the graph and is used only in the editor. |
| Bones | 3D. Shows the Skeleton's bones instead of the mesh, with a marker at each [Look At](../scripting/animation/look-at.md) target and [Two Bone IK](../scripting/animation/two-bone-ik.md) Effector (orange) and Joint Target (violet), and each [Spring Bones](../scripting/animation/spring-bones.md) collider (see-through blue). |

The bar ends with the playing state and its time. A 3D graph plays on a floor grid; drag to orbit. A 2D graph shows the current frame on a checkerboard, flipped as the state graph flips it.

**Preview Values** lists the graph's variables with the values the Preview uses. They start at each variable's default and are kept until you change them, change the variable's type or choose **Reset Values**. They never change the variables' defaults.

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
| Sync Group | Looping players with the same name play at the same point of their cycles. See [Sync Groups](#sync-groups). |
| Open State Graph | Opens the state's graph in its own tab beside the Graph, or brings its open tab forward. |
| Enter Event, Exit Event, Fully Blended Event | Animation Events the state fires itself: as it starts, as it is left, and once it plays alone after a blend (at once with no blend). Empty fires none. See [Animation Events](#animation-events). |

**Animation**, **Sprite Animation**, **Speed** and **Loop** edit the state's player while its graph is one player wired to the output. Once you add other nodes, edit the graph's nodes instead; the state's card then shows **State Graph**. A state's time, length and looping, which its transition rules read, follow the player reached from the output through each node's first pose input.

**Graph** (3D)

| Setting | Description |
| --- | --- |
| Skeleton | The [Skeleton](skeleton.md) every Animation in the graph must be on. Any Model on it can run the graph. With **None**, the graph plays Animations that have no Skeleton, such as a door's. After a change, **Compiler Results** lists each state whose Animation is on another Skeleton. |

**State Alias**

| Setting | Description |
| --- | --- |
| Name | The alias's name, unique among the states and aliases. |
| Any State | Its transitions leave from every state. |
| Leaves From | With Any State off, the states its transitions leave from. A state you delete leaves the list. |

An alias's transitions take their turn among each covered state's own transitions by **Priority**. An alias that covers no state is reported in **Compiler Results**.

**Transition**

| Setting | Description |
| --- | --- |
| Blend Time | How long the old clip blends into the new one. |
| Priority | When several transitions leave a state, the lower number is checked first. |
| Direction | **One Way** or **Both Ways**. Both Ways adds the reverse transition on the same two sides, sharing the wire. |
| Open Rule | Opens the transition's rule graph, as double-tapping its wire does. The transition fires when its **Exit State** and **Enter State** nodes are both true. An unconnected one counts as true. **Back To State Machine** returns to the State Machine with the transition selected. |
| Flip Direction | Swaps the source and target of a One Way transition. |

Variables can be Bool, Int, Float, String, Vector3, Rotator, Tag or Tag Container. Rule and state graphs read them with Get Variable nodes. A Vector3 suits a point a bone aims at or reaches for, a Rotator a turn for [Transform Bone](../scripting/animation/transform-bone.md).

## Sync Groups

Give looping players the same **Sync Group** name, in the state's or the player's **Inspector**, to keep them in step: a Sequence Player, a Sprite Animation Player or a Blend Space Player. Every member plays at the group's point of its cycle, and the most heavily weighted member sets the pace, so a 1 s walk and a 0.5 s run stay in step. A state entered with a blend picks up the group's point instead of starting over, so Walk → Run keeps the stride. Players that do not loop ignore their group.

## Layers and cached poses

A 3D state graph can play different clips on different parts of the body, reuse a pose, and adjust single bones:

- [Layered Blend Per Bone](../scripting/animation/layered-blend-per-bone.md) plays each Blend Pose on the bones of its branches only, such as an attack on the spine and arms over a run on the legs. Pick each branch's bone in the **Inspector**.
- A pose output connects to one input. To use a pose in more than one place, or in more than one state, save it with [Save Cached Pose](../scripting/animation/save-cached-pose.md) and read it with [Use Cached Pose](../scripting/animation/use-cached-pose.md) nodes. A cached pose plays once a frame however many nodes use it, and keeps its time as the State Machine moves between states that use it.
- [Apply Additive](../scripting/animation/apply-additive.md) adds an [additive Animation](animation.md#additive-animations), such as a lean or a flinch, on top of any pose.
- [Transform Bone](../scripting/animation/transform-bone.md) changes one bone after the clips blend, such as tilting the head.

## Look At and IK

Skeletal controls aim and place bones after the clips blend, toward points the game gives:

- [Look At](../scripting/animation/look-at.md) turns a bone, such as the head, toward a target, within an angle limit.
- [Two Bone IK](../scripting/animation/two-bone-ik.md) puts a hand or foot on a point by bending its arm or leg, such as a hand on a door handle.
- [Foot Placement](../scripting/animation/foot-placement.md) plants the feet on uneven ground, such as stairs and slopes, lowering the pelvis for the lower foot.

Give each target a Vector3 variable and set it from a script with [Set Anim Graph Variable](../scripting/class/set-anim-graph-variable.md), such as the location of the actor to look at, in **World Space**. Chain the controls one after another: each takes the pose the one before it made.

[Spring Bones](../scripting/animation/spring-bones.md) make tails, hair, ears and capes trail the pose: the bones below its Root Bone follow the animation through springs, with gravity, wind and colliders, and swing as the actor moves and turns. They are only for looks.

## Slots

Play one-shots such as attacks, hurt flashes or emotes from scripts without adding states for them. Put a [Slot](../scripting/animation/slot.md) node (2D: [Frame Slot](../scripting/animation/frame-slot.md)) in a state graph, over the pose it shows otherwise, and give it a **Slot Name**. A script's [Play Slot Animation](../scripting/class/play-slot-animation.md) plays an Animation there, blending it in and out; [Stop Slot Animation](../scripting/class/stop-slot-animation.md) ends it early and [Is Slot Active](../scripting/class/is-slot-active.md) tells whether it is playing.

A slot's Animation plays for the whole graph, whichever state is active, and every state with a Slot of its name shows it. Under a [Layered Blend Per Bone](../scripting/animation/layered-blend-per-bone.md) Blend Pose, it plays on the upper body only.

## Animation events

[Animations](animation.md#animation-events) and [Sprite Animation frames](sprite-animation.md#animation-events) carry named Animation Events, and states can name their own (**Enter Event**, **Exit Event**, **Fully Blended Event**). The graph fires an event when a clip it plays passes the event's time: once each time the clip passes it, including when a looping clip wraps round. A window fires its begin and its end; its end also fires when the clip stops playing first, so the two always pair.

Each event runs the Animation Object's [Animation Event](../scripting/animation/animation-event.md) node of the same name, and only the graph that fired it runs it. An event's **Action** (Play Sound, Spawn Particle System) runs first, with no script needed.

- The **Preview** flashes each event's name as it fires (a window's with Begin and End), so you can check timing without a Simulation. Event actions are not played in the Preview.
- A clip fires only while it plays at or above the event's **Trigger Weight**, so a clip fading out of a blend does not repeat a footstep.
- A [Blend Space](blend-space.md) fires the events of its heaviest sample by default; its **Event Mode** can fire every sample's instead, or none. A [Sprite Blend Space](sprite-blend-space.md) fires the events of the sample playing.
- In one update, events fire in the order they happened: the state being left (its clips' events, then its Exit Event), then the state entered (its Enter Event, then its clips' events), then its Fully Blended Event.

## Watch the graph run

Start a Simulation with the graph open and pick an actor in **Debug Instance**. On the State Machine's canvas the states it plays light up, and a transition lights up when it is taken. The **Animation Object** window lights up the nodes that run, like a Class. See [Watch a graph run](../debugging/index.md#watch-a-graph-run).

To stop the game when the graph enters a state, choose **Add Breakpoint** from the state's menu. To stop it when a transition is taken, select the transition or its state and choose **Add Breakpoint** in the **Inspector**; a Both Ways transition also has **Add Reverse Breakpoint**. **Edit Breakpoint…** makes one stop only on a given hit. See [Breakpoints](../debugging/index.md#breakpoints).

## Notes

- Add an [Animation Graph component](../components/animation-graph.md) to an actor to run the graph.
- Change variables and states from scripts with [Set Anim Graph Variable](../scripting/class/set-anim-graph-variable.md) and [Jump To State](../scripting/class/jump-to-state.md), and read the active state with [Get Current State](../scripting/class/get-current-state.md).
- An Animation with [Root Motion](animation.md#root-motion) moves the actor while the graph plays it, by its weight in the pose.
- A 3D graph blends its clips bone by bone, by weight. Where the weights add up to less than full, the rest pose takes the remainder, so blending a clip toward [Rest Pose](../scripting/animation/rest-pose.md) fades it out smoothly. Bones that no playing clip moves stay in their rest pose.
- A graph has exactly one State Machine, so it cannot run a second set of states, such as upper-body gestures, beside another. Layer clips within a state with [Layered Blend Per Bone](../scripting/animation/layered-blend-per-bone.md) instead.

## Related

- [Sprites](../2d/sprites.md)
- [Models](../graphics/models.md)
- [Animation Graph nodes](../scripting/animation/index.md)
- [Get Current State](../scripting/class/get-current-state.md)
