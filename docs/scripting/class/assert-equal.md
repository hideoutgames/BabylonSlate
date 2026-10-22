---
node: debug.assertEqual
---

# Assert Equal

Reports an error for this node when two values differ, naming both values. Use it to check that a result is what you expect.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Actual | Wildcard | The value to check. Connecting it sets the type of both value pins. |
| Expected | Wildcard | The value it should equal. |
| Message | String | Added to the report. Leave empty to report only the values. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Settings

| Setting | Description |
| --- | --- |
| Development Only | On by default. Turn it off to keep the node in exported games. |

## Notes

- A failure reads `Assertion failed: Message (expected 2, got 3)` in the **Output Log** and the **Preview Session Report**, where selecting it opens the graph at this node.
- Numbers, text, booleans, enums and tags must match exactly. Vectors, rotators, colors, transforms and structures compare field by field, Arrays item by item and Maps entry by entry. Objects such as actors and components are equal only to themselves.
- The graph carries on after a failure: execution always continues from **Out**.
- Skipped in exported games unless you turn off **Development Only** in the **Inspector**.
