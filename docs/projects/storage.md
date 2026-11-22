# Where Projects Live

Each platform keeps projects in the app's own storage by default. In the apps, you can also keep a project in any folder you choose.

## Default storage

The Homepage status bar names the default location for your platform.

| Platform | Location | Notes |
| --- | --- | --- |
| iPad and iPhone | **App Documents** | The app's own folder. It also appears in the Files app as **Haptic** under On My iPad (or On My iPhone), with your projects in its **Projects** folder. |
| Android | **App Documents** | Private to the app. Other apps cannot see it, and Android's cloud backup does not include it. |
| Mac, Windows and Linux | **Projects Folder** | A folder inside the app's data folder. |
| Web | **Browser Storage** | Kept by this browser on this device. Clearing the browser's site data removes it. |

Projects in default storage reopen from the Homepage without asking for a folder.

Haptic's own working data, such as thumbnails and crash recovery, is kept separately from your projects. On iPad and iPhone it does not appear in the Files app, and on iPad, iPhone and Android it is not included in device backups.

::: warning
On Android and the web, nothing else holds a copy of your project. Use **Project Settings > Export > Export Project** regularly to keep a backup. See [Projects](index.md).
:::

## One tab per project

On the web, a project can be open in only one browser tab at a time. If you open it from the Homepage in a second tab, Haptic stays on the Homepage and shows **This project is open in another tab. Close it there and try again.** Editing or deleting the project from another tab is refused the same way.

To open the project in the new tab, choose **Settings > Project Browser** in the first tab, or close that tab. Reloading or closing a tab also frees its project, even after a crash. Different projects can be open in different tabs.

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

## Unused storage

Large asset data, such as Texture pixels and Model meshes, is stored in its own files beside the assets. When you change or delete an asset, data no asset uses any more stays behind until Haptic cleans it up:

- On iPad, Android and the web, Haptic cleans it up on its own shortly after a project opens.
- On desktop, and for a folder you chose yourself, choose **Project Settings > General > Clean Unused Project Storage**. Close the project in other windows and apps first. You can keep working and saving while it runs, and it says what it removed.

Haptic removes nothing that any asset uses, nothing changed in the last minute, and nothing while an asset can't be read. With Source Control on, or in a Git folder, Git keeps this data: use **Remove Unused Files** in the Source Control tab instead ([Source Control](source-control.md#remove-unused-files)).

## Remove or delete a project

From a project card's **Project Actions** menu:

| Project | Item | Result |
| --- | --- | --- |
| In default storage | **Delete** | Permanently deletes the project and its files. You confirm first. |
| In a folder you chose | **Remove From List** | Removes the card. Haptic never deletes a folder you chose; its files stay where they are. |

Deleting can't be undone: the project does not go to the Trash or Recently Deleted. Export the project first if you might want it back.

On iPad, iPhone and desktop you can also delete a project's folder yourself in the Files app or your file manager. Its card leaves the project list when you return to Haptic. A project in a folder you chose yourself keeps its card, because Haptic can't check that folder until you open it.

### Delete several projects

1. Choose **Select** beside **Sort** and **View**, or **Select Project** in a card's **Project Actions** menu.
2. Tap each project to delete, or choose **Select All**.
3. Choose **Delete**.
4. Check the list, type **delete my projects** and choose **Delete**.

The dialog lists every project it deletes. Selected projects in a folder you chose are listed under **Can't Be Deleted** and stay as they are; use **Remove From List** on their cards instead.

## Game saves

Saves made while you play in the editor are stored by the app, separately from the project folder. They are not included in project backups. See [Save Games](../scripting/save-games.md).
