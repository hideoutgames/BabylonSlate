---
node: enum.select
---

# Select

Returns the value wired to the option that matches an enum member.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Index | Enum | The enum value that picks which option is returned. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Wildcard |

## Settings

| Setting | Description |
| --- | --- |
| Enum Type | The enum whose members become the option inputs. Connecting an enum pin sets it automatically. |

## Notes

- The node has one option input for each member of the chosen Enum Type.
- If **Index** matches no member, the first member's option is used.
- The type of **Out** follows the values you connect to the options.
