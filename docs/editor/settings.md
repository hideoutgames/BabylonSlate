# Settings

Haptic has two kinds of settings: **Engine Settings** belong to the app on this device, and **Project Settings** belong to the project and travel with it.

## Engine Settings or Project Settings

| | Engine Settings | Project Settings |
| --- | --- | --- |
| Applies to | Every project on this device | This project only, on every device |
| Saved | Immediately | With the project, when you choose **Save All** or auto-save runs |
| Examples | Shortcuts, Undo limits, viewport camera speed | Startup scene, rendering, collision layers, export options |

## Open settings

- In the editor, choose **Settings > Project Settings** (<kbd>Mod</kbd>+<kbd>Shift</kbd>+<kbd>,</kbd>) or **Settings > Engine Settings** (<kbd>Mod</kbd>+<kbd>,</kbd>).
- On the Homepage, open the account menu at the bottom of the sidebar and choose **Engine Settings**.

Use **Search settings** in either window to find a setting by name. Each result shows its page and sub-category, such as **Rendering › Shadows**. Choosing a result opens that page and sub-category at the setting.

## Sub-categories

Every page groups its settings into sub-categories, such as **Shadows** and **Post Processing** on **Rendering**.

- Sub-categories start open. Select a sub-category's header to collapse or expand it.
- Haptic remembers the sub-categories you collapse, separately for each page, on this device.
- **Collapse All** and **Expand All**, beside the page title, fold or unfold every sub-category on the page.
- A setting that depends on the one above it is indented under it and is unavailable while that setting is off.

## Engine Settings pages

| Group | Pages |
| --- | --- |
| Editor | Undo, Debugger, Viewport, Graph, Assets, Thumbnails, Focus, Keybinds, Interface, Accessibility, About |
| Projects | Templates, Engine Plugins, Engine Extensions, Packaging |

- **Undo**: history limits. See [Undo and Saving](undo-and-saving.md).
- **Debugger**: Play debugging defaults and **Debug Mode**. See [Debugging](../debugging/index.md).
- **Viewport**: **Viewport Frame Cap (FPS)** (default 60), **Camera Preview Frame Rate (FPS)** for the preview of a selected Camera or Render Target Capture (default 30), **Camera Speed**, **Drop Distance**, **Place On Surfaces** with its **Placement Trace Distance** (new actors land on the surface in front of the camera within that many units, default 25), **Stack New 2D Actors** (**Disabled**, **Scenes Only**, **Scene Layers Only** or **Both**: new actors there go one Z-Order above the highest actor that draws; see [Draw order](../2d/index.md#draw-order)), **Occlusion Culling**, which skips objects hidden behind solid shapes in Scene viewports (default on; Play and exported games follow the project's Scalability setting), and **Override Project Rendering**, which lets the editor preview use its own resolution and post-processing.
- **Graph**: default zoom, **Read-Only Pin Defaults** and **Add Node History** for node graphs. See [Scripting](../scripting/index.md#add-a-node).
- **Assets**: model import scale, editor texture quality, and texture and audio memory budgets.
- **Thumbnails**: turn Content Browser thumbnails on or off.
- **Focus**: which windows stay visible in Focus. See [Windows and Layout](index.md).
- **Keybinds**: change shortcuts. See [Keyboard Shortcuts](../start/shortcuts.md).
- **Interface**: **Compact Mode**. See [Compact Mode](#compact-mode).
- **Accessibility**: text size, motion, touch and timing, number dragging, and graph pin and connection options. See [Accessibility](#accessibility).
- **About**: version and build. The desktop app also has **Automatic Updates** here.
- **Templates**, **Engine Plugins** and **Engine Extensions**: what new projects start with. See [Plugins](../projects/plugins.md) and [Extensions](../projects/extensions.md).
- **Packaging**: how the desktop app on a Mac signs and notarizes macOS games. See [macOS games](../publishing/index.md#macos-games).

## Theme

Choose the editor's colors in **Manage Account > Application** on the Homepage, under **Theme**. Themes belong to this device, like Engine Settings.

- The preview at the top shows how the editor looks with the selected theme. It is a picture only; you can't click it.
- Pick a theme from the list below the preview. **Haptic Dark** is the default. The other built-in themes are **Haptic White** and ports of popular color schemes: **Dracula**, **Nord**, **One Dark**, **Monokai**, **Solarized Light** and **Catppuccin Mocha**.
- Open **Style** to see the color of every part of the editor, grouped into surfaces, text, accents, status, graph, pin, asset type and platform colors.
- Built-in themes can't be changed. Changing a color while a built-in theme is selected creates a custom theme from it, such as **Haptic Dark Copy**, and selects it. Later changes edit that custom theme.
- Custom themes have **Rename** and **Delete**. Deleting the selected theme switches the editor back to **Haptic Dark**.
- **Export Theme** saves the selected theme as a `.haptic-theme.json` file: through the share sheet on iPad and iPhone, a save dialog in the desktop and Android apps, or a download in other browsers. See [Saving exported files](../projects/index.md#saving-exported-files). **Import Theme** adds a theme file as a new custom theme and selects it. Colors the file leaves out use **Haptic Dark**'s colors.

## Compact Mode

**Compact Mode** sets how large the editor's controls are on this device.

- **On**: small buttons, menus and list rows for a mouse, trackpad or keyboard.
- **Off**: the touch layout, with larger buttons, menu items and rows that are easy to tap.

It is on by default everywhere except on iPhone, iPad and Android. Change it under **Engine Settings > Interface**, or in **Manage Account > Application** on the Homepage. The editor updates as soon as you switch it.

Compact Mode changes only sizes. Touch gestures, such as holding to open a menu or to drag, work in both modes.

## Accessibility

**Engine Settings > Accessibility** makes the editor easier to read and operate. Like other Engine Settings, these apply on this device only.

**Display**

- **Text Size** (default 100%): scales text, and the spacing around it, from 50% to 150%. Dragging the slider shows the new size and applies it when you let go. A few small fixed-size labels keep their size, and the viewport is unchanged.
- **Reduce Motion** (default **System**): **On** turns off non-essential animation, such as menus, dialogs and tab transitions sliding or fading, and graph run highlights fading. **Off** keeps animation even when the device asks for less. **System** follows the device's reduced motion setting.

**Touch And Input**

- **Touch Target Size** (default 1×): enlarges the buttons, rows and pins you tap in the touch layout (see [Compact Mode](#compact-mode)), from 1× to 2×. Graph pins use it with a mouse too.
- **Hold Time** (default 500 ms): how long to hold before a menu opens, from 300 to 1500 ms. Holding to drag, such as reordering a tree row or drawing a selection rectangle in a graph, starts at half of it. Tab headers keep the device's own hold to drag.
- **Double-Tap Time** (default 350 ms): the longest gap between two taps that still counts as a double-tap, from 200 to 1000 ms. Double-clicking with a mouse follows the device's own setting.
- **Number Snap Strength** (default **Normal**): how long dragging a number field pauses on round values, such as 0.1, 0.25, 1, 10 and 100. **Off**, **Light**, **Normal** or **Strong**.

**Graph Pins**

These apply to every graph editor: Class, Material, Animation Graph, Behaviour Tree and Particle Graph.

- **Tap To Connect Pins** (default off): tap a pin, then a pin on the other side, to connect them. Either side can go first. Tap the first pin again to cancel, or tap another pin on the same side to choose it instead. Dragging from one pin to another works either way.
- **Large Pins** (default 1×): a slider from 1× to 2×, in steps of 0.1×, that enlarges every pin, the area you can tap or click around it, and the wires between pins. Nodes grow to fit.
- **Pin Type Letters** (default off): shows a short type name inside every data pin, so types do not rely on colour: **B** Boolean, **I** Integer, **F** Float, **S** String, **V2**, **V3** and **V4** vectors, **R** Rotator, **Q** Quaternion, **T** Transform, **C** Color, **O** Object, **Cl** Class, **A** Asset, **Tx** Texture, **St** Structure, **E** Enum, **Tg** Tag, **D** Delegate, **P** Particle and **?** Wildcard. Array and Map pins show their item type.

**Graph Nodes**

- **Snapped Nodes** (default off): a node moves freely while you drag it and snaps to a grid when you let go, so nodes line up. **Snap Grid Size (Pixels)** (default 32, up to 200) sets the grid, measured at 100% zoom.

**Graph Connections**

- **Node Connection Assistant** (default on): when you move a node near another, previews wires to their free matching pins and connects them when you let go. **Connection Distance (Pixels)** (default 48) sets how near.
- **Shake Nodes To Disconnect** (default on): shaking a node back and forth while dragging it breaks all its wires. Turn it off if a tremor or an unsteady hand disconnects nodes by accident.

## Third-party notices

Haptic is built with open-source software. To read the licences, open **Manage Account > Application** on the Homepage and choose **Third-Party Notices** at the bottom of the page.

- Each row names a package, its version and its licence. Tap a row to read the licence text.
- Rows marked **In Games** also ship in the games you export. Every exported game includes their notices in `legal/THIRD-PARTY-NOTICES.txt`.
- **Application** at the top returns to the Application page.

## Project Settings pages

| Group | Page | Covers |
| --- | --- | --- |
| Project | General | Project version, Auto-Save Interval, Compile On Save, infinite loop detection, Garbage Collection Interval, Editor Utility Objects |
| Project | Source Control | Git LFS file locking. Desktop and mobile apps only. |
| Project | Export | What a game package includes, the App Identity of native apps, and Export Project |
| Gameplay | Game | Startup Scene, Game Instance, 2D pixels per unit and sorting layers |
| Gameplay | Save Games | Default save definition, slot and profile; preview saves |
| Gameplay | Physics | Collision layers and presets |
| Gameplay | Focus Navigation | Keyboard and gamepad focus for Scene Layers |
| Graphics & Audio | Rendering | GPU backend and render mode, scalability, shadows, environment, post-processing, resolution, water and Play preview |
| Graphics & Audio | Textures | Retry failed texture compression |
| Graphics & Audio | Fonts | Default font and fallbacks |
| Graphics & Audio | Audio | Audio Mixer, occlusion and reverb |
| Miscellaneous | Extension categories | Settings an enabled extension adds, under the name it chooses. See [Extensions](../projects/extensions.md#project-settings). The group shows only when an enabled extension adds one. |
| Plugins & Extensions | Plugins | Enable, create and import plugins |
| Plugins & Extensions | Project Extensions | Editor tools and game libraries in this project |

Each topic's guide covers its settings: for example [Graphics](../graphics/index.md), [Collision](../physics/collision.md), [Save Games](../scripting/save-games.md), [Publishing](../publishing/index.md) and [Source Control](../projects/source-control.md).

To build a playable copy of your game, choose **Settings > Packaging** in the toolbar (<kbd>Mod</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd>). See [Publishing](../publishing/index.md).

To close the project and return to the Homepage, choose **Settings > Project Browser** in the toolbar.
