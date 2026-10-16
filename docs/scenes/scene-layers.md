# Scene Layers

A Scene Layer is a flat 2D overlay that draws on top of the world: a HUD, a pause menu, a title screen. Layers stack, each with its own actors, and they stay put on screen however the world camera moves.

## Create and edit a layer

1. In the **Content Browser**, choose **New Asset > World > Scene Layer**, then double-tap it.
2. The viewport is always 2D and unlit. The orange frame is the layer's design canvas, centred on the origin.
3. Add actors with **+** in the **Outliner**. **Place Actors** adds an **Overlay** category with ready-made 2D elements.
4. Select an actor and use the box around it: drag inside to move, drag a handle to resize, drag the knob above it to rotate. For **2D Text**, resizing changes the text box rather than the letters.

With nothing selected, the **Inspector** shows the layer's settings:

| Setting | Description |
| --- | --- |
| Name | The layer's display name. |
| Enable Physics | Off by default. When on, each copy of the layer simulates its Rigid Bodies and Colliders in its own 2D world. |
| Gravity | Gravity for that 2D world. |
| Layer Width, Layer Height | Size of the design canvas in layer units. Default 32 × 18. |
| Post Processing | Post-process passes applied to this layer only. |

## What goes on a layer

Overlay components work only in Scene Layers. Add them with **Add Component > Overlay**, or place them from the **Overlay** category.

| Purpose | Components |
| --- | --- |
| Show things | [2D Texture](../components/2d-texture.md), [2D Material](../components/2d-material.md), [2D Panel](../components/2d-panel.md), [2D Text](../components/2d-text.md), [2D Rich Text](../components/2d-rich-text.md), [2D Painter](../components/2d-painter.md) |
| React to input | [2D Button](../components/2d-button.md), [2D Focus Target](../components/2d-focus-target.md), [2D Joystick](../components/2d-joystick.md) |
| Form controls | [2D Slider](../components/2d-slider.md), [2D Range Slider](../components/2d-range-slider.md), [2D Checkbox](../components/2d-checkbox.md), [2D Radio Button](../components/2d-radio-button.md), [2D Toggle](../components/2d-toggle.md), [2D Text Input](../components/2d-text-input.md), [2D Numeric Input](../components/2d-numeric-input.md), [2D Dropdown](../components/2d-dropdown.md), [2D Progress Bar](../components/2d-progress-bar.md) |
| Layout | [2D Anchor](../components/2d-anchor.md), [2D Vertical Box](../components/2d-vertical-box.md), [2D Horizontal Box](../components/2d-horizontal-box.md), [2D Overlay Box](../components/2d-overlay-box.md), [2D Scroll Box](../components/2d-scroll-box.md), [2D Padding](../components/2d-padding.md), [2D Spacer](../components/2d-spacer.md), [2D Safe Area](../components/2d-safe-area.md) |
| Clip and repeat | [2D Mask Panel](../components/2d-mask-panel.md), [2D Mask](../components/2d-mask.md), [2D Virtualized List](../components/2d-virtualized-list.md), [2D Virtualized Grid](../components/2d-virtualized-grid.md) |

Sprites, tilemaps, meshes, 3D text, sound, particles and physics components also work on a layer. Lights, cameras, skyboxes, water, fog volumes and Scene Streaming do not.

To script layer elements, make a Class whose parent is **Scene Layer Actor**. Such Classes appear in **Place Actors** only while a Scene Layer is open. The **2D Scene Layer Actor Switcher** shows one Scene Layer Actor Class at a time from its list; **Initial Index** picks the first one (−1 starts empty), and the **Switch Scene Layer Actor** function changes it.

## Show a layer in the game

- **With a scene**: in the scene's **Scene Settings**, tap **Add Layer** under **Scene Layers**, pick the asset, and set **Z-Order**. While its switch is on, the layer appears when the scene loads and goes away when the scene unloads.
- **From a script**: [Create Scene Layer](../scripting/class/create-scene-layer.md) adds a layer and returns it. It stays across [Change Scene](../scripting/class/change-scene.md) until [Remove Scene Layer](../scripting/class/remove-scene-layer.md) or [Clear Scene Layer](../scripting/class/clear-scene-layer.md).

Layers with a higher **Z-Order** draw on top. The same asset can be shown more than once. Add effects to a live layer with [Register Scene Layer Post-Processing](../scripting/class/register-scene-layer-post-processing.md).

## Buttons and pointer events

An actor receives pointer events only after you add a **2D Button** to it. It then gets [Event On Click](../scripting/class/event-on-click.md), [Event On Press Start](../scripting/class/event-on-press-start.md), [Event On Press End](../scripting/class/event-on-press-end.md), [Event On Mouse Enter](../scripting/class/event-on-mouse-enter.md) and [Event On Mouse Leave](../scripting/class/event-on-mouse-leave.md). These fire for touch as well as the mouse. The button uses the actor's visual (a 2D Texture, Panel or Text, for example) as its tap area.

## Keyboard and gamepad focus

**2D Button** and the form controls can take focus; add **2D Focus Target** to make anything else focusable. Each one has **Focus Enabled**, **Initial Focus** and **Focus Up**, **Focus Down**, **Focus Left** and **Focus Right** (Automatic picks the nearest element in that direction).

**Project Settings > Focus Navigation** turns the system on or off and sets **Navigation Input** (an Input Axis), **Activate Input** (an Input Action), **Repeat Delay** (0.4 s), **Repeat Interval** (0.1 s) and **Wrap Navigation**. Without inputs, the arrow keys, <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>, the D-pad and the left stick move focus, and <kbd>Enter</kbd>, <kbd>Space</kbd> or the bottom face button activates.

Respond with [Event On Focus Enter](../scripting/class/event-on-focus-enter.md), [Event On Focus Leave](../scripting/class/event-on-focus-leave.md) and [Event On Focus Activate](../scripting/class/event-on-focus-activate.md). The **Set Focus** and **Clear Focus** functions move focus from a script.

## Things to know

- In Play, the layer's canvas fills the whole game view. If the screen's shape differs from **Layer Width** × **Layer Height**, the layer stretches to fit.
- Layers draw after the world and its post-processing, so world effects never touch them. In the editor a layer has a black background; in the game it is transparent.
- With **Enable Physics** off, Rigid Bodies stay where scripts put them and no hit or overlap events fire. With it on, bodies in different layers, or in a layer and the world, never collide.
- Physics queries from a layer's scripts, such as [Line Trace](../scripting/class/line-trace.md), only see that layer.

## Related

- [Scene Layer](../assets/scene-layer.md)
- [Input](../input/index.md)
- [Post-Processing](../graphics/post-processing.md)
