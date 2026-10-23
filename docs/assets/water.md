# Water

The look and waves shared by oceans, lakes, rivers and puddles. The same waves drive floating objects and script queries.

## Create

In the **Content Browser**, choose **New Asset > Rendering > Water**. Choose a **Water Style** of **Realistic** or **Painted**. Each style starts with its own colours and wave defaults. Both draw a simulated ocean of many wave trains, with foam that gathers on breaking crests and fades slowly.

## Editor

Double-tap the asset to open it. The window has **Preview** and an **Inspector**.

- **Preview** shows a lake of this water. Drag to orbit around its centre, above or below the surface; pinch or use the mouse wheel to zoom. Edits apply while the waves keep moving.
- The **Inspector** edits the look, waves, foam and surface detail. Settings marked "Render only" do not affect buoyancy or queries.
- **Refraction** and **Object Reflections** show in scene viewports and Play, not in Preview.

## Settings

| Setting | Description |
| --- | --- |
| Style | **Realistic** or **Painted**. Switching styles keeps your colours and wave settings. |
| Shallow Color, Deep Color, Foam Color | The water colours. |
| Opacity, Roughness, Reflection Strength, Refraction, Color Variation, Depth Color Distance | Water look. Depth Color Distance is the metres of water that absorb most light. |
| Object Reflections | Also reflects scene objects, following the project's Water Reflections quality. Off reflects only the sky. |
| Wave Height, Wave Length, Wave Speed, Wave Direction, Wave Spread | Size, spacing, speed and heading of the local wind sea. Wave Length is the metres between its biggest crests, from 0.1 m for a pond to 2000 m for open ocean, and is independent of Wave Height: a short length gives a choppy sea and a long one rolling waves. |
| Swell Height, Swell Length, Swell Direction | Long waves from a distant storm, rolling under the wind sea. Set Swell Height to 0 for none. |
| Choppiness | Sharper crests, and waves that also move the water sideways. 0 moves water only up and down. Very steep seas, tall waves on a short Wave Length, move sideways less so they do not fold into solid foam; their height is kept. |
| Peak Sharpness, Wave Seed | Shape and arrangement of the sea. Peak Sharpness gathers the waves around Wave Length. |
| Detail Waves | The share of short waves on top of the sea. |
| Foam Amount, Foam Width, Crest Foam, Surface Foam, Contact Foam Width | Shoreline, whitecap, open-water and contact foam. |
| Subsurface, Color Bands, Sparkles | Light through crests. Painted only: light steps painted across each wave, and sun glints. |
| Density | Kilograms per cubic metre, about 1000 for fresh water. Sets how much a floating object can carry. |
| Custom Material | An optional Surface Material that replaces the built-in shading. Waves and buoyancy still work; see [Custom water Materials](../graphics/water.md#custom-water-materials). |

## Use it

Place the asset from **Place Actors** to create a lake that uses it, or set **Water** on a water component such as [Water Ocean](../components/water-ocean.md). Water components with no asset use the Realistic defaults.

## Related

- [Water](../graphics/water.md)
- [Water Ocean](../components/water-ocean.md)
- [Water Buoyancy](../components/water-buoyancy.md)
- [Material](material.md)
