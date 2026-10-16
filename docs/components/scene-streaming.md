# Scene Streaming

Marks where another Scene loads into the running game, so you can stream parts of a level in and out.

## Add it

Choose **Place Actors > Environment > Scene Streaming**. It is not in the **Add Component** menu.

The new actor holds a Scene Streaming component and a 3D Text label that shows the target Scene's name. The label appears only in the editor.

## Settings

| Setting | Description |
| --- | --- |
| Target Scene | The Scene to stream. Pick a Scene asset. |
| Transform | Position, rotation and scale of the streamed Scene's origin, relative to the actor. |

## Notes

- World scenes only.
- Nothing loads by itself. Use [Load Scene Async](../scripting/class/load-scene-async.md) or [Load Scene Blocking](../scripting/class/load-scene-blocking.md) with the streaming actor as the target, and the matching unload nodes to remove it.
- The streamed Scene must use the same Physics World (3D or 2D) as the Scene that loads it.
- The editor never shows the streamed Scene's actors. They appear only in Play.
- Renaming the target Scene updates the label.

## Related

- [Scene streaming](../scenes/streaming.md)
- [Is Scene Loaded](../scripting/class/is-scene-loaded.md)
- [Get Scene State](../scripting/class/get-scene-state.md)
