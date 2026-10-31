# Shadows

Real-time shadows come from lights with **Cast Shadows** on and fall on meshes that receive shadows. Project settings control their quality and cost; each scene can override them.

## Turn on shadows

1. Select a light actor and turn on **Cast Shadows** on its [Light](../components/light.md) component. New lights start with it off; the Directional Light in a new 3D scene has it on.
2. Check the meshes involved. Each [Mesh](../components/mesh.md) component has **Cast Shadows** and **Receive Shadows**, both on by default.

Point, spot and directional lights can cast shadows. [Hemispheric Fill Light](../components/hemispheric-fill-light.md) and [Rectangular Area Light](../components/area-rect-light.md) never do. Skyboxes and editor helpers neither cast nor receive.

## Shadow budget

Shadows have a budget separate from the [light budget](lighting.md#light-budget):

- One directional light can cast shadows. Its shadows cover **Shadow Distance** around the camera.
- A limited number of point and spot lights can cast shadows at once. A point light costs six shadow maps, so it is much more expensive than a spot light.
- When too many lights ask for shadows, lights with a higher **Shadow Priority** win, then the lights nearest the camera. Local lights farther than Shadow Distance plus their Range get no shadow.
- The device can lower these requests to fit its memory. A light whose shadows are unavailable shows a yellow icon in the viewport.
- Phones and tablets get the same shadow limits as desktops: the quality level alone sets map sizes, and at **High** and **Ultra** all shadows share one 8192 × 8192 shadow map (256 MiB), as on a desktop. A device whose graphics can't hold a texture that large uses the largest it can.
- A Full Quality [Render Target Capture](render-targets.md#quality) draws its own directional shadows, fitted to its view, each captured frame. Point and spot lights share their shadow maps with the camera.

## Shadow settings

Open **Project Settings > Rendering > Shadows**. The defaults below are the High level, which new projects use.

| Setting | Default | Description |
| --- | --- | --- |
| **Shadows Enabled** | On | Lets eligible lights cast real-time shadows. |
| **Shadow Distance** | 350 | Directional shadow coverage around the camera, in world units. |
| **Shadow Distance Fade** | 0.1 | Fades the far edge over this fraction of the distance. 0 turns fading off. |
| **Directional Map Size** | 2048 | Resolution per cascade, 256 to 4096. |
| **Shadow Cascades** | 4 | Splits directional coverage, 1 to 4, to keep detail near the camera. |
| **Shadow Filter** | PCF | **PCF** softens edges. **Contact Hardening (PCSS)** adds a contact-hardening penumbra, in PBR only; flat ground under the sun stays free of its own shadow. |
| **Shadow Filter Quality** | High | Low, Medium or High. **Low** takes one sample and shows the shadow map's texels at edges. **Medium** blends edges over about 5 shadow-map texels and **High** over about 7, for smoother, wider edges at a higher GPU cost. Edges keep the same softness in the world near and far, except where far shadows have too little detail for it. |
| **Contact Hardening Size** | 0.05 | PCSS light size. Larger values widen the penumbra. |
| **Screen-Space Shadows** | Medium | **Off**, **Low**, **Medium** or **High**. Adds the sun's small contact shadows the shadow map misses, near the camera. See [Screen-Space Shadows](#screen-space-shadows). |
| **Shadow Depth Bias** | 0.0001 | Depth offset. High values detach shadows from surfaces. |
| **Automatic Shadow Bias** | On | Scales directional bias per cascade, with Depth Bias as the minimum. Landscapes also get a normal offset scaled to the shadow resolution, so sculpted terrain does not shadow itself along its edges. |
| **Shadow Normal Bias** | 0.005 | Normal offset, in world units. |
| **Local Shadow Budget Mode** | Auto | **Auto** follows the quality level. **Manual** sets an upper limit. |
| **Local Shadow Light Budget** | 4 | Manual only. Point and spot lights that can cast shadows at once. |
| **Local Shadow Map Size** | 2048 | Resolution of each local shadow map or cube face. |

CEL projects always use PCF. Bands and shadow edges in CEL are hard steps.

## Quality levels

The **Shadows Quality** setting in **Scalability** applies one of these sets. Changing any field afterwards makes it **Custom**.

| Level | Distance | Map size | Cascades | Half-size far cascades | Filter quality | Local shadow lights | Local map size | Smallest far caster | Screen-Space Shadows |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Low | 120 | 2048 | 2 | 0 | Low | 1 | 512 | 3 texels | Off |
| Medium | 250 | 2048 | 3 | 1 | Medium | 2 | 1024 | 2 texels | Off |
| High | 350 | 2048 | 4 | 1 | High | 4 | 2048 | 1.5 texels | Medium |
| Ultra | 600 | 4096 | 4 | 2 | High | 8 | 2048 | 1 texel | High |

Applying a level also resets a Manual **Local Shadow Light Budget** to that level's count.

The last cascades, those farthest from the camera, use half the **Directional Map Size** in each direction (never below 256, and never the first two cascades): far shadows are seen small, and the room they leave goes to closer shadows and local lights.

Beyond the first cascade, an object narrower than the level's smallest far caster, measured in that cascade's shadow texels, casts no directional shadow there: its shadow would be too small to see. The first cascade, nearest the camera, keeps every caster.

### How cascades split the distance

At Medium, High and Ultra, cascades get longer with distance: the first ends 12 to 16 metres from the camera, and each next one is a few times longer, up to **Shadow Distance**. Shadows near the camera get about two to three times the detail of an even split, and the far end keeps its detail. Shadows at some middle distances can be slightly softer than an even split would draw them.

At Low, when the camera's far clip is short, and for orthographic cameras, cascades split the distance more evenly.

With **Contact Hardening (PCSS)**, the sun's penumbrae near the camera are narrower than with an even split, because each texel covers less ground.

## Screen-Space Shadows

The sun's shadow map has a limited number of texels, so small objects resting on the ground, thin planks and the contact under a box can come out faint or missing. **Screen-Space Shadows** look at what the camera sees and darken those contacts where something blocks the sun a short way off.

| Level | Reach | Fades out |
| --- | --- | --- |
| **Low** | up to 0.35 m, 30 pixels | 12 to 20 m from the camera |
| **Medium** | up to 0.6 m, 48 pixels | 20 to 35 m |
| **High** | up to 0.8 m, 64 pixels | 30 to 50 m |

- They apply to the one directional light that casts shadows, in PBR only. CEL has none.
- They work in the Scene Viewport, Play, Preview Build, exported games and Full Quality [Render Target Captures](render-targets.md#quality). Fast captures, reflection probes, mirrors, previews, thumbnails and Scene Layers do not draw them.
- They need the scene's depth. When no post-processing effect already draws it, turning them on adds a depth pass, which costs a little GPU time and one more draw per visible object. Turning **Post-Processing** off in the viewport turns them off too.
- They see only what is on screen: an object leaving the edge of the view stops darkening the ground near it.
- Opaque and masked surfaces receive them. Translucent surfaces don't, but glass and other translucent surfaces in front of the ground can cast them.
- Turning them on or off recompiles lit materials once; changing between Low, Medium and High does not.

## Override shadows in a scene

1. Open the scene and clear the selection so the **Inspector** shows the scene's settings.
2. Open **Shadows**. Each field shows its project value.
3. Choose **Override** on a field to change it for this scene only. **Reset To Project** follows the project again.

## Fix common problems

- **Stripes or speckles on lit surfaces (shadow acne):** raise **Shadow Normal Bias** slightly, or turn on **Automatic Shadow Bias**.
- **Shadows float away from objects:** lower **Shadow Depth Bias**.
- **Blurry directional shadows:** reduce **Shadow Distance**, add cascades or raise **Directional Map Size**.
- **Streaks or smeared edges on a surface the light barely touches:** a light skimming a surface stretches each shadow texel along it. Rotate the light so it meets the surface at a wider angle, or sharpen the shadows as above.
- **A spot or point light has no shadow:** check **Cast Shadows**, the local shadow budget and **Shadow Priority**.
- **A thin dark line or speck near a slim object:** Screen-Space Shadows assume a surface has some thickness behind it, so a thin pole can darken a little of the ground beside it. Lower **Screen-Space Shadows** or turn them off.
- **No contact shadows near the camera:** check **Screen-Space Shadows** is above **Off**, the project renders in PBR, and **Post-Processing** is on in the viewport.

## Control shadows from scripts

- [Set Shadows Enabled](../scripting/class/set-shadows-enabled.md) turns shadows on or off for the session.
- [Set Shadow Quality](../scripting/class/set-shadow-quality.md) changes shadow settings for the session.
