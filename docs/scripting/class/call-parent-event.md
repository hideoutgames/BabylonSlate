# Call Parent Event

Runs the parent class's version of an event that this graph overrides.

## Inputs

| Pin | Type |
| --- | --- |
| In | Exec |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Exec |

## Notes

- The editor adds it when you override an inherited event, wired between the event and your own logic.
- For built-in events, the running event's values are passed on unless you connect an input to replace one. Custom events receive exactly the values you connect.
