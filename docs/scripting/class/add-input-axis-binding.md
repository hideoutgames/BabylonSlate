---
node: input.addAxisBinding
---

# Add Input Axis Binding

Adds a key binding to an Input Axis while the game runs.

## Inputs

| Pin | Type | Description |
| --- | --- | --- |
| Exec | Exec |  |
| Input Axis | InputType | The Input Axis asset to add the binding to. |
| Key | Key | The key, mouse button or gamepad control to bind. |
| Binding Options | InputBinding | Optional modifiers, X or Y component, dead zone, scale, sensitivity, inversion and digital value for the new binding. Dead zone must be at least 0 and below 1. The Input, Id, Label and Key fields are ignored. |

## Outputs

| Pin | Type |
| --- | --- |
| Then | Exec |
| Success | Boolean |

## Notes

- Changes apply to the running game as player overrides and do not edit the Input asset.
- **Success** is false when the Input Axis is not valid, **Key** is None, or **Binding Options** holds an invalid value.
