---
node: variables.get
---

# Get Variable

Returns the current value of a variable.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Target | Object Reference | Object that owns the variable. Shown only for variables that belong to another object. |

## Outputs

| Pin | Type |
| --- | --- |
| Value | Float |

## Notes

- **Add Node** lists a Get entry for each variable on this class, its parents and other classes, plus the local variables of the open function.
- The Value pin takes the variable's name and type.
- A variable of another class needs its **Target** connected. When it is connected to an empty reference the node returns the type's default value and logs an error. A Get of a writable variable can also feed the **Target** pin of a Tween node.
