# Scene Streaming

Scene Streaming loads another Scene into the running game at a point you choose, and unloads it again, without leaving the current scene. Use it to split a large level into parts, or to load a room only when the player needs it.

To replace the whole world instead, use [Change Scene](../scripting/class/change-scene.md).

## Place a streaming point

1. Open the parent scene and tap **+** in the **Outliner**.
2. In **Place Actors**, choose **Environment > Scene Streaming**.
3. In the **Inspector**, set **Target Scene** to the Scene to stream in.
4. Move, rotate and scale the actor. Its transform is where the streamed scene's origin lands.

The viewport shows only the actor's icon and the target scene's name. The streamed scene's actors appear only in Play.

## Load and unload from scripts

Nothing loads by itself. Call these nodes with the Scene Streaming actor as **Target**:

| Node | What it does |
| --- | --- |
| [Load Scene Async](../scripting/class/load-scene-async.md) | Starts loading while the game keeps running. |
| [Load Scene Blocking](../scripting/class/load-scene-blocking.md) | Pauses the game until the scene is ready, then continues. |
| [Unload Scene Async](../scripting/class/unload-scene-async.md) | Starts removing the streamed scene while the game keeps running. |
| [Unload Scene Blocking](../scripting/class/unload-scene-blocking.md) | Pauses the game until the streamed scene is removed. |

To check on a load, use [Is Scene Loaded](../scripting/class/is-scene-loaded.md), [Get Scene State](../scripting/class/get-scene-state.md) (Unloaded, Loading, Loaded or Unloading), [Get Scene Load Progress](../scripting/class/get-scene-load-progress.md) (0 to 1) and [Get Target Scene Name](../scripting/class/get-target-scene-name.md). A Scene Subsystem receives [Event On Streamed Scene Loaded](../scripting/class/event-on-streamed-scene-loaded.md) and [Event On Streamed Scene Unloaded](../scripting/class/event-on-streamed-scene-unloaded.md).

To get the **Target**, find the actor with [Get Actor Of Class](../scripting/class/get-actor-of-class.md), or make a Class whose parent is **Scene Streaming Actor**, place that instead, and use [Get Self](../scripting/class/get-self.md) in its graph.

## What a streamed scene brings

- Its actors, placed relative to the streaming actor. Each Scene Streaming actor holds one copy, so several actors can stream the same scene in different places.
- Actors that its scripts spawn. They are removed when it unloads.
- Not its settings. The parent scene keeps its own environment, gravity, camera, post-processing and navigation mesh, and the streamed scene's [Scene Layers](scene-layers.md) are not created.

Unloading removes only that actor's copy, including anything it streamed in itself.

## Things to know

- The streamed scene must use the same **Physics World** (3D or 2D) as the parent. Otherwise the load fails with an error in the **Output Log**.
- A scene cannot stream itself, directly or through another streamed scene.
- Scene Streaming works in world scenes only, not in Scene Layers.
- If a blocking load fails, the graph stops at the node and **Then** does not run. An async load logs the error and continues.

## Related

- [Scene Streaming](../components/scene-streaming.md)
- [Scenes](index.md)
