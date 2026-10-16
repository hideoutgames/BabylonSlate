# Rotate To Face

Turns the actor to face a world position.

## Settings

| Setting | Description |
| --- | --- |
| Target | The world position to face. |

## Notes

- Only the heading changes: rotation around Y in 3D scenes and around Z in 2D scenes.
- The turn happens at once and the task succeeds immediately. It fails if **Target** is not a valid position.
