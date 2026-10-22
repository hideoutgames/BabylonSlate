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

Use **Search settings** in either window to find a setting by name. Choosing a result opens its page at that setting.

## Engine Settings pages

| Group | Pages |
| --- | --- |
| Editor | Undo, Debugger, Viewport, Graph, Assets, Thumbnails, Focus, Keybinds, Interface, About |
| Projects | Templates, Engine Plugins, Engine Extensions |

- **Undo**: history limits. See [Undo and Saving](undo-and-saving.md).
- **Debugger**: Play debugging defaults and **Debug Mode**. See [Debugging](../debugging/index.md).
- **Viewport**: **Viewport Frame Cap (FPS)** (default 30), **Camera Speed**, **Drop Distance**, and **Override Project Rendering**, which lets the editor preview use its own resolution and post-processing.
- **Graph**: default zoom and connection helpers for node graphs.
- **Assets**: model import scale, editor texture quality, and texture and audio memory budgets.
- **Thumbnails**: turn Content Browser thumbnails on or off.
- **Focus**: which windows stay visible in Focus. See [Windows and Layout](index.md).
- **Keybinds**: change shortcuts. See [Keyboard Shortcuts](../start/shortcuts.md).
- **Interface**: **Compact Mode**. See [Compact Mode](#compact-mode).
- **About**: version and build. The desktop app also has **Automatic Updates** here.
- **Templates**, **Engine Plugins** and **Engine Extensions**: what new projects start with. See [Plugins](../projects/plugins.md) and [Editor Extensions](../projects/extensions.md).

## Theme

Choose the editor's colors in **Manage Account > Application** on the Homepage, under **Theme**. Themes belong to this device, like Engine Settings.

- The preview at the top shows how the editor looks with the selected theme. It is a picture only; you can't click it.
- Pick a theme from the list below the preview. **Default** is the built-in dark theme.
- Open **Style** to see the color of every part of the editor, grouped into surfaces, text, accents, status, graph, pin and asset type colors.
- Built-in themes can't be changed. Changing a color while a built-in theme is selected creates a custom theme from it, such as **Default Copy**, and selects it. Later changes edit that custom theme.
- Custom themes have **Rename** and **Delete**. Deleting the selected theme switches the editor back to **Default**.
- **Export Theme** saves the selected theme as a `.haptic-theme.json` file. **Import Theme** adds a theme file as a new custom theme and selects it. Colors the file leaves out use **Default**'s colors.

## Compact Mode

**Compact Mode** sets how large the editor's controls are on this device.

- **On**: small buttons, menus and list rows for a mouse, trackpad or keyboard.
- **Off**: the touch layout, with larger buttons, menu items and rows that are easy to tap.

It is on by default everywhere except on iPhone, iPad and Android. Change it under **Engine Settings > Interface**, or in **Manage Account > Application** on the Homepage. The editor updates as soon as you switch it.

Compact Mode changes only sizes. Touch gestures, such as holding to open a menu or to drag, work in both modes.

## Third-party notices

Haptic is built with open-source software. To read the licences, open **Manage Account > Application** on the Homepage and choose **Third-Party Notices** at the bottom of the page.

- Each row names a package, its version and its licence. Tap a row to read the licence text.
- Rows marked **In Games** also ship in the games you export. Every exported game includes their notices in `legal/THIRD-PARTY-NOTICES.txt`.
- **Application** at the top returns to the Application page.

## Project Settings pages

| Page | Covers |
| --- | --- |
| General | Project version, Compile On Save, infinite loop detection, Auto-Save Interval, Editor Utility Objects |
| Game | Startup Scene, Game Instance, 2D pixels per unit and sorting layers |
| Save Games | Default save definition, slot and profile; preview saves |
| Physics | Collision layers |
| Focus Navigation | Keyboard and gamepad focus for Scene Layers |
| Fonts | Default font and fallbacks |
| Audio | Audio Mixer, occlusion and reverb |
| Rendering | Render mode, quality, shadows, environment, post-processing, resolution, water and Play preview |
| Textures | Retry failed texture compression |
| Plugins | Enable, create and import plugins |
| Project Extensions | Editor tools in this project |
| Export | Export Game, Export Project and export options |
| Source Control | Git LFS file locking. Desktop and mobile apps only. |

Each topic's guide covers its settings: for example [Graphics](../graphics/index.md), [Collision](../physics/collision.md), [Save Games](../scripting/save-games.md), [Publishing](../publishing/index.md) and [Source Control](../projects/source-control.md).

**Close Project** is at the bottom of the Project Settings window.
