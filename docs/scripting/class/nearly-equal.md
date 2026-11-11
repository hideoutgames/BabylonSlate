---
node: math.compare
---

# Nearly Equal

Returns true when two numbers are almost the same.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| A | Float |  |
| B | Float |  |
| Tolerance | Float | Defaults to 0.0001. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Boolean |

## Notes

- **A** and **B** must differ by no more than **Tolerance**.
- Use it instead of [**Equal**](equal.md) when comparing calculated values.
