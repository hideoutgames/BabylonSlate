# Condition

Returns one of two values depending on how two numbers compare.

## Inputs

| Pin | Type | Default |
| --- | --- | --- |
| A | Float | 0 |
| B | Float | 0 |
| When True | Any | 1 |
| When False | Any | 0 |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Any |

## Settings

| Setting | Description |
| --- | --- |
| Test | How **A** is compared with **B**: Equal, Not Equal, Less Than, Greater Than, Less Or Equal, Greater Or Equal, And, Or or Xor. The default is Less Than. |
| Epsilon | A tolerance for the comparison. Equal and Not Equal treat values within it as equal, and the ordered tests also pass when **A** is within it of **B**. |

## Notes

- **A** and **B** are Floats, while **When True** and **When False** can be a Float, Vector 2, Vector 3 or Color.
- And, Or and Xor treat any non-zero value as true.
