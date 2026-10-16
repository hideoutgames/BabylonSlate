# Float To Int

Converts a Float to an Integer by dropping the fractional part.

## Inputs

| Pin | Type |
| --- | --- |
| In | Float |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Integer |

## Notes

- Rounds toward zero, so 2.9 becomes 2 and -2.9 becomes -2.
- Values that are not finite numbers, such as infinity, give 0.
