# Delay

Waits for a number of seconds, then continues.

## Inputs

| Pin | Type |
| --- | --- |
| In | Exec |
| Duration | Float |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- Duration counts game time, so pausing the game or slowing time stretches the wait.
- If the owner is destroyed during the wait, the nodes after it do not run.
- A Duration of 0 or less continues on the next simulation tick.
- Latent: the node finishes later without pausing the rest of the game.
