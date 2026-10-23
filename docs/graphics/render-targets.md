# Render Targets

Render targets capture the scene from a second viewpoint into a texture, for security monitors, mirrors, minimaps and depth or normal effects.

For a flat mirror that reflects from the player's own view, use the [Mirror](../components/mirror.md) component instead: it needs no Render Target, follows the current camera every frame, and its Material can distort the reflection with a [Mirror Reflection](../scripting/material/mirror-reflection.md) node. A Render Target Capture shows a fixed lens, which suits monitors and minimaps.

## How the pieces fit

| Piece | Role |
| --- | --- |
| [Render Target](../assets/render-target.md) asset | The image to capture into: its **Render Mode**, **Width** and **Height**. |
| [Render Target Capture](../components/render-target-capture.md) component | A lens in the scene that renders into a Render Target. |
| [Render Target Texture](../assets/render-target-texture.md) asset | Lets Materials sample a Render Target like any Texture. |

## Set up a capture

1. In the **Content Browser**, create a **Render Target** and a **Render Target Texture** (both in the **Rendering** group of the **New Asset** menu).
2. Open the Render Target Texture and set its **Render Target**.
3. Open **Place Actors > Camera > Render Target Capture**, and pick the Render Target in the component's **Render Target** field. Aim the actor like a camera.
4. In a Material, sample the Render Target Texture with a [Texture Sample](../scripting/material/texture-sample.md) or [Texture Parameter](../scripting/material/texture-parameter.md) node, and assign the Material to a mesh.

A Render Target Capture never becomes the player's camera. Selecting one shows its view frustum and a small preview of its lens in the viewport.

## Render Target settings

| Setting | Default | Description |
| --- | --- | --- |
| **Render Mode** | Scene Color | **Scene Color** captures the lit scene. **Depth Pass** stores distance from the capture (near is 0, far is 1). **World Normal** stores surface directions. |
| **Width**, **Height** | 512 × 512 | Size in pixels, 1 to 4096. |

Depth Pass and World Normal skip lighting and post-processing, and leave out translucent surfaces and particles. Scene Color follows the capture's [Quality](#quality).

## Capture settings

| Setting | Default | Description |
| --- | --- | --- |
| **Render Target** | None | The Render Target to fill. |
| **Quality** | Fast | **Fast** draws a lightweight pass. **Full Quality** renders like a camera at the capture. See [Quality](#quality). |
| **Enabled** | On | Turns capturing on or off. |
| **Capture Every Frame** | On | Off stops automatic captures, so scripts decide when to capture. |
| **Capture Only Actors** | Off | Captures only the actors in **Capture Actors**. An empty list captures nothing. |
| **Field Of View** | 60 | Lens angle in degrees, 1 to 179. |
| **Near Clip**, **Far Clip** | 0.1, 1000 | Capture range. |

Captures never include editor helpers.

## Quality

**Quality** decides how a capture draws a Scene Color target. Depth Pass and World Normal targets ignore it.

| Quality | What it draws | Cost |
| --- | --- | --- |
| **Fast** | The lit scene with fog and particles. Water is see-through, without refraction or screen-space reflections. No post-processing, screen effects such as bloom, anti-aliasing or ambient occlusion, or outlines. Animated characters and particles show the previous frame. Shadows come from the main camera's shadow maps: sun shadows are fitted to the main camera's view, so they can be missing or wrong where the capture looks elsewhere. | The captured meshes drawn once more each captured frame. |
| **Full Quality** | What a camera at the capture shows this frame: sun shadows from its own shadow maps, fitted to the capture's view, water refraction and screen-space reflections, the scene's post-processing and screen effects, Outline components and CEL outlines, and the same sorting of see-through and cut-out surfaces. | About a second camera each captured frame: its draws, its own sun shadow maps (every cascade drawn again), water and screen effects, plus GPU memory for its own images and shadow maps. |

A Full Quality capture still differs from the main camera in a few ways:

- Water shows its screen-space or sky reflection instead of a planar mirror.
- When more lights want to shine than the device allows, the main camera decides which ones light the scene.
- Point and spot light shadows come from the main camera's shadow maps. The main camera also decides which point and spot lights get shadows, and their shadows use its **Near Clip**. Otherwise they don't depend on where a camera looks.
- When the device's rendering memory is short, a capture's own sun shadow maps can be smaller (blurrier) than the main camera's. When even the smallest doesn't fit, the capture uses the main camera's until memory frees up; those can be missing or wrong where the capture looks elsewhere.

A new capture is Fast. Choose Full Quality for a few small monitors that must look exactly like the game, such as a security camera over water. After switching, a Full Quality capture prepares its shaders first, so its target keeps the previous image for a moment.

## Keep captures cheap

- Capturing every frame costs a second scene render each frame, and Full Quality costs about as much as a second camera. For a picture that rarely changes, turn off **Capture Every Frame** and call [Capture Render Target](../scripting/class/capture-render-target.md) when you need a new image: the capture draws nothing in between. Until the first capture, the target is transparent.
- With sun shadows on, each Full Quality capture draws its own sun shadow maps every captured frame and keeps them in GPU memory, as much as the main camera's. Lower **Shadow Cascades** or **Directional Map Size** in the [shadow settings](shadows.md#shadow-settings) to make them cheaper.
- Keep Full Quality Render Targets at 512 × 512 or smaller, and use only a few Full Quality captures at once.

In the editor viewport, a capture with Capture Every Frame off stays transparent: on-demand captures run only in Play and exported games.

## Gotchas

- A Material preview shows Render Target Textures as black, because the preview has no scene to capture.
- When a capture sees a surface that shows its own output, that surface shows the previous capture.
- Large or many render targets use GPU memory. Keep sizes as small as the effect allows.

## From scripts

Each capture setting except **Quality** has a Get and Set node, such as [Set Capture Enabled](../scripting/class/set-capture-enabled.md), [Set Capture Every Frame](../scripting/class/set-capture-every-frame.md), [Set Capture Field Of View](../scripting/class/set-capture-field-of-view.md), [Set Capture Only Actors](../scripting/class/set-capture-only-actors.md), [Set Capture Actors](../scripting/class/set-capture-actors.md) and [Set Capture Render Target](../scripting/class/set-capture-render-target.md). [Get Render Target Mode](../scripting/class/get-render-target-mode.md) and [Get Texture Render Target](../scripting/class/get-texture-render-target.md) read the assets.
