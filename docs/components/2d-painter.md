# 2D Painter

A transparent drawing surface for lines, shapes and paths that you draw from a script.

## Add it

Select an actor in a Scene Layer, then choose **Add Component > Overlay > 2D Painter**. You can also place a ready-made actor from **Place Actors > Overlay > 2D Painter**.

## Settings

| Setting | Description |
| --- | --- |
| Width, Height | Size of the drawing area in layer units, centred on the component. Default 10. |
| Pixels Per Unit | Raster quality. Default 100. The surface is limited to 4096 pixels per side and four million pixels in total. |
| Clear Each Frame | Clears the drawing before each simulation tick. Turn it off to keep drawing until you call Clear. Default on. |
| Fill, Stroke | Whether shapes are filled, outlined or both. Default on. |
| Fill Color, Stroke Color | Colours with alpha. Default white. |
| Stroke Width | Line width in layer units. Default 0.02. |
| Line Cap | Butt, Round or Square. Default Butt. |
| Line Join | Miter, Round or Bevel. Default Miter. |
| Fill Rule | Nonzero or Even Odd. Decides which areas count as inside a path. Default Nonzero. |
| Hit Test | Ignore (default), Block or Pass Through. Uses the drawing area. |

## Scripting

Draw from a graph with the component's functions. Each returns a Success pin that is false when the call is rejected.

- Shapes: Draw Line, Draw Polyline, Draw Polygon, Draw Rectangle, Draw Circle, Draw Ellipse.
- Paths: Begin Path, Move To, Line To, Quadratic Curve To, Bezier Curve To, Arc, Close Path, Fill Path, Stroke Path.
- Masks and clearing: Push Mask, Pop Mask, Cut Out Path, Clear.

Positions are in layer units with positive Y pointing up. The current Fill, Stroke, colour, width, cap and join settings are applied when a shape or path is drawn.

## Notes

- Scene Layers only.
- Drawing made by scripts is not saved with the Scene Layer.
- Limits per painter: 16,384 drawing commands, 8,192 segments in one path and 32 nested masks. Calls over a limit return false and leave the existing drawing alone.
- The surface does not react to clicks on its own. Add a [2D Button](2d-button.md) or [2D Focus Target](2d-focus-target.md) for interaction.

## Related

- [Scene Layers](../scenes/scene-layers.md)
- [2D Texture](2d-texture.md)
