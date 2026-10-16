# Sequence

Runs its outputs one after another, from the first to the last.

## Inputs

| Pin | Type |
| --- | --- |
| In | Exec |

## Outputs

| Pin | Type |
| --- | --- |
| Then 0 | Exec |
| Then 1 | Exec |

## Notes

- Each output finishes before the next one starts, including any latent node such as [**Delay**](delay.md) on that path.
- Outputs are numbered from 0, so **Then 0** runs first.
