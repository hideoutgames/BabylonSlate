# Render Target Capture

A lens that renders the scene into a Render Target, for monitors, mirrors and minimaps.

## Add it

Select an actor, then choose **Add Component > Camera > Render Target Capture**. You can also place a ready-made actor from **Place Actors > Camera > Render Target Capture**.

## Settings

| Setting | Description |
| --- | --- |
| Render Target | The [Render Target](../assets/render-target.md) to fill. |
| Quality | **Fast** draws a lightweight pass. **Full Quality** renders like a camera at the capture, including water refraction, post-processing and outlines, at about the cost of a second camera. Scene Color targets only. Default Fast. |
| Enabled | Turns capturing on or off. Default on. |
| Capture Every Frame | Captures each frame. Turn off to capture only when a script asks. Default on. |
| Capture Only Actors | Captures only the actors in **Capture Actors**. Default off. |
| Capture Actors | The actors to capture. Shown when Capture Only Actors is on. An empty list captures nothing. |
| Field Of View | Lens angle in degrees, 1 to 179. Default 60. |
| Near Clip | Nothing closer is captured. Default 0.1. |
| Far Clip | Nothing farther is captured. Default 1000. |

## Notes

- World scenes only.
- The capture looks along its actor's forward (+Z) axis. It never becomes the player's camera.
- A Render Target Texture asset lets a Material show the captured image.
- Capturing every frame draws the scene a second time each frame. For images that rarely change, turn it off and call [Capture Render Target](../scripting/class/capture-render-target.md).
- Full Quality also runs water and screen effects for the capture and keeps its own GPU images: keep its Render Target at 512 × 512 or smaller. See [Render targets](../graphics/render-targets.md#quality) for what each quality draws.

## Related

- [Render targets](../graphics/render-targets.md)
- [Render Target Texture](../assets/render-target-texture.md)
- [Camera](camera.md)
