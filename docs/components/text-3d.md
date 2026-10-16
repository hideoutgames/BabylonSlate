# 3D Text

Flat, unlit text drawn in the world.

## Add it

Select an actor, then choose **Add Component > Rendering > 3D Text**. You can also place a ready-made actor from **Place Actors > Environment > 3D Text**.

## Settings

| Setting | Description |
| --- | --- |
| Size | Text size in world units, 0.01 to 100. Default 1. |
| Color | The text colour. Default white. |
| Alignment | **Left**, **Center** or **Right**. Default Left. |
| Font | A [Font](../assets/font.md) asset. Empty uses a built-in typeface. |
| Text | The text, which can run over several lines. Default "Text". |

## Notes

- Works in world scenes and in Scene Layers.
- Lights and shadows do not affect the text.
- Each new line sits above the previous one. The actor's origin stays at the bottom of the block.
- Without a Font, or with a Font that has no 3D typeface data, the text uses a built-in typeface with basic ASCII characters. The Inspector then shows **Typeface**.
- Change the text from a script with the component's **Set Text** function.
- For text in HUDs and menus, use [2D Text](2d-text.md) in a Scene Layer.

## Related

- [Geometry](../graphics/geometry.md)
- [Font](../assets/font.md)
