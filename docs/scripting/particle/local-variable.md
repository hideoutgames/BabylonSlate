---
node: utility.localVariable
---

# Local Variable

Keeps the first value it reads and returns it again, so a random or computed value is read once and reused.

## Inputs

| Pin | Type | Default |
| --- | --- | --- |
| Value | Any | 0 |

## Outputs

| Pin | Type |
| --- | --- |
| Value | Any |

## Settings

| Setting | Description |
| --- | --- |
| Scope | **Particle** (default): each particle keeps the value from its first read for its whole life, so an Update node reads the same value every frame. **Loop**: one value per frame, shared by every particle. |

## Notes

- **Value** can be a Float, Vector2, Vector3 or Color, and **Value** out has the same type.
- Wire a [Random](random.md) with **Every Read** into it to give each particle a fixed random value in Update nodes.
- Read where there is no particle, such as **Emit Rate**, **Particle** scope behaves like **Loop**.
