---
node: enum.switch
---

# Switch on Enum

Runs one execution path depending on which enum member a value holds.

## Inputs

| Pin | Type |
| --- | --- |
| In | Exec |
| Value | Enum |

## Outputs

| Pin | Type |
| --- | --- |
| Default | Exec |

## Settings

| Setting | Description |
| --- | --- |
| Enum Type | The enum the node works with. Connecting an enum pin sets it automatically. |

## Notes

- The node has one execution output for each member of the enum, plus **Default**.
- **Default** runs when the value matches no member that has something connected.
