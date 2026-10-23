# Lighting

Lights, environment lighting and the light budget decide how lit surfaces look in the viewport, in Play and in exported games.

## Add a light

1. Open **Place Actors** and choose **Lights**.
2. Pick **Point Light**, **Directional Light**, **Spot Light** or **Hemispheric Fill**.

You can also select an actor and use **Add Component > Rendering** to add **Light**, **Rectangular Area Light** or **Hemispheric Fill Light**.

New 3D scenes already contain a warm **Directional Light** with **Cast Shadows** on, a Skybox that also provides [environment lighting](#environment-lighting), and a Camera. The light starts about 45° above the horizon and to the left of the camera, so surfaces facing the camera are well lit and their shadows stay crisp. A PBR scene with no lights and no environment lighting renders dark, including meshes with no Material, which draw a [grey checker](models.md#materials) only while a light reaches them. A **Blank** project's first scene is empty, so add a light before you place meshes.

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
| **Color**, **Intensity** | New lights use white at intensity 1. **Light Kind** switches between Point, Spot and Directional. |
| **Cast Shadows** | Off for new lights. See [Shadows](shadows.md). |
| **Shadow Priority** | Which lights keep their shadows when the shadow budget is full. |
| **Range** | Point and spot only. Default 10. |
| **Inner Angle**, **Outer Angle** | Spot only, in degrees. Defaults 30 and 45. |

For a textured **Rectangular Area Light**, pick a Texture in **Emission Texture**. The editor prepares its emission data automatically; the light stays off until it is ready.

## Light icons

Light icons in the viewport show each light's state:

- **White**: working as configured.
- **Yellow**: limited. The light is over the light budget or the device's light capacity, or its requested shadows are unavailable.
- **Red**: disabled, or intensity is 0.

## Light budget

Each scene can light a limited number of local (point, spot and area) lights at once. Set it in **Project Settings > Rendering > Scalability**:

- **Local Light Budget Mode**: **Auto** follows the Lighting quality level (4, 16, 64 or 256 lights from Low to Ultra). **Manual** lets you set **Local Light Budget**.
- The directional sun and fill lights use separate slots.
- The device's GPU can lower the budget further.

When more local lights are on than the budget allows, Haptic keeps the lights nearest the camera and switches the rest off until the camera moves closer to them. Disabled lights and lights with zero intensity do not count. Their **Enabled** setting is not changed.

A different mix of light kinds needs new shaders the first time. On WebGL2 the objects on screen keep their previous shaders until the new ones are ready, so the change shows a few frames late; on WebGPU the view can pause. The kind is the light type (point, spot or area) and whether the light has a shadow map, so a shadowed and an unshadowed spot are different kinds. Haptic therefore prefers to switch a light for one of the same kind, including when you switch a light off. A nearer light of another kind can stay off: it takes a place only once it is more than 1.25 times nearer the camera than the light it would replace.

## Environment lighting

Image-based lighting lights and reflects surfaces with the colours around them. Open the scene and clear the selection so the **Inspector** shows the scene's settings, then choose an **Environment Source**:

| Environment Source | Lights the scene from |
| --- | --- |
| **None** | Nothing. Only lights reach surfaces. |
| **Skybox** | The scene's Skybox. New 3D scenes start here. |
| **Texture** | A prefiltered environment cube you pick in **Environment Texture**. |

With **Skybox**, lighting follows the sky as you change its faces or rotate its actor, and nothing needs importing. Keep one visible Skybox per scene: when several are visible, only one of them lights it, and a scene with no visible Skybox has no image-based lighting. Sky images have a limited brightness range, so the sun in them lights surfaces only softly; keep a **Directional Light** for sunlight and shadows.

For **Texture**, import a prefiltered environment cube as a `.env` or `.dds` file first. See [Importing](../editor/importing.md). It usually gives sharper, brighter reflections than a Skybox.

| Setting | Description |
| --- | --- |
| **Image-Based Lighting** | Uses the scene's Environment Source. On by default. |
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
| **Real-Time Reflections** | Off | Lets [Real-Time Reflections](post-processing.md#project-effects) draw on CEL surfaces. Off keeps CEL flat. |

Bands and shadow edges are always hard steps. For per-actor outlines, use the [Outline](../components/outline.md) component; see [Geometry](geometry.md#outlines).

With **Real-Time Reflections** on, and the effect on in **Post Processing**, CEL surfaces reflect as their Materials do in PBR: metal and smooth surfaces reflect, unlit surfaces never do. Imported models reflect from their metal and roughness values; a model whose metalness comes from a texture does not reflect in CEL.

## Control lights from scripts

- [Set Light Enabled](../scripting/class/set-light-enabled.md), [Set Light Color](../scripting/class/set-light-color.md) and [Set Light Intensity](../scripting/class/set-light-intensity.md) change a Light component during Play.
- [Set Lighting Quality](../scripting/class/set-lighting-quality.md) changes the light budget for the session.
- [Set Environment Lighting](../scripting/class/set-environment-lighting.md) and [Set CEL Shading](../scripting/class/set-cel-shading.md) change environment and CEL settings for the session.
