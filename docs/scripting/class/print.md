# Print

Shows any value as on-screen text while the game runs.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Value | Any | Any value to show. Left unconnected, it shows an empty line. |
| Key | String | Messages with the same key replace each other in place. Leave empty to add a new line each time. |
| Duration | Float | Seconds the text stays on screen. Defaults to 2; 0 or less shows it for one frame. |
| Color | Color | Text colour. Defaults to white, and a colour with zero alpha is shown fully opaque. |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Settings

| Setting | Description |
| --- | --- |
| Development Only | On by default. Turn it off to keep the node in exported games. |

## Notes

- Haptic converts the value to text, so numbers, vectors, arrays and structures can be connected directly.
- Skipped in exported games unless you turn off **Development Only** in the **Inspector**.
