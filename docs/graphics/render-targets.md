# Render Targets

Render targets capture the scene from a second viewpoint into a texture, for security monitors, mirrors, minimaps and depth or normal effects.

## How the pieces fit

| Piece | Role |
| --- | --- |
| [Render Target](../assets/render-target.md) asset | The image to capture into: its **Render Mode**, **Width** and **Height**. |
| [Render Target Capture](../components/render-target-capture.md) component | A lens in the scene that renders into a Render Target. |
| [Render Target Texture](../assets/render-target-texture.md) asset | Lets Materials sample a Render Target like any Texture. |

## Set up a capture

1. In the **Content Browser**, create a **Render Target** and a **Render Target Texture** (both in the **Rendering** group of the New Asset dialog).
2. Open the Render Target Texture and set its **Render Target**.
3. Open **Place Actors > Camera > Render Target Capture**, and pick the Render Target in the component's **Render Target** field. Aim the actor like a camera.
4. In a Material, sample the Render Target Texture with a [Texture Sample](../scripting/material/texture-sample.md) or [Texture Parameter](../scripting/material/texture-parameter.md) node, and assign the Material to a mesh.

A Render Target Capture never becomes the player's camera. Selecting one shows its view frustum and a small preview of its lens in the viewport.

## Render Target settings

| Setting | Default | Description |
| --- | --- | --- |
| **Render Mode** | Scene Color | **Scene Color** captures the lit scene. **Depth Pass** stores distance from the capture (near is 0, far is 1). **World Normal** stores surface directions. |
| **Width**, **Height** | 512 × 512 | Size in pixels, 1 to 4096. |

Depth Pass and World Normal skip lighting and post-processing, and leave out translucent surfaces and particles. Scene Color has no camera post-processing.

## Capture settings

| Setting | Default | Description |
| --- | --- | --- |
| **Render Target** | None | The Render Target to fill. |
| **Enabled** | On | Turns capturing on or off. |
| **Capture Every Frame** | On | Off stops automatic captures, so scripts decide when to capture. |
| **Capture Only Actors** | Off | Captures only the actors in **Capture Actors**. An empty list captures nothing. |
| **Field Of View** | 60 | Lens angle in degrees, 1 to 179. |
| **Near Clip**, **Far Clip** | 0.1, 1000 | Capture range. |

Captures never include editor helpers.

## Capture on demand

Capturing every frame costs a second scene render each frame. For a picture that rarely changes, turn off **Capture Every Frame** and call [Capture Render Target](../scripting/class/capture-render-target.md) when you need a new image. Until the first capture, the target is transparent.

In the editor viewport, a capture with Capture Every Frame off stays transparent: on-demand captures run only in Play and exported games.

## Gotchas

- A Material preview shows Render Target Textures as black, because the preview has no scene to capture.
- When a capture sees a surface that shows its own output, that surface shows the previous capture.
- Large or many render targets use GPU memory. Keep sizes as small as the effect allows.

## From scripts

Each capture setting has a Get and Set node, such as [Set Capture Enabled](../scripting/class/set-capture-enabled.md), [Set Capture Every Frame](../scripting/class/set-capture-every-frame.md), [Set Capture Field Of View](../scripting/class/set-capture-field-of-view.md), [Set Capture Only Actors](../scripting/class/set-capture-only-actors.md), [Set Capture Actors](../scripting/class/set-capture-actors.md) and [Set Capture Render Target](../scripting/class/set-capture-render-target.md). [Get Render Target Mode](../scripting/class/get-render-target-mode.md) and [Get Texture Render Target](../scripting/class/get-texture-render-target.md) read the assets.
