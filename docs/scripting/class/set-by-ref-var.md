---
node: variables.setByRef
---

# Set By-Ref Var

Writes **Value** into the variable connected to **Target**.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Target | Wildcard | A writable variable, such as a function's Pass-By-Reference input. |
| Value | Wildcard |  |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Out | Exec |  |
| Value | Wildcard | The value that was written. |

## Notes

- **Target** is a [reference pin](../pin-types.md#reference-pins). Connected to a function's [Pass-By-Reference](../functions.md#pass-by-reference) input, it changes the caller's variable.
- **Target** and **Value** take the type of the first wire you connect.
- For a variable of this class, [Set Variable](set-variable.md) does the same.
