---
node: const.float
---

# Float

Returns a fixed number that you set in the **Inspector**.

## Outputs

| Pin | Type |
| --- | --- |
| Out | Float |

## Settings

| Setting | Description |
| --- | --- |
| Value | The number to return. |

## Notes

- Wire one Float into several inputs to change them together.
- In **Add Node**, you can also search for **V1**, **Vec1**, **Vector 1** or **Scalar**.
- Wired into a Vector input, the Float fills every channel: a Float of 10 becomes (10, 10, 10).
- Right-click the node, or long-press it, and choose **Convert to Parameter** to expose the value to Material Instances and scripts. The node becomes the parameter of its type holding this value; its wires stay.
