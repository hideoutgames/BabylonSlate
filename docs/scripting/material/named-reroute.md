---
node: reroute.declaration
---

# Named Reroute

Gives the value wired into it a name, so **Named Reroute Usage** nodes elsewhere in the graph can read it without a long wire.

## Inputs

| Pin | Type |
| --- | --- |
| In | Any |

## Settings

| Setting | Description |
| --- | --- |
| Name | The name Add Node lists the reroute's usages under. A taken name gets **_1**, **_2** and so on. |
| Color | The header colour of this node and of every usage of it. |

## Notes

- Create one with **Create Named Reroute…** in **Add Node**. The new node starts with a free name and opens its title for renaming; double-click the node, or choose **Rename** in its menu, to rename it later.
- **In** takes any value, Texture included, and passes it on unchanged.
- Each name has one Named Reroute and any number of usages. Renaming it renames every usage.
- A usage of this reroute that feeds back into its own **In**, directly or through other nodes and reroutes, is an error.
- See [Named Reroutes](../../assets/material.md#named-reroutes).
