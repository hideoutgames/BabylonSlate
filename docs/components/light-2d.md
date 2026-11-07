# 2D Light

Lights Sprites and Tilemaps in the X/Y plane: a **Point** light that fades out over its radius, optionally in a cone, or a **Global** light that lights everything evenly.

## Add it

Select an actor, then choose **Add Component > Rendering > 2D Light**. You can also place a ready-made actor from **Place Actors > Lights > 2D Point Light** or **2D Global Light**.

## Settings

| Setting | Description |
| --- | --- |
| Enabled | Turns the light on or off. Default on. |
| Light Kind | **Point** or **Global**. Default **Point**. |
| Color | The light's colour. Default white. |
| Intensity | Brightness, 0 to 16. Default 1. |
| Radius | How far a Point light reaches, in world units. Default 3. |
| Inner Radius | The distance a Point light stays at full brightness before it starts to fade. Default 0. |
| Outer Angle | The cone's full angle in degrees. The cone points along the actor's up (+Y) direction; 360 lights every direction. Default 360. |
| Inner Angle | The part of the cone at full brightness. The light fades between the inner and outer angle. Default 360. |

## How 2D lighting works

- A scene draws its Sprites and Tilemaps unlit until it holds a 2D Light. Once it has one, every Sprite and Tilemap whose **Shading Mode** is **2D** is lit by the scene's 2D lights, and anything they do not reach is dark.
- Add a **Global** light to set how dark unlit areas are. Global lights add together.
- A Point light lights what lies within its radius in X and Y, whatever its Z position. Rotate the actor around Z to aim a cone.
- 2D lights only light Sprites and Tilemaps with **Shading Mode** set to **2D**. 3D surfaces, meshes and Sprites set to **3D** or **Unlit** ignore them, and 3D lights never light **2D** Sprites.
- At most 16 Point lights light the view at once: the ones nearest the camera. A light past the limit shows a yellow icon.
- In Play, a scene is 2D-lit when it holds a 2D Light or one of its Classes carries or adds one. A 2D Light that a script adds from a Class chosen at runtime does not turn 2D lighting on.

## Notes

- World scenes only. Scene Layers are always unlit.
- Scale does not change a 2D light; use **Radius** instead.
- The **Unlit** viewport shading mode draws 2D-lit surfaces at full brightness.
- 2D lights do not cast shadows.
- [Set Light Enabled](../scripting/class/set-light-enabled.md), [Set Light Color](../scripting/class/set-light-color.md) and [Set Light Intensity](../scripting/class/set-light-intensity.md) change a 2D Light during Play when you pass its actor.

## Related

- [Sprite](sprite.md)
- [Tilemap](tilemap.md)
- [2D](../2d/index.md#2d-lighting)
- [Lighting](../graphics/lighting.md)
