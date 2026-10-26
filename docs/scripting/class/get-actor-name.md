---
node: actor.getName
---

# Get Actor Name

Returns the name of an actor as text.

## Inputs

| Pin | Type |
| --- | --- |
| Target | Actor Reference |

## Outputs

| Pin | Type |
| --- | --- |
| Out | String |

## Notes

- Leave **Target** unconnected to use the actor running the graph; the pin shows **Self**.
- Returns an empty string, and logs an error, when the reference is empty.
