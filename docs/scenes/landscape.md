# Landscape and Foliage

Sculpt terrain and scatter models such as grass, rocks and trees with brushes, right in the scene viewport.

## Switch scene mode

With a Scene open, pick **Landscape** or **Foliage** in the **Scene Mode** picker in the toolbar. **Design** returns to ordinary editing. Each mode has its own windows, and the viewport toolbar shows brush tools instead of the gizmo. Switching modes keeps the scene and its undo history.

To brush, drag with one finger, the mouse or a pen. A ring on the surface shows the brush. Choose **Navigate** to move the camera with the usual gestures.

## Sculpt a landscape

1. Switch to **Landscape**. In **Landscape Outliner**, tap **Create Landscape**. A flat landscape 64 × 64 units across, with 64 cells per side, appears at the origin.
2. Pick a tool in the viewport toolbar and drag over the terrain.

| Tool | Effect |
| --- | --- |
| Raise, Lower | Push the ground up or down. |
| Smooth | Evens out bumps. |
| Flatten | Levels the ground to **Flatten Height**. |
| Paint Layer | Paints one of four material layers. |

**Landscape Settings** holds the brush and the selected landscape:

| Setting | Description |
| --- | --- |
| Radius | Brush size in world units. Default 4. |
| Strength | How much each dab changes the ground. Default 0.25. |
| Falloff | The share of the radius that fades out towards the edge. Default 0.5. |
| Flatten Height, Paint Layer | Shown for the Flatten and Paint Layer tools. |
| Size | Width and depth, 1 to 4,096 units. |
| Cells | Cells per side, 4 to 256. Changing it resamples the existing shape. |
| Landscape Collisions | Lets 3D physics and **Drop** use the sculpted surface. Off by default. |
| Landscape Material | A Material or Material Instance with the **Landscape** domain. Without one, the landscape shows a checker pattern. |

Sculpting only changes the landscape selected in **Landscape Outliner**.

## Landscape materials

Set a Material's **Domain** to **Landscape** to unlock [Landscape Coordinates](../scripting/material/landscape-coordinates.md), [Landscape Height](../scripting/material/landscape-height.md), [Landscape Slope](../scripting/material/landscape-slope.md), [Landscape Paint Layers](../scripting/material/landscape-paint-layers.md) and [Landscape Layer Blend](../scripting/material/landscape-layer-blend.md). Use them to texture by height or slope, or to blend the four painted layers. See [Materials](../graphics/materials.md).

## Paint foliage

1. Switch to **Foliage**. In **Foliage Groups**, tap **New Group**.
2. Tap **Add Model** and pick Model assets. For each one, set **Weight** (its share of the instances), **Scale Range** (default 0.8 to 1.2) and an optional **Material Override**.
3. Pick **Paint Foliage** and drag over any visible, unlocked surface. **Erase Foliage** removes instances under the brush.

**Foliage Settings** controls the brush:

| Setting | Description |
| --- | --- |
| Radius | Brush size. Default 4. |
| Density | Instances per square unit. Default 0.25. |
| Minimum Spacing | Closest distance between instances. Default 0.5. |
| Maximum Slope | Steepest surface, in degrees, that receives foliage. Default 60. |
| Align To Surface | Tilts instances to match the ground. On by default. |
| Random Rotation | Turns each instance randomly. On by default. |

Each paint stroke becomes one entry in **Foliage Outliner**, with its instance count. Select one to **Frame** it or **Delete Component**.

## Things to know

- Each stroke is one undo step. Press <kbd>Escape</kbd> or touch with a second finger to cancel a stroke before you lift.
- A single foliage stroke holds up to 20,000 instances.
- Foliage is static scenery: it has no collision, scripts or animation.
- Landscape collision works only in scenes whose **Physics World** is 3D. It needs no Collider or Rigid Body.
- Landscape and Foliage work in world scenes only, not in Scene Layers.

## Related

- [Landscape](../components/landscape.md)
- [Foliage](../components/foliage.md)
- [Scenes](index.md)
