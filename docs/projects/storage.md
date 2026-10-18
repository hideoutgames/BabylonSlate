# Where Projects Live

Each platform keeps projects in the app's own storage by default. In the apps, you can also keep a project in any folder you choose.

## Default storage

The Homepage status bar names the default location for your platform.

| Platform | Location | Notes |
| --- | --- | --- |
| iPad and iPhone | **App Documents** | The app's own folder. It also appears in the Files app as **Haptic** under On My iPad (or On My iPhone). |
| Android | **App Documents** | Private to the app. Other apps cannot see it, and Android's cloud backup does not include it. |
| Mac, Windows and Linux | **Projects Folder** | A folder inside the app's data folder. |
| Web | **Browser Storage** | Kept by this browser on this device. Clearing the browser's site data removes it. |

Projects in default storage reopen from the Homepage without asking for a folder.

::: warning
On Android and the web, nothing else holds a copy of your project. Use **Project Settings > Export > Export Project** regularly to keep a backup. See [Projects](index.md).
:::

## One tab per project

On the web, a project can be open in only one browser tab at a time. If you open it from the Homepage in a second tab, Haptic stays on the Homepage and shows **This project is open in another tab. Close it there and try again.** Editing or deleting the project from another tab is refused the same way.

To open the project in the new tab, choose **Settings > Project Settings > Close Project** in the first tab, or close that tab. Reloading or closing a tab also frees its project, even after a crash. Different projects can be open in different tabs.

## Choose your own folder

In the iPad, iPhone, Android and desktop apps you can keep a project anywhere you can pick a folder, such as iCloud Drive, a Git working copy (for example in Working Copy on iPad) or a folder on your computer.

- **New project:** in **New Project**, open **Options** and set **Location** to **Choose Folder**. You pick the folder when you choose **Create**. Pick an empty folder.
- **Existing project:** on the Homepage, choose **Open** and pick the project's folder (the one containing `project.json`).

The project is edited in place; Haptic does not copy it. It stays on the Homepage list, and Haptic remembers its access to the folder.

On the web, **Open** offers **Import Folder** and **Import ZIP** instead. Both copy the project into browser storage; the original stays as it was.

## Reconnect a folder

If the folder moves, or the system withdraws access, the Homepage shows **Reconnect Project**.

1. Choose **Reconnect**.
2. Pick the same project's folder.

Haptic checks that the folder holds the same project before it reconnects. Picking a different or empty folder keeps the old connection so you can try again.

## Remove or delete a project

From a project card's **Project Actions** menu:

| Platform | Item | Result |
| --- | --- | --- |
| Apps | **Remove From List** | Removes the card. The project files stay on the device. |
| Web | **Delete** | Permanently deletes the project from browser storage. |

The apps never delete project folders. On iPad, iPhone and desktop you can delete a project's folder yourself in the Files app or your file manager.

## Game saves

Saves made while you play in the editor are stored by the app, separately from the project folder. They are not included in project backups. See [Save Games](../scripting/save-games.md).
