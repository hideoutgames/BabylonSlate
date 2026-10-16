# Set Variable

Sets a variable to a new value and passes that value on.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Target | Object Reference | Object that owns the variable. Shown only for variables that belong to another object. |
| Value | Float |  |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Value | Float | The value that was written, so you can reuse it without reading the variable again. |

## Notes

- **Add Node** lists a Set entry for each writable variable. Read-only variables have none.
- The Value pins take the variable's name and type.
