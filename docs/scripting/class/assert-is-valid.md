---
node: debug.assertIsValid
---

# Assert Is Valid

Reports an error for this node when an object reference is empty. Use it where a graph needs an object to exist, such as an actor it looked up.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Object | Object Reference | The object that must exist. The check matches [Is Valid](is-valid.md). |
| Message | String | Added to the report. Leave empty to report only that the object is not valid. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Settings

| Setting | Description |
| --- | --- |
| Development Only | On by default. Turn it off to keep the node in exported games. |

## Notes

- A failure reads `Assertion failed: Message (the object is not valid)` in the **Output Log** and the **Preview Session Report**, where selecting it opens the graph at this node.
- The graph carries on after a failure: execution always continues from **Out**.
- Skipped in exported games unless you turn off **Development Only** in the **Inspector**.
