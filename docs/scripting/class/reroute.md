---
node: flow.reroute
---

# Reroute

Passes one wire through a point you can move, to tidy the graph.

## Inputs

| Pin | Type |
| --- | --- |
| In | Wildcard |

## Outputs

| Pin | Type |
| --- | --- |
| Out | Wildcard |

## Notes

- Double-click a wire, or double-tap it on a touch screen, to add a Reroute at that point. It splits the wire in two.
- A Reroute carries one type at a time: execution or a value, whichever you connect first. Its pins take that type's colour.
- An execution Reroute can merge several wires into its In. A value Reroute can feed several inputs from its Out.
- Reroutes are removed when the graph compiles, so they cost nothing when the game runs. The debugger never stops on one, and a run lights every part of the wire.
- **Format** adds Reroutes so long or blocked value and execution wires run level, around other nodes, and moves a chain of Reroutes that carries one wire into one input to that wire's new route ([Format](../index.md#format)).
- Reroutes also work in Scene scripts and in Animation Graph rule and state graphs. Particle Graphs have their own [Reroute](../particle/reroute.md).
