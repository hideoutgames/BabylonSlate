# Settings

Haptic has two kinds of settings: **Engine Settings** belong to the app on this device, and **Project Settings** belong to the project and travel with it.

## Engine Settings or Project Settings

| | Engine Settings | Project Settings |
| --- | --- | --- |
| Applies to | Every project on this device | This project only, on every device |
| Saved | Immediately | With the project, when you choose **Save All** or auto-save runs |
| Examples | Theme, shortcuts, Undo limits, viewport camera speed | Startup scene, rendering, collision layers, export options |

## Open settings

- In the editor, choose **Settings > Project Settings** (<kbd>Mod</kbd>+<kbd>Shift</kbd>+<kbd>,</kbd>) or **Settings > Engine Settings** (<kbd>Mod</kbd>+<kbd>,</kbd>).
- On the Homepage, choose **Engine Settings**.

Use **Search settings** in either window to find a setting by name. Choosing a result opens its page at that setting.

## Engine Settings pages

| Group | Pages |
| --- | --- |
| Editor | Appearance, Undo, Debugger, Viewport, Graph, Assets, Thumbnails, Focus, Keybinds, About |
| Projects | Templates, Engine Plugins, Engine Extensions |

- **Appearance**: **Theme** (System, Light or Dark).
- **Undo**: history limits. See [Undo and Saving](undo-and-saving.md).
- **Debugger**: Play debugging defaults and **Debug Mode**. See [Debugging](../debugging/index.md).
- **Viewport**: **Viewport Frame Cap (FPS)** (default 30), **Camera Speed**, **Drop Distance**, and **Override Project Rendering**, which lets the editor preview use its own resolution and post-processing.
- **Graph**: default zoom and connection helpers for node graphs.
- **Assets**: model import scale, editor texture quality, and texture and audio memory budgets.
- **Thumbnails**: turn Content Browser thumbnails on or off.
- **Focus**: which windows stay visible in Focus. See [Windows and Layout](index.md).
- **Keybinds**: change shortcuts. See [Keyboard Shortcuts](../start/shortcuts.md).
- **About**: version and build. The desktop app also has **Automatic Updates** here.
- **Templates**, **Engine Plugins** and **Engine Extensions**: what new projects start with. See [Plugins](../projects/plugins.md) and [Editor Extensions](../projects/extensions.md).

The Homepage's sun and moon button switches between Light and Dark and changes the same **Theme** setting.

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
