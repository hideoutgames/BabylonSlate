# Detach Actor

Removes an actor's parent so it no longer follows another actor.

## Inputs

| Pin | Type |
| --- | --- |
| In | Exec |
| Target | Actor Reference |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- The actor's location, rotation and scale values stay the same but now apply in world space, so it can jump.
- Any bone attachment is released as well.
