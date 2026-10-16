# Water Surface

Returns water data for the current point: wave height, bank distance, depth, time and flow.

## Outputs

| Pin | Type | Description |
| --- | --- | --- |
| Wave Height | Float | Vertical wave displacement in metres. |
| Bank Distance | Float | Distance from the nearest bank in metres; 0 at the shore. |
| Water Depth | Float | Depth of the water body in metres. |
| Simulation Time | Float | Time in seconds that drives the waves. |
| Local Flow | Vector 3 | World-space direction and speed of the water current. |

## Notes

- Only has data on water bodies that use this material as their Custom Material. On any other mesh every output is 0.
- With a [**Water Waves**](water-waves.md) node in the graph, Wave Height and Simulation Time follow that node.
- Only in Surface and Landscape materials.
