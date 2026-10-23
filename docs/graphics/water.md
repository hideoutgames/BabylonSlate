# Water

Water bodies draw animated water surfaces with waves, foam, reflections and refraction. The same waves drive floating objects and script queries, so what you see is what physics uses.

## Create water

1. In the **Content Browser**, create a [Water](../assets/water.md) asset. Choose a **Water Style**: **Realistic**, or **Stylized** with a **Painted** or **Toon** look.
2. Open it to tune colours, waves, foam and reflections in **Preview** and the **Inspector**.
3. Drag the asset from **Place Actors** into a 3D scene to create a lake, or add a water component and pick the asset in its **Water** field.

Water components without an asset use the Realistic defaults.

## Water bodies

Add these from **Place Actors > Water**, or with **Add Component > Water**.

| Component | Shape |
| --- | --- |
| [Water Ocean](../components/water-ocean.md) | A large rectangle with broad waves. |
| [Water Lake](../components/water-lake.md) | A bounded oval with gentle waves. |
| [Water River](../components/water-river.md) | A path with a flowing current. |
| [Water Puddle](../components/water-puddle.md) | A shallow oval with small ripples. |
| [Global Water Volume](../components/global-water-volume.md) | Water to the horizon, with detail that follows the camera. |
| [Water Removal Volume](../components/water-removal-volume.md) | Removes water inside a box, sphere, cylinder or capsule, such as inside a boat hull. |

Common settings:

| Setting | Description |
| --- | --- |
| **Width**, **Length** | Size in metres. Not used by Global Water Volume; rivers use Width only. |
| **Depth** | Water depth below the surface. |
| **Wave Scale** | Multiplies the asset's waves, 0 to 10. |
| **Flow Speed**, **Flow Direction** | The current. Rivers flow along their path. |
| **Surface Resolution** | Mesh detail, 8 to 128. Multiplied by the project's **Water Mesh Density**. |

Select a water actor to edit its shape in the viewport. Ocean, Lake and Puddle show red Width, blue Length and green Depth handles. Rivers show a handle per point, orange width handles and midpoint handles: drag a midpoint to add a point, and double-click a point to remove it. Each river point also has a **Width Scale**.

Waves, foam and currents are measured in world metres, so scaling a water body does not stretch its pattern.

## Water Blend Distance

Water bodies closer than **Project Settings > Rendering > Water > Water Blend Distance** merge into one surface, for example where a river meets a lake. This affects rendering and water queries. Set it to 0 to turn blending off.

## Floating objects

Add [Water Buoyancy](../components/water-buoyancy.md) to a 3D actor to make it float. It also works as the actor's physics body if the actor has no Rigid Body.

| Setting | Description |
| --- | --- |
| **Volume** | Floating volume in cubic metres. 0 is automatic. In default water, 0.002 floats 1 kg halfway submerged. |
| **Width**, **Length**, **Height**, **Offset** | Size and position of the floating volume. |
| **Drag**, **Angular Drag** | How strongly the water slows and steadies the object. |

The Water asset's **Density** (about 1000 kg/m³ for fresh water) sets how much it can carry. Objects rock with the waves; only the current carries them along.

## Water quality

Rendering cost follows the **Water** group in **Project Settings > Rendering > Scalability**. These settings change only how water looks; buoyancy and queries are the same on every level and device.

| Setting | Low | Medium | High | Ultra |
| --- | --- | --- | --- | --- |
| **Water Shading Detail** | Low | Medium | High | Ultra |
| **Water Mesh Density** | 0.5 | 0.75 | 1 | 1.5 |
| **Contact Resolution** | 256 | 256 | 1024 | 1024 |
| **Water Refraction** | Off | On | On | On |
| **Water Reflections** | Sky Only | Sky Only | Screen Space | Planar |
| **FFT Ocean Detail** | Off | Off | On | On |

- **Contact Resolution** sets the detail of the foam and rings where objects meet the water. The work of keeping them current is capped per frame and goes to the water nearest the camera first, so around many moving objects foam can trail them by a fraction of a second. Higher values cost more per update and trail longer.
- **Refraction Resolution** sets the scene copy's scale, shared with Screen Space reflections.
- **Water Reflections**: **Sky Only** reflects the environment, **Screen Space** also reflects visible objects, and **Planar** mirrors flat water and uses Screen Space elsewhere. **Reflection Steps** and **Planar Resolution** tune them.
- Realistic and Painted water simulate their waves on every level: **FFT Size** and **FFT Cascades** set how much short-wave detail they draw. On Toon and Custom Material water they add fine wave detail when **FFT Ocean Detail** is on.
- Floating objects and queries on Realistic and Painted water follow the larger waves; the shortest rendered ripples are visual only.

A Water asset reflects scene objects only when its **Object Reflections** is on.

## Custom water Materials

Set a Water asset's **Custom Material** to a Surface Material to replace the built-in shading. Waves and buoyancy still work. In the Material, [Water Surface](../scripting/material/water-surface.md) gives wave height, depth and flow, and [Water Waves](../scripting/material/water-waves.md) gives the wave offset and normal for World Position Offset and Normal.

## From scripts

- [Sample Water Surface](../scripting/class/sample-water-surface.md) returns the water height and velocity at a world position.
- [Set Water Quality](../scripting/class/set-water-quality.md) changes water quality for the session.
