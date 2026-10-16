# Graphics

Haptic renders with Babylon.js. Project-wide rendering choices live in **Project Settings > Rendering**, and each scene can override some of them in the **Inspector** when nothing is selected. The same settings drive the editor viewport, asset previews, Play and exported games.

Open **Settings > Project Settings** and choose **Rendering**. Changes apply together when you close the dialog with **Done**. The editor then reloads open scenes and previews; if the renderer has to restart it shows **Updating Rendering**. Open documents and unsaved edits are kept.

## Render Mode

| Mode | Look |
| --- | --- |
| **PBR** | Physically based lighting. The default. |
| **CEL** | Banded, cartoon-style lighting with hard light and shadow steps, optional highlights and outlines. |

When **Render Mode** is **CEL**, a **CEL Shading** section appears in Project Settings, and each scene can override its values. See [Lighting](lighting.md#cel-shading).

## Render Path and GPU Backend

| Setting | Options | Description |
| --- | --- | --- |
| **Render Path** | Auto, Forward, Clustered Forward | How lights are processed. Independent of Render Mode. New projects use Forward. |
| **GPU Backend** | Auto, WebGL2, WebGPU | Used by viewports, previews, Play and exported games. New projects use WebGL2. |

Clustered Forward requires WebGL2. On WebGPU, or when a scene cannot use it, Haptic falls back to Forward.

## Scalability

**Scalability** sets quality per group: **Shadows**, **Resolution**, **Textures**, **Geometry**, **Water**, **Post Processing** and **Lighting**. Pick a level for all groups with **Overall Quality**, or set groups individually. When groups differ, Overall Quality shows **Custom**. New projects use Medium.

| Level | Target device | Resolution Scale | Texture Budget | Local lights | Shadow Distance |
| --- | --- | --- | --- | --- | --- |
| Low | Budget Android phone | 0.75 | 256 MiB | 4 | 80 |
| Medium | Apple A16 | 1 | 512 MiB | 16 | 200 |
| High | Performance desktop | 1 | 1024 MiB | 64 | 350 |
| Ultra | High-end gaming PC | 1 | 2048 MiB | 256 | 600 |

Targets are guides, not guarantees. Profile on the devices you ship to.

- **Resolution Scale**, **Dynamic Resolution**, **Minimum Resolution Scale** and **Dynamic Resolution Target FPS** trade sharpness for frame rate. Dynamic Resolution is on below Ultra.
- **Texture LOD Bias**, **Texture Anisotropy** and **Texture Budget (MiB)** control texture detail and memory. Unused textures are released above the budget.
- **Auto LOD** and **LOD Distance Scale** control simplified model levels. See [Models](models.md#automatic-lod).
- Water and post-processing groups are covered in [Water](water.md#water-quality) and [Post-Processing](post-processing.md#quality).

## Resolution and frame rate

| Setting | Description |
| --- | --- |
| **Custom Resolution** | Sets a design size for Play and exported games. On for new projects. |
| **Render Size** | The design width and height. Default 1920 × 1080. |
| **Black Bars** | Adds bars to keep the design size. Off fills the window without stretching. |
| **Play Frame Cap** | Frames per second for Play and Preview. Default 60. |
| **Follow System**, **Aspect Ratio** | Play Preview aspect. Turn off Follow System to use a fixed ratio. |

The editor viewport has its own **Viewport Frame Cap (FPS)** in **Engine Settings > Viewport**. Turn on **Override Project Rendering** there to lower resolution or skip post-processing in editor previews only; exported games are unchanged.

## Viewport Mode

The viewport's **Viewport Settings** menu has **Viewport Mode**: **PBR** (or **CEL**), **Unlit** and **Wireframe**. This only changes how the editor draws the scene. Play and exported games always use the project's Render Mode.

## Change quality from scripts

Scripts can change rendering for the current session without editing project settings:

- [Set Scalability Preset](../scripting/class/set-scalability-preset.md) applies a level to every group.
- [Set Render Scale](../scripting/class/set-render-scale.md), [Set Render Resolution](../scripting/class/set-render-resolution.md), [Set Frame Cap](../scripting/class/set-frame-cap.md), [Set Render Mode](../scripting/class/set-render-mode.md) and [Set Render Path](../scripting/class/set-render-path.md) change one setting.
- [Get Effective Scalability](../scripting/class/get-effective-scalability.md) reads what the renderer applied, and [Event Scalability Changed](../scripting/class/event-scalability-changed.md) runs when a request is confirmed or rejected.
- [Reset to Project Defaults](../scripting/class/reset-to-project-defaults.md) clears session changes.

Other Scalability nodes cover each group, such as [Set Shadow Quality](../scripting/class/set-shadow-quality.md) and [Set Texture Quality](../scripting/class/set-texture-quality.md). During Play you can also use the `quality` console command; see [Console](../debugging/console.md).

## In this section

- [Lighting](lighting.md): lights, environment lighting and the light budget.
- [Shadows](shadows.md): shadow settings and per-light shadows.
- [Cameras](cameras.md): cameras, the Default Camera and Spring Arm.
- [Sky and Fog](sky-and-fog.md): skyboxes, distance fog and volumetric fog.
- [Post-Processing](post-processing.md): bloom, colour grading, anti-aliasing and post-process Materials.
- [Materials](materials.md): authoring Materials, instances and functions.
- [Water](water.md): water bodies, water quality and buoyancy.
- [Particles](particles.md): emitters, Particle Graphs and Particle Systems.
- [Render Targets](render-targets.md): capturing the scene into a texture.
- [Models](models.md): models, skeletons, animation clips and automatic LOD.
- [Geometry](geometry.md): splines, cables, deformers, runtime meshes, outlines and 3D text.
