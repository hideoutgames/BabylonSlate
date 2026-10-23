# Water

The look and waves shared by oceans, lakes, rivers and puddles. The same waves drive floating objects and script queries.

## Create

In the **Content Browser**, choose **New Asset > Rendering > Water**. Choose a **Water Style**: **Realistic**, or **Stylized** with a **Stylized Look** of **Painted** or **Toon**. Each style starts with its own colours and wave defaults. Realistic and Painted draw a simulated ocean of many wave trains, with foam that gathers on breaking crests and fades slowly; Toon draws a few smooth swells.

## Editor

Double-tap the asset to open it. The window has **Preview** and an **Inspector**.

- **Preview** shows a lake of this water. Drag to orbit around its centre, above or below the surface; pinch or use the mouse wheel to zoom. Edits apply while the waves keep moving.
- The **Inspector** edits the look, waves, foam and surface detail. Settings marked "Render only" do not affect buoyancy or queries.
- **Refraction** and **Object Reflections** show in scene viewports and Play, not in Preview.

## Settings

| Setting | Description |
| --- | --- |
| Style, Stylized Look | Switching styles keeps your colours and wave settings. |
| Shallow Color, Deep Color, Foam Color | The water colours. |
| Opacity, Roughness, Reflection Strength, Refraction, Color Variation, Depth Color Distance | Water look. Depth Color Distance is the metres of water that absorb most light. |
| Object Reflections | Also reflects scene objects, following the project's Water Reflections quality. Off reflects only the sky. |
| Wave Model | Toon and Custom Material only: **Classic** or **Ocean Spectrum**. The choice affects physics. |
| Wave Height, Wave Length, Wave Speed, Wave Direction, Wave Spread | Size, spacing, speed and heading of the waves. On Realistic and Painted these set the local wind sea: Wave Length is the metres between its biggest crests, so a short length gives a choppy sea and a long one rolling waves. |
| Swell Height, Swell Length, Swell Direction | Realistic and Painted only. Long waves from a distant storm, rolling under the wind sea. Set Swell Height to 0 for none. |
| Choppiness, Steepness | Sharper crests, and waves that also move the water sideways. |
| Peak Sharpness, Wave Seed | Shape and arrangement of the sea. Peak Sharpness gathers the waves around Wave Length. |
| Detail Waves | Render only. Toon and Custom Material: fine wave detail, drawn when **FFT Ocean Detail** is on. Realistic and Painted: the share of short waves on top of the sea. |
| Ripple Strength, Ripple Scale | Toon and Custom Material only. Small wind ripples. |
| Foam Amount, Foam Width, Crest Foam, Surface Foam, Contact Foam Width | Shoreline, whitecap, open-water and contact foam. |
| Subsurface, Color Bands, Sparkles | Light through crests, Stylized depth bands, and sun glints. |
| Density | Kilograms per cubic metre, about 1000 for fresh water. Sets how much a floating object can carry. |
| Custom Material | An optional Surface Material that replaces the built-in shading. Waves and buoyancy still work. |

## Use it

Place the asset from **Place Actors** to create a lake that uses it, or set **Water** on a water component such as [Water Ocean](../components/water-ocean.md). Water components with no asset use the Realistic defaults.

## Related

- [Water](../graphics/water.md)
- [Water Ocean](../components/water-ocean.md)
- [Water Buoyancy](../components/water-buoyancy.md)
- [Material](material.md)
