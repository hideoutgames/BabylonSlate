# Lighting

Lights, environment lighting and the light budget decide how lit surfaces look in the viewport, in Play and in exported games.

## Add a light

1. Open **Place Actors** and choose **Lights**.
2. Pick **Point Light**, **Directional Light**, **Spot Light** or **Hemispheric Fill**.

You can also select an actor and use **Add Component > Rendering** to add **Light**, **Rectangular Area Light** or **Hemispheric Fill Light**.

New 3D scenes already contain a warm **Directional Light** with **Cast Shadows** on, a Skybox and a Camera. A PBR scene with no lights and no environment lighting renders dark.

## Light types

| Type | Use it for | Notes |
| --- | --- | --- |
| [Light](../components/light.md), Point | Bulbs, torches | Lights in all directions up to **Range**. |
| [Light](../components/light.md), Spot | Lamps, headlights | A cone set by **Inner Angle** and **Outer Angle**, up to **Range**. |
| [Light](../components/light.md), Directional | The sun or moon | Parallel light from one direction. Position does not matter. |
| [Hemispheric Fill Light](../components/hemispheric-fill-light.md) | Soft sky and ground fill | **Color** from above, **Ground Color** from below. Never casts shadows. |
| [Rectangular Area Light](../components/area-rect-light.md) | Windows, screens, light panels | **Width** by **Height** emitter. Unshadowed, so it lights through walls. |

Spot, directional and area lights shine along the actor's forward (+Z) axis: rotate the actor to aim them. Scale does not change a light; use **Range** instead.

::: warning
Only one directional light lights a scene at a time: the first enabled one in the scene. Other directional lights stay off and show a red icon.
:::

## Light settings

| Setting | Description |
| --- | --- |
| **Enabled** | Turns the light on or off. |
| **Color**, **Intensity** | Light colour and brightness. New lights use white at intensity 1. |
| **Light Kind** | Point, Spot or Directional. |
| **Cast Shadows** | Off for new lights. See [Shadows](shadows.md). |
| **Shadow Priority** | Which lights keep their shadows when the shadow budget is full. |
| **Range** | Point and spot only. Default 10. |
| **Inner Angle**, **Outer Angle** | Spot only, in degrees. Defaults 30 and 45. |

For a textured **Rectangular Area Light**, open a Texture asset, choose **Prepare Emission**, then pick it in **Emission Texture**.

## Light icons

Light icons in the viewport show each light's state:

- **White**: working as configured.
- **Yellow**: limited. The light is over the device's light capacity, or its requested shadows are unavailable.
- **Red**: disabled, or intensity is 0.

## Light budget

Each scene can light a limited number of local (point, spot and area) lights at once. Set it in **Project Settings > Rendering > Scalability**:

- **Local Light Budget Mode**: **Auto** follows the Lighting quality level (4, 16, 64 or 256 lights from Low to Ultra). **Manual** lets you set **Local Light Budget**.
- The directional sun and fill lights use separate slots.
- The device's GPU can lower the budget further.

When more local lights are on than the budget allows, Haptic keeps the lights nearest the camera and turns the rest off until they come back into range. Disabled lights and lights with zero intensity do not count. Their **Enabled** setting is not changed.

## Environment lighting

Image-based lighting lights surfaces from a prefiltered environment texture. Pick the texture per scene in the **Inspector** with nothing selected, under **Environment Lighting > Environment Texture**. It is separate from the Skybox, which is only a backdrop.

| Setting | Description |
| --- | --- |
| **Image-Based Lighting** | Uses the scene's Environment Texture. On by default. |
| **Environment Intensity** | Scales environment lighting. Default 1. |
| **Environment Rotation** | Rotation around world Y, in degrees. |
| **CEL Environment Strength** | CEL only. Adds diffuse environment light to the bands. Default 0. |

Project defaults are in **Project Settings > Rendering > Environment Lighting**. In a scene, choose **Override** on a field to change it there, or **Reset To Project** to follow the project again.

## CEL shading

When **Render Mode** is **CEL**, **Project Settings > Rendering > CEL Shading** sets the style. Scenes can override each field in the Inspector the same way as environment lighting.

| Setting | Default | Description |
| --- | --- | --- |
| **Shadow Bands** | 3 | Number of light and shade levels, 2 to 8. |
| **Shadow Threshold** | 0.5 | Higher values extend the shaded region. |
| **Shadow Strength** | 0.65 | Darkness of the deepest shade and cast shadows. |
| **Specular**, **Specular Strength**, **Specular Size** | On, 0.2, 0.2 | Stylised highlights. Strength 0 also turns them off. |
| **Light Color Influence** | 1 | How much light colour tints surfaces. 0 uses neutral light. |
| **Light Mixing** | Strongest Light | **Strongest Light** keeps the dominant light's colour, **Additive** sums lights, **Blend** mixes colours at the strongest light's brightness. |
| **Outlines**, **Outline Color**, **Outline Width** | On, near black, 1 px | Silhouette outlines on eligible geometry. |
| **Outline Distance Fade**, **Outline Fade Start**, **Outline Fade End** | Off, 50, 100 | Shrinks outlines with camera distance. |

Bands and shadow edges are always hard steps. For per-actor outlines, use the [Outline](../components/outline.md) component; see [Geometry](geometry.md#outlines).

## Control lights from scripts

- [Set Light Enabled](../scripting/class/set-light-enabled.md), [Set Light Color](../scripting/class/set-light-color.md) and [Set Light Intensity](../scripting/class/set-light-intensity.md) change a Light component during Play.
- [Set Lighting Quality](../scripting/class/set-lighting-quality.md) changes the light budget for the session.
- [Set Environment Lighting](../scripting/class/set-environment-lighting.md) and [Set CEL Shading](../scripting/class/set-cel-shading.md) change environment and CEL settings for the session.
