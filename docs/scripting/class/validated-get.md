---
node: variables.getValidated
---

# Validated Get

Reads an object variable and runs **Is Valid** only if it holds an object.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| In | Exec |  |
| Target | Object Reference | Object that owns the variable. Shown only for variables that belong to another object. |

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Is Valid | Exec |  |
| Not Valid | Exec |  |
| Value | Float | The object held by the variable. Use it after **Is Valid**. |

## Notes

- **Not Valid** runs when the variable is empty, or when **Target** is connected to an empty reference, which also logs an error. It does not check whether the object has since been destroyed.
- Works with single Object and Actor reference variables. For arrays, maps, classes and assets, use [**Get Variable**](get-variable.md).
