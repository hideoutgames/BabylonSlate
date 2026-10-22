---
node: debug.assert
---

# Assert

Reports an error for this node when a condition is false. Use it to state what must be true at a point in a graph, so a broken assumption shows up where it happens.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Condition | Boolean | What must be true. When it is false, the node reports an error. |
| Message | String | Added to the report. Leave empty for a plain "Assertion failed". |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Settings

| Setting | Description |
| --- | --- |
| Development Only | On by default. Turn it off to keep the node in exported games. |

## Notes

- A failed Assert writes `Assertion failed: Message` to the **Output Log** as an error and adds it to the **Preview Session Report**, where selecting it opens the graph at this node. Each failure is reported, and the report counts repeats.
- The graph carries on after a failure: execution always continues from **Out**.
- Skipped in exported games unless you turn off **Development Only** in the **Inspector**.
