---
node: utility.reroute
---

# Reroute

A knot that tidies a wire. It passes on whatever is wired into it, so the graph behaves exactly as if the wire ran straight.

## Inputs

| Pin | Type |
| --- | --- |
| In | Any |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Any |

## Notes

- Double-click a wire, or double-tap it, to split it with a knot where you clicked. You can also add one from **Add Node**: search for **Reroute** or **knot**.
- A knot takes the type of what is wired to it, on both pins: a Float, Vector2, Vector3, Color or the **Particle** chain. Until something is wired it accepts any pin; after that it accepts only pins that type can connect to.
- **Out** can feed several inputs. A **Particle** output still feeds only one node, so a second **Particle** wire out of a knot is an error.
- Knots are removed when the graph builds, so they cost nothing while the emitter runs and never change what the emitter does. A knot with nothing wired into it leaves the inputs it feeds at their defaults.
