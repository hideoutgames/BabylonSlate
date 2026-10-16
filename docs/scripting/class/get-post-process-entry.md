# Get Post Process Entry

Returns the Material Object of one post-process pass on a Scene or Scene Layer.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Owner | Object Reference | A Scene or Scene Layer reference. |
| Entry ID | String | The pass's Entry ID. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Material | MaterialObject Reference | The pass as a Material Object. Use it with the Material Parameter nodes. |

## Notes

- Returns none when the Entry ID is empty or unknown, or the owner is not ready.
- Copy the Entry ID from the pass's Entry ID button in the **Post Processing** list of Scene Details.
- Reordering passes keeps their Entry IDs, while removing or replacing a pass makes its Material Object invalid.
