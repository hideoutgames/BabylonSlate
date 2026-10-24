# Sky and Fog

A Skybox surrounds the scene with a cubemap sky, distance fog fades far objects into a colour, and volumetric fog adds light scattering and local fog banks.

## Background colour

Every scene has an **Environment** colour in **Scene Settings** (in the **Inspector** with nothing selected). It fills the background wherever no Skybox or geometry covers it. New 3D scenes use a horizon blue, so deleting the Skybox does not leave a black screen.

## Skybox

New 3D scenes include a locked **Skybox** actor that shows the engine's default sky. To add another, open **Place Actors > Environment > Skybox**, or add a **Skybox** component with **Add Component > Rendering**.

| Setting | Default | Description |
| --- | --- | --- |
| **Size** | 1000 | Edge length of the sky cube, 1 to 10,000. |
| **Positive X** … **Negative Z** | Engine Default | One Texture per cube face. An empty face uses the default sky's face. |

- The Skybox follows its actor's position, rotation and scale. Rotate the actor to turn the sky.
- It always draws behind the scene, even beyond the camera's **Far Clip**.
- It cannot be picked in the viewport; select it in the **Outliner**. The default Skybox is locked, so unlock it there before you edit it.
- It does not receive fog or cast shadows. With the scene's **Environment Source** set to **Skybox**, the default in new 3D scenes, it also lights and reflects in surfaces. See [environment lighting](lighting.md#environment-lighting).

See [Skybox](../components/skybox.md) for the full component reference.

## Make skybox faces with Skybox Creator

A [Skybox Creator](../assets/skybox-creator.md) cuts one cross-layout image into six face Textures.

1. In the **Content Browser**, create a **Skybox Creator** (it is in the **Rendering** group of the **New Asset** menu) and open it.
2. Choose **Pick Texture** and pick a Texture laid out as a 4×3 cube cross.
3. Drag the Texture to line up the **Up**, **Left**, **Front**, **Right**, **Back** and **Down** cells.
4. Choose **Create Skybox Textures**. The status shows how many of the 6 faces were created.
5. Assign the new Textures to the Skybox's face slots.

Skybox Creator does not convert panoramic (equirectangular) images.

## Distance fog

Distance fog is set per scene in **Scene Settings**.

| Setting | Default | Description |
| --- | --- | --- |
| **Fog** | Off | Turns distance fog on. |
| **Fog Mode** | Linear | **Linear** fades between Start and End. **Exponential** and **Exponential Squared** use Density; Exponential Squared builds more gradually nearby. |
| **Fog Color** | Grey | The colour far objects fade to. |
| **Fog Start**, **Fog End** | 0, 100 | Linear only. Distances from the camera, in scene units. |
| **Fog Density** | 0.01 | Exponential modes only. Higher values hide nearby objects. 0 shows no fog. |

Scene Layers (2D overlays) are never fogged.

## Volumetric fog

Volumetric fog is lit by directional, point and spot lights, so light shafts show through it. Its controls are in **Project Settings > Rendering > Post Processing > Volumetric Fog** and apply to both scene-wide fog and Fog Volumes.

| Setting | Default | Description |
| --- | --- | --- |
| **Scene-Wide Fog** | Off | Fills the whole scene with lit fog. |
| **Scene-Wide Fog Density** | 0.02 | Fog thickness per scene unit. |
| **Volumetric Intensity** | 1 | Brightness of scattered light. 0 removes beams but keeps the darkening. |
| **Volumetric Distance** | 50 | How far from the camera fog is sampled, in scene units. |
| **Scattering Anisotropy** | 0.2 | Positive values strengthen beams when looking toward a light. |
| **Volumetric Resolution Scale** | 0.5 | Lower values cost less and look softer. |
| **Volumetric Steps** | 24 | More steps reduce banding, at a higher cost. |
| **Volumetric Light Limit** | 4 | Lights that contribute, 1 to 4. Fill and area lights never contribute. |

- Light colours tint the fog. Turn on **Cast Shadows** on a light for beams that are blocked by objects.
- Scene-wide fog runs only where the Post Processing quality allows it: **Allow Volumetric Lighting** is on at High and Ultra. Fog Volumes always render.
- Distance fog and volumetric fog can be on together.

## Fog Volumes

A [Fog Volume](../components/fog-volume.md) adds fog inside a box or sphere, independently of Scene-Wide Fog. Add one with **Place Actors > Environment > Fog Volume**.

| Setting | Default | Description |
| --- | --- | --- |
| **Shape** | Box | **Box** or **Sphere**. |
| **Size** | 10, 10, 10 | Full size along local X, Y and Z. Actor scale also applies. |
| **Density** | 0.1 | Fog added inside the volume. Overlapping volumes add together. |
| **Edge Falloff** | 0.2 | Soft edge as a fraction of the half-size. 0 is a hard edge; 1 fades from the centre. |

Up to eight nearby visible Fog Volumes contribute at once.

## From scripts

[Set Post Processing Quality](../scripting/class/set-post-processing-quality.md) changes whether scene-wide volumetric fog may run in the current session.
