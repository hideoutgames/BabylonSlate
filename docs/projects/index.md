# Projects

A Haptic project is an ordinary folder that holds your game's settings and assets. You can back it up as a single ZIP, move it between devices, and share it with a team through Git.

## The project folder

| Item | Contains |
| --- | --- |
| `project.json` | The project's name and Project Settings. |
| `assets/` | Every asset, one `.babasset` file each, in the same folders the Content Browser shows. |
| `plugins/` | The project's [plugins](plugins.md). |
| `extensions/` | The project's [editor extensions](extensions.md). |

Haptic names the folder after the project when you create it. Create, rename and move assets in the Content Browser rather than in a file manager; it keeps references, open documents and [locks](source-control.md) up to date.

Thumbnails, compiled scripts and other caches are kept by the app outside the project folder and rebuilt when needed.

## Back up a project

1. Choose **Save All**. The backup uses the saved version of each document.
2. Open **Project Settings > Export** and choose **Export Project**.
3. Haptic prepares a ZIP of the whole project and downloads it.

The backup includes every plugin and extension in the project, even disabled ones. It does not include game saves made in the editor.

::: tip
**Export Project** makes an editable copy of the project. To make a playable game, use **Export Game** instead. See [Publishing](../publishing/index.md).
:::

## Import a project

| Platform | How |
| --- | --- |
| Web | On the Homepage, choose **Open > Import ZIP** (up to 50 MB) or **Open > Import Folder** (up to 200 MB). Haptic copies the project into browser storage. If a project with that name exists, the copy gets a number. |
| iPad, iPhone, Android and desktop | Unzip the backup, then choose **Open** on the Homepage and pick the folder. |

You can also turn a backup into a template: choose **Add Template** in the template list and pick the ZIP (up to 50 MB). New projects can then start from it.

## In this section

- [Where Projects Live](storage.md): default storage on each platform, your own folders and reconnecting.
- [Plugins](plugins.md): bundles of assets and Classes you can enable per project.
- [Editor Extensions](extensions.md): code tools that run in the editor.
- [Source Control](source-control.md): Git LFS file locking for teams.
