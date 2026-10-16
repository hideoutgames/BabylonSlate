---
node: random.range
---

# Random

Returns a random value between a minimum and a maximum.

## Inputs

| Pin | Type | Default |
| --- | --- | --- |
| Min | Float | 0 |
| Max | Float | 1 |

## Outputs

| Pin | Type |
| --- | --- |
| Value | Float |

## Settings

| Setting | Description |
| --- | --- |
| Value Type | The type of **Min**, **Max** and **Value**: Float, Vector 2, Vector 3 or Color. The default is Float. |
| Lock Mode | Per Particle rolls once per particle: the value is fixed in Create Particle inputs and rolled again every frame in Update inputs. Every Read rolls a new value each time it is read. |

## Notes

- Each component of a vector or colour is rolled separately.
- **Lock Mode** controls when a new value is rolled.
