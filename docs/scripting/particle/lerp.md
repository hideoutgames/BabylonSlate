# Lerp

Blends from one value to another by an amount between 0 and 1.

## Inputs

| Pin | Type | Default |
| --- | --- | --- |
| A | Any | 0 |
| B | Any | 1 |
| Alpha | Float | 0 |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Any |

## Notes

- An **Alpha** of 0 returns **A**, 1 returns **B**, and values in between blend in a straight line.
- **A** and **B** can be a Float, Vector 2, Vector 3 or Color, while **Alpha** is always a Float.
