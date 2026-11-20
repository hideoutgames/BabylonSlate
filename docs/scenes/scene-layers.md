# Scene Layers

A Scene Layer is a flat 2D overlay that draws on top of the world: a HUD, a pause menu, a title screen. Layers stack, each with its own actors, and they stay put on screen however the world camera moves.

## Create and edit a layer

1. In the **Content Browser**, choose **New Asset > World > Scene Layer**, then double-tap it.
2. The viewport is always 2D and unlit. The orange frame is the layer's design canvas ([Canvas size and scaling](#canvas-size-and-scaling)).
3. Add actors with **+** in the **Outliner**. In a Scene Layer, **Featured** lists only the built-in 2D elements (**2D Panel**, **2D Text**, **2D Button** and the rest), and the **Overlay** category holds them too. You can also drag them from the **Assets** window, which lists the built-in 2D elements first ([Place from the Assets window](actors.md#place-from-the-assets-window)).
4. Select an actor and use the box around it: drag inside to move, drag a handle to resize, drag the knob above it to rotate. For **2D Text**, resizing changes the text box rather than the letters. While the actor's **Scale** is linked in the **Inspector**, resizing keeps its proportions: an edge handle scales the other axis about the box's middle, and a corner keeps the aspect ratio.

With several actors selected, the **Inspector** shows what they all have and edits them together, as in a scene ([Several actors](actors.md#several-actors)).

With nothing selected, the **Inspector** shows the layer's settings:

| Setting | Description |
| --- | --- |
| Name | The layer's display name. |
| Enable Physics | Off by default. When on, each copy of the layer simulates its Rigid Bodies and Colliders in its own 2D world. |
| Tick On Pause | Off by default. When on, every actor in the layer and its Scene Layer Script keep ticking while the game is paused by [Set Game Paused](../scripting/class/set-game-paused.md), whatever the actors' own **Tick On Pause**. Use it for pause menus. |
| Gravity | Gravity for that 2D world. |
| Canvas Size | How big the design canvas is: **Fullscreen** (the default), **Desired** or **Custom**. See [Canvas size and scaling](#canvas-size-and-scaling). |
| Custom Size | Shown for **Custom**: the canvas's width (**W**) and height (**H**) in pixels. Default 400 × 300. |
| Root Pivot | The point of the canvas that sits on the layer's origin (0, 0), and the point of the screen it lines up with in the game. Default **Center**. |
| Canvas Scaling | **Fit To Screen** (the default) or **True Pixel Size**. See [Canvas size and scaling](#canvas-size-and-scaling). |
| Camera Location | Where the layer's camera starts, as an offset from the view the canvas gives it. Default 0, 0. |
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

Sprites, tilemaps, meshes, 3D text, sound, particles, Rigid Bodies, Colliders and Physics Constraints also work on a layer. Lights, cameras, skyboxes, water, fog volumes and Scene Streaming do not.

An actor with a mesh or 3D text can be tilted: its **Inspector** shows Rotation and Scale on X, Y and Z, while Position stays X and Y with **Z-Order**. In the viewport it keeps the 2D box; moving or rotating it there keeps its X and Y tilt.

To script the layer as a whole, set **Scene Mode** to **Script** and edit its [Scene Layer Script](../scripting/scene-scripts.md): each copy of the layer runs it for as long as that copy exists. To script layer elements, make a Class whose parent is **Scene Layer Actor**. Such Classes appear in **Place Actors** only while a Scene Layer is open. A new Scene Layer Actor starts with no components.

In a Scene Layer Actor's **Prefab**, the orange frame shows the space the actor is designed for, and the **Prefab Root** sits on one of its points. The root has no box and does not move; move the components instead. The **Frame** menu on the viewport toolbar sets, as a Scene Layer's canvas does:

| Option | Description |
| --- | --- |
| Fullscreen | The default. The frame is a Fullscreen Scene Layer canvas, so the actor shows at the size it has on a layer. |
| Desired | The frame wraps everything the actor draws, including its child components. |
| Custom | The frame is the size you type in the **W** and **H** fields that appear beside the menu, in pixels. |
| Root Pivot | The point of a Fullscreen or Custom frame that sits on the Prefab Root: one of the corners, edge centres or the centre. Default **Center**. A Desired frame follows the content instead. |

The frame is saved with the Class and only changes the editor view; it does not affect the game. The **2D Scene Layer Actor Switcher** shows one Scene Layer Actor Class at a time from its list; **Initial Index** picks the first one (−1 starts empty), and the **Switch Scene Layer Actor** function changes it.

## Canvas size and scaling

Layer units are pixels divided by **Pixels Per Unit** (**Project Settings > Game > 2D**, default 100), as for [2D Text](../components/2d-text.md) sizes. The canvas size sets how many of them the layer is designed for:

| Canvas Size | The canvas |
| --- | --- |
| Fullscreen | The project's design resolution: **Custom Resolution** (**Project Settings > Rendering**) when it is on, otherwise 1920 × 1080. At 100 Pixels Per Unit a 1920 × 1080 project's canvas is 19.2 × 10.8 layer units, and a 640 × 360 pixel-art project's is 6.4 × 3.6, so a 12 px font is 12 game pixels tall. |
| Desired | The bounds of everything the layer draws. The orange frame wraps the content, and the game measures it again whenever the content moves, changes size, appears or disappears. With nothing to draw, it is the Fullscreen canvas. |
| Custom | **Custom Size** in pixels. |

**Root Pivot** picks which point of a Fullscreen or Custom canvas sits on the layer's origin: with **Top Left**, an actor at 0, 0 is at the canvas's top left corner and the canvas extends right and down. A Desired canvas stays where its content is.

In the game, **Canvas Scaling** decides how the canvas reaches the screen:

| Canvas Scaling | In the game |
| --- | --- |
| Fit To Screen | The canvas is scaled to fill the screen without stretching. When the screen's shape differs from the canvas, the extra space appears at the sides (or top and bottom), and the **Root Pivot** says where: with **Center** the canvas is centred, with **Top Left** it stays in the top left corner. |
| True Pixel Size | The canvas shows at its own size, one canvas pixel per pixel of the design resolution, with its **Root Pivot** at the same point of the screen: **Center** puts it in the middle of the screen, **Top Right** in the top right corner. A 400 × 300 Custom canvas covers 400 × 300 game pixels, whatever the screen size. |

A Fullscreen canvas always fills the screen at one canvas pixel per design pixel, so both scalings show it the same way. On a high-density screen, or a window larger than the design resolution, a pixel means a pixel of the design resolution scaled to the window, not a device pixel. With Custom Resolution, **Pixelated** upscaling and no **Black Bars**, the extra rows and columns the view gains show more of the layer, at the same size.

## Show a layer in the game

- **With a scene**: in the scene's **Scene Settings**, tap **Add Layer** under **Scene Layers**, pick the asset, and set **Z-Order**. While its switch is on, the layer appears when the scene loads and goes away when the scene unloads.
- **From a script**: [Create Scene Layer](../scripting/class/create-scene-layer.md) adds a layer and returns it. It stays across [Change Scene](../scripting/class/change-scene.md) until [Remove Scene Layer](../scripting/class/remove-scene-layer.md) or [Clear Scene Layer](../scripting/class/clear-scene-layer.md).

Layers with a higher **Z-Order** draw on top. The same asset can be shown more than once. Add effects to a live layer with [Register Scene Layer Post-Processing](../scripting/class/register-scene-layer-post-processing.md).

## Move the layer camera

Each layer shown in the game has its own 2D **Layer Camera**, separate from the scene's camera and from other layers. It starts centred on **Camera Location** at its normal size; scripts can pan, turn and zoom it, for example to scroll a map or a level-select screen.

Get it with **Get Layer Camera**: on the layer in its own script, on one of its **Scene Layer Actors** (their own layer's camera), or on the layer that [Create Scene Layer](../scripting/class/create-scene-layer.md) returns. The [Scene Camera Manager](../scripting/class/get-scene-camera-manager.md) never returns a layer's camera.

| To | Use, on the Layer Camera |
| --- | --- |
| Pan | **Set Camera Location**, **Add Camera Offset**, [Tween Layer Camera Location](../scripting/class/tween-layer-camera-location.md) |
| Turn | **Set Camera Rotation**, [Tween Layer Camera Rotation](../scripting/class/tween-layer-camera-rotation.md) |
| Zoom | **Set Camera Zoom**, [Tween Layer Camera Zoom](../scripting/class/tween-layer-camera-zoom.md) |
| Read it | **Get Camera Location**, **Get Camera Rotation**, **Get Camera Zoom** |

The members work as for the scene's own camera; see [Script the camera](../graphics/cameras.md#script-the-camera).

- Everything on the layer moves with its camera, including actors with a [2D Anchor](../components/2d-anchor.md). Anchors place content around the design canvas whatever **Camera Location** is. To keep a HUD still over a moving layer, put the HUD on another layer with a higher **Z-Order**.
- Taps, buttons, scroll boxes, form controls, joysticks and [Project Cursor To Scene](../scripting/class/project-cursor-to-scene.md) follow the moved, turned or zoomed view.
- While the camera is turned, a [2D Scroll Box](../components/2d-scroll-box.md) or [2D Mask](../components/2d-mask.md) clips to the smallest upright rectangle on screen that contains it.
- The moved camera is not saved. Every layer starts again at **Camera Location** each time it is shown, and a Scene Layer open in the editor always shows that starting view.
- Once the layer is removed, its Layer Camera is no longer valid.

## Buttons and pointer events

An actor receives pointer events only after you add a **2D Button** to it. It then gets [Event On Click](../scripting/class/event-on-click.md), [Event On Press Start](../scripting/class/event-on-press-start.md), [Event On Press End](../scripting/class/event-on-press-end.md), [Event On Mouse Enter](../scripting/class/event-on-mouse-enter.md) and [Event On Mouse Leave](../scripting/class/event-on-mouse-leave.md). These fire for touch as well as the mouse. The button uses the actor's visual (a 2D Texture, Panel or Text, for example) as its tap area.

## Keyboard and gamepad focus

**2D Button** and the form controls can take focus; add **2D Focus Target** to make anything else focusable. Each one has **Focus Enabled**, **Initial Focus** and **Focus Up**, **Focus Down**, **Focus Left** and **Focus Right** (Automatic picks the nearest element in that direction).

**Project Settings > Focus Navigation** turns the system on or off and sets **Navigation Input** (an Input Axis), **Activate Input** (an Input Action), **Repeat Delay** (0.4 s), **Repeat Interval** (0.1 s) and **Wrap Navigation**. Without inputs, the arrow keys, <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>, the D-pad and the left stick move focus, and <kbd>Enter</kbd>, <kbd>Space</kbd> or the bottom face button activates.

Respond with [Event On Focus Enter](../scripting/class/event-on-focus-enter.md), [Event On Focus Leave](../scripting/class/event-on-focus-leave.md) and [Event On Focus Activate](../scripting/class/event-on-focus-activate.md). The **Set Focus** and **Clear Focus** functions move focus from a script.

## Things to know

- In Play, the layer is never stretched. If the screen's shape differs from the canvas, such as on an ultra-wide monitor, the layer keeps its proportions and the extra space appears beside the canvas ([Canvas size and scaling](#canvas-size-and-scaling)). Add a [2D Anchor](../components/2d-anchor.md) to keep an element at a screen edge or corner of the default view.
- Layers draw after the world and its post-processing, so world effects never touch them. In the editor a layer has a neutral mid grey background; in the game it is transparent.
- A layer with **Post Processing** blends its elements over what is beneath it just as a layer without: translucent edges, Additive glows and soft shadows look the same either way. A **Multiply** Material is the exception: on such a layer it only darkens, by the brightness of its colour ([Multiply on Scene Layers](../assets/material.md#multiply-on-scene-layers)).
- Layers always draw at full quality: at the screen's full device resolution, with full texture detail, full model detail and full-resolution post-processing. [Scalability](../graphics/index.md#scalability) and the render scale change only the world behind them.
- A layer combines its elements into fewer draw calls without changing how it looks: elements that draw the same texture or the same Material share a draw call when nothing drawn between them overlaps them, whatever their position, rotation, scale, color, tint and opacity. Images up to 256 pixels on each side count as one texture, so icons, panels and sprites of different small images share a draw call too. The characters of a text share one as well, also when the text uses a Text Material. A mirrored element (a negative scale on one axis) and an element whose Material moves its vertices always draw on their own. The [Profiler](../debugging/profiler.md) can show far fewer draw calls for a layer than it has elements.
- With **Enable Physics** off, Rigid Bodies stay where scripts put them and no hit or overlap events fire. With it on, bodies in different layers, or in a layer and the world, never collide.
- Physics queries from a layer's scripts, such as [Line Trace](../scripting/class/line-trace.md), only see that layer.

## Related

- [Scene Layer](../assets/scene-layer.md)
- [Input](../input/index.md)
- [Post-Processing](../graphics/post-processing.md)
