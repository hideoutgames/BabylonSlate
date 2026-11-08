# Publishing

**Packaging** builds your project as a game in a ZIP file: a web game ready for itch.io or any static web host, or a desktop game for Windows or Linux.

## Before you package

1. Set **Project Settings > Game > Startup Scene**. The exported game always starts there, whatever **Start In Open Scene** says.
2. **Save All** (<kbd>Mod</kbd>+<kbd>S</kbd>). Packaging uses the saved project, not unsaved edits in open tabs.
3. Bake each NavMesh your scenes use. Packaging does not bake navigation.
4. Try a [Preview Build](preview-build.md) to check the packaged game.

## Package the game

1. In the toolbar, choose **Settings > Packaging** (<kbd>Mod</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd>).
2. In the platform list, select a platform under **Available**. Platforms under **Unavailable** can't be packaged with this copy of Haptic.
3. Check the summary: the output file, **Startup Scene**, **Bundle Debugger** and **Always Package Folders**. If no Startup Scene is set, choose **Game Settings** to set one; **Package** stays unavailable until you do.
4. Choose **Package**.
5. Save the ZIP when Haptic asks (see [Saving exported files](../projects/index.md#saving-exported-files)); in a browser, a message such as **Game package downloaded. Check your downloads.** appears. The ZIP is named after the project, with underscores for spaces, and desktop ZIPs end in `-Windows` or `-Linux`.

The web ZIP has `index.html` at its root. Upload it to itch.io as an HTML game, or unzip it and serve the folder from any static web host. For desktop ZIPs, see [Desktop games](#desktop-games).

If packaging fails, the reason appears in the **Packaging** window.

## Desktop games

Windows and Linux games are the same web game in a desktop player built on Electron, so they look and play as they do in Play. Each ZIP holds one folder named after the project:

| Platform | Start the game with | Notes |
| --- | --- | --- |
| Windows (64-bit) | `<Project Name>.exe` | Unsigned, so Windows SmartScreen may warn on first launch: choose **More info**, then **Run anyway**. |
| Linux (64-bit) | the lowercase command, such as `space-game` | Unzip with a tool that keeps file permissions, such as `unzip`. |

- Keep the whole folder together; the game reads its files from the `resources` folder beside the program.
- The game's saves are stored per project in your user data folder under `Haptic Games`, so renaming the project keeps them.
- The game window cannot open other pages. Links it opens go to the system browser.
- The folder includes the licences of Electron and Chromium (`LICENSE`, `LICENSES.chromium.html`) beside `legal/THIRD-PARTY-NOTICES.txt` in `resources/game`. Keep them when you share the game.
- On Linux distributions that restrict unprivileged user namespaces, such as Ubuntu 24.04, the game can stop at start with a sandbox message. Run `sudo chown root chrome-sandbox && sudo chmod 4755 chrome-sandbox` in the game's folder once.

Which platforms you can package depends on where you run Haptic:

| Haptic | Can package |
| --- | --- |
| Browser, iPad and Android | Web, Windows, Linux |
| Windows and Linux desktop apps | Web, Windows, Linux |
| macOS desktop app | Web, Windows, Linux |

macOS, Android and iOS games are not available yet.

## Packaging settings

These settings are in **Project Settings > Export**, under **Game Packaging** and **Always Package Folders**. **Export Settings** in the **Packaging** window opens them.

| Setting | Description |
| --- | --- |
| Bundle Debugger | Includes debugging tools and Development Only nodes. Off by default. |
| File Count Warn | Warning threshold for the number of files in the export. Default 800. Preview Build logs a warning above it. |
| File Count Fail | File count above which the export fails. Default 1000. |
| Always Package Folders | Folders whose assets always ship, even when nothing references them. Subfolders are included. |

**Export Project**, under **Project Backup** on the same page, makes an editable backup of the project instead. See [Projects](../projects/index.md).

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
