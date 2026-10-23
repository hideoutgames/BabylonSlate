# Post-Processing

Post-processing changes the rendered image after the scene is drawn: colour, glow, anti-aliasing, ambient occlusion and reflections. Project-wide effects live in Project Settings; each scene can add its own passes built from post-process Materials.

## Project effects

Open **Project Settings > Rendering > Post Processing**. Every effect is off in new projects.

| Effect | Settings | Description |
| --- | --- | --- |
| **Ambient Occlusion** | **Occlusion Radius**, **Occlusion Strength**, **Occlusion Distance**, **Occlusion Resolution Scale**, **Occlusion Samples** | Darkens creases and contact points between PBR surfaces. |
| **Real-Time Reflections** | **Reflection Resolution Scale**, **Reflection Steps**, **Reflection Distance**, **Reflection Thickness**, **Reflection Strength** | Reflects visible objects on lit metal and smooth surfaces; unlit surfaces never reflect. In CEL it also needs **Real-Time Reflections** in [CEL Shading](lighting.md#cel-shading). Environment lighting still covers what is off screen. |
| **Volumetric Fog** | See [Sky and Fog](sky-and-fog.md#volumetric-fog) | Fog lit by scene lights. |
| **Bloom** | **Bloom Threshold** (0.9), **Bloom Weight** (0.15), **Bloom Kernel** (64), **Bloom Scale** (0.5) | Glow around bright surfaces. |
| **Vignette** | **Vignette Weight** (1.5), **Vignette Color** (black) | Darkens the frame edges. |
| **Color Grading** | **LUT Texture** | Remaps final colours through a lookup table. |
| **FXAA** | None | Full-screen edge anti-aliasing. |
| **Temporal Anti-Aliasing** | **Temporal Blend** (0.1), **Jitter Samples** (8) | Blends jittered frames to smooth edges and effect noise. Fast motion can ghost. |
| **FSR Upscaling** | **Render Scale** (0.67), **Sharpness** (0.2) | Renders at a lower resolution, then upscales and sharpens with AMD FSR 1. |

For **Color Grading**, use a horizontal strip of square slices, such as 256×16 or 1024×32. Open the Texture and set **Usage** to **Color Grading LUT** so it stays uncompressed.

## Color Pipeline

| Setting | Description |
| --- | --- |
| **Color Pipeline** | **Legacy Display** (default) or **Scene Linear**. Scene Linear renders PBR in high dynamic range, then applies the settings below. CEL stays in display space. |
| **Tone Mapping** | **None**, **Standard**, **ACES** or **Neutral**. Scene Linear only. |
| **Exposure** | Brightness multiplier before tone mapping. Default 1. |
| **Contrast** | Contrast curve strength. Default 1. |
| **White Balance** | Corrects the colour of the scene lighting, with **Temperature (K)** (6500 is neutral) and **Tint**. |

Vignette and Color Grading apply in both pipelines.

## Quality

Post-processing cost follows the **Post Processing** group in **Project Settings > Rendering > Scalability**.

| Level | Post Processing Resolution Scale | Allow Ambient Occlusion | Allow Reflections | Allow Volumetric Lighting |
| --- | --- | --- | --- | --- |
| Low | 0.5 | Off | Off | Off |
| Medium | 0.75 | On | Off | Off |
| High | 1 | On | On | On |
| Ultra | 1 | On | On | On |

An **Allow** switch never turns an effect on; the effect also has to be on in **Post Processing**. **Post Processing Resolution Scale** applies to passes marked **Scalable**.

## Scene passes

Add your own full-screen effects to a scene with post-process Materials.

1. Create a [Material](../assets/material.md) and set its **Domain** to **Post Process**. Read the rendered image with [Scene Color](../scripting/material/scene-color.md), [Scene Depth](../scripting/material/scene-depth.md) or [Scene Normal](../scripting/material/scene-normal.md), and finish at [Post Process Output](../scripting/material/post-process-output.md).
2. Open the scene and clear the selection so the **Inspector** shows the scene's settings.
3. Under **Post Processing**, choose **Add Pass** and pick the Material or a Material Instance of it.
4. Use **Enabled** to switch a pass off, and **Scalable** to let quality settings lower its resolution.

Passes run from top to bottom. If a pass needs a buffer the device cannot provide, only that pass is skipped.

## From scripts

- [Set Rendering Effects](../scripting/class/set-rendering-effects.md) changes the colour pipeline, tone mapping, exposure, bloom, vignette and FXAA for the session. [Set Antialiasing](../scripting/class/set-antialiasing.md) and [Set Vignette Color](../scripting/class/set-vignette-color.md) change one setting.
- [Set Post Processing Quality](../scripting/class/set-post-processing-quality.md) changes the Post Processing quality group.
- To animate a scene pass, copy its **Entry ID** (the **#** button beside the pass's Material), get its Material with [Get Post Process Entry](../scripting/class/get-post-process-entry.md), then use [Set Material Float Parameter](../scripting/class/set-material-float-parameter.md) or [Set Material Color Parameter](../scripting/class/set-material-color-parameter.md).
- [Register Scene Layer Post-Processing](../scripting/class/register-scene-layer-post-processing.md) adds a post-process Material to a Scene Layer.

## Editor preview

To skip post-processing while you edit, turn on **Override Project Rendering** in **Engine Settings > Viewport**, then turn off **Post-Processing**. This affects only the editor and Play preview; exported games are unchanged.
