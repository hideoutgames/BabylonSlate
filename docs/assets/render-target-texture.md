# Render Target Texture

A live Render Target that Materials can sample like a Texture, for security monitors, mirrors and minimaps.

## Create

In the **Content Browser**, choose **New Asset > Rendering > Render Target Texture**.

Or right-click a [Render Target](render-target.md) and choose **Create Render Target Texture** for one that already shows it. See [Create from assets](../editor/content-browser.md#create-from-assets).

## Editor

Double-tap the asset to open it. The window has an **Inspector** only.

## Settings

| Setting | Description |
| --- | --- |
| Render Target | The [Render Target](render-target.md) whose output this texture shows. A [Render Target Capture](../components/render-target-capture.md) in the scene fills it. |

## Use it

In a [Material](material.md), sample the asset with a [Texture Sample](../scripting/material/texture-sample.md) or [Texture Parameter](../scripting/material/texture-parameter.md) node, then assign the Material to a mesh.

## Notes

- A Material preview shows a Render Target Texture as black, because the preview has no scene to capture.

## Related

- [Render Targets](../graphics/render-targets.md)
- [Render Target Capture](../components/render-target-capture.md)
