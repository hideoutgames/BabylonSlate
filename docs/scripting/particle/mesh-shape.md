---
node: shape.mesh
---

# Mesh Shape

Spawns particles on the surface of a mesh and launches them along the surface or between two directions.

## Inputs

| Pin | Type | Default | Description |
| --- | --- | --- | --- |
| Particle | Particle |  |  |
| Direction 1 | Vector 3 | (0, 1, 0) | One end of the range the launch direction is picked from, when **Use Mesh Normals** is off. |
| Direction 2 | Vector 3 | (0, 1, 0) | The other end of that range. |

## Outputs

| Pin | Type |
| --- | --- |
| Particle | Particle |

## Settings

| Setting | Description |
| --- | --- |
| Source | **Owner Mesh** uses the first mesh of the actor that plays the effect. **Model** uses a Model asset. |
| Model | The Model to spawn on, when **Source** is **Model**. |
| Use Mesh Normals | Launches each particle along the surface normal where it spawns. Off, it launches between **Direction 1** and **Direction 2**. |
| Use Mesh Color | Gives each particle the mesh's vertex colour where it spawns, for meshes that have vertex colours. |

## Notes

- Each particle spawns at a random point on a random triangle of the mesh.
- **Owner Mesh** is the first mesh on the actor that has vertices, in the actor's pose when it is found. Collider outlines and other debug helpers are skipped. An animated character gives its rest pose, not its animated one. The Particle Emitter and Particle System previews have no actor, so they show a sphere 1 m across.
- **Model** uses every mesh in the Model, placed at the emitter as if the Model were its child.
- Until the mesh is available, particles spawn at the emitter. If the Model cannot load, or the actor has no mesh, the **Output Log** shows a warning.
- With **Use Mesh Color**, the particle's colour comes from the mesh instead of Create Particle's **Color**. [Initial Color](initial-color.md) reads it.
