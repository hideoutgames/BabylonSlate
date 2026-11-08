---
node: object.getDisplayName
---

# Get Display Name

Returns an actor's or component's name, or the Class of any other object.

## Inputs

| Pin | Type |
| --- | --- |
| Object | Object Reference |

## Outputs

| Pin | Type |
| --- | --- |
| Name | String |

## Notes

- An actor shows its name from the **Outliner**, or the one it was spawned with; a component its name from the **Components** list.
- Other objects, and unnamed actors and components, show their Class.
- Returns an empty string for an empty or destroyed object.
