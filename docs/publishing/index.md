# Publishing

Export Game packages your project as a web game in a ZIP file, ready for itch.io or any static web host.

## Before you export

1. Set **Project Settings > Game > Startup Scene**. The exported game always starts there, whatever **Start In Open Scene** says.
2. **Save All** (<kbd>Mod</kbd>+<kbd>S</kbd>). Export Game packages the saved project, not unsaved edits in open tabs.
3. Bake each NavMesh your scenes use. Export does not bake navigation.
4. Try a [Preview Build](preview-build.md) to check the packaged game.

## Export the game

1. Open **Project Settings > Export**.
2. Tap **Export Game**.
3. When **Game export prepared. Check your downloads.** appears, find the ZIP, named after the project.

The ZIP has `index.html` at its root. Upload it to itch.io as an HTML game, or unzip it and serve the folder from any static web host.

If the export fails, the reason appears above the **Export Game** button.

## Export settings

| Setting | Description |
| --- | --- |
| Bundle Debugger | Includes debugging tools and Development Only nodes. Off by default. |
| File Count Warn | Warning threshold for the number of files in the export. Default 800. Preview Build logs a warning above it. |
| File Count Fail | File count above which the export fails. Default 1000. |
| Always Package Folders | Folders whose assets always ship, even when nothing references them. Subfolders are included. |

**Export Project** in the same section makes an editable backup of the project instead. See [Projects](../projects/index.md).

## What the game contains

Export includes only what the game can reach:

- the Startup Scene and everything it references, following references from asset to asset;
- the Game Instance class and every subsystem class;
- Input assets and your console command classes;
- everything in **Always Package Folders**.

Every export also includes `legal/THIRD-PARTY-NOTICES.txt`, the licences of the open-source software the game runs on. Keep it when you upload or repackage the game.

Editor-only assets, such as Editor Utility Objects, Plugin Settings and Skybox Creator, never ship. Neither does content from disabled plugins.

::: tip
If a script finds assets at runtime by path, folder or class instead of by reference, add their folder to **Always Package Folders** so they ship.
:::

## Release and debugger builds

| | Release (Bundle Debugger off) | Bundle Debugger on |
| --- | --- | --- |
| Development Only nodes, such as Print and Draw Debug | Left out | Kept |
| Debug-only [console commands](../debugging/console.md) | Unavailable | Available |
| Line Trace debug lines | Never drawn | Drawn when **Draw Debug** is on |
| Stats display | None | Available |
| Infinite Loop Detection | Off | Follows Project Settings |

Your own console commands work in both.

## In this section

- [Preview Build](preview-build.md): test the packaged game inside the editor before you publish.

## Related

- [Settings](../editor/settings.md)
- [Undo and Saving](../editor/undo-and-saving.md)
