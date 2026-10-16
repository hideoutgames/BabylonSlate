# Save Game

Chooses which parts of an actor a Save Game checkpoint stores and restores.

## Add it

Select an actor, then choose **Add Component > General > Save Game**.

## Settings

| Setting | Description |
| --- | --- |
| Save Transform | Saves and restores the actor's position, rotation and scale. Default on. |
| Persist Destruction | Keeps the actor destroyed when a later checkpoint loads. Default on. |
| Save (variable) | One checkbox for each script variable on the actor's Class, including inherited variables. Default off. |
| Save (component) (variable) | One checkbox for each script variable on the actor's other components. Default off. |

## Notes

- World scenes only.
- Nothing is saved until a script saves the game. Each save records the selection as it is at that moment.
- Actors you spawn in a script are saved only after you register them with [Register Save Actor](../scripting/class/register-save-actor.md).
- Actors in streamed scenes and in Scene Layers are not saved. Store progress that spans scenes in the [Save Game](../assets/save-game.md) asset's fields.
- A save can only be loaded into the scene it was made in.

## Related

- [Save games](../scripting/save-games.md)
- [Save Game](../scripting/class/save-game.md)
- [Load Game](../scripting/class/load-game.md)
