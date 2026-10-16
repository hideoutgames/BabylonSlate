# Substring

Returns part of a string, from a start position up to an end position.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | String |  |
| Start | Integer | Position of the first character to keep, counting from 0. |
| End | Integer | Position after the last character to keep. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | String |

## Notes

- Positions count from 0, and the character at **End** is not included.
- **Start** and **End** are limited to the length of the string. The result is empty when **End** is not after **Start**.
