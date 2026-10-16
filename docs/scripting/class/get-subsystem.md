---
node: subsystem.get
---

# Get Subsystem

Returns the running subsystem of a chosen class, or null if none is alive.

## Outputs

| Pin | Type |
| --- | --- |
| Subsystem | Subsystem Reference |

## Notes

- Each subsystem class in the project has its own Get node, such as Get InventorySubsystem.
- A Game Subsystem lives for the whole session; a Scene Subsystem exists only while the main Scene does.
- Not available in Editor Utility graphs.
