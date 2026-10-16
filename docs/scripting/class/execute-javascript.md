# Execute JavaScript

Runs your own JavaScript function body inline, with custom input and output pins.

## Inputs

| Pin | Type |
| --- | --- |
| In | Exec |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Settings

| Setting | Description |
| --- | --- |
| Inputs | Pins the body can read. Each name is a case-sensitive variable. |
| Outputs | Pins the body can set. Each name is a variable that you assign. |
| JavaScript Function Body | The code that runs each time the node executes. |

## Notes

- Add input and output pins in the **Inspector**; each pin name becomes a variable in the body.
- Names must be valid JavaScript identifiers, not reserved words, and unique across inputs and outputs, or the node fails when it runs.
- Outputs start at their type default and keep whatever the body assigns. Syntax errors appear in **Compiler Results**.
