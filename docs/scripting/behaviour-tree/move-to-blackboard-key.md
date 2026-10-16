# Move To Blackboard Key

Moves the actor to the position stored in a Blackboard key.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| Blackboard Key |  | The key that holds the target. The list shows only Vector 2, Vector 3, Object Reference and Actor Reference keys. |
| Accept Radius | 0.5 | How close to the target, in metres, the actor must get to count as arrived. The default is 0.5. |

## Notes

- The key can hold a Vector 2, Vector 3, Object Reference or Actor Reference.
- The key is read on every update, so the route follows a moving target, and the task fails if the key is empty or the target is gone.
- It needs a baked NavMesh and a **Nav Agent** component, like [**Move To**](move-to.md).
