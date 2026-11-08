# Extensions

Extensions are small JavaScript or TypeScript packages. Every extension can add editor commands that read and create assets and project code. An extension with **Editor Only** turned off also adds a game library and content to Play and packaged games.

For editor tools built with visual scripting instead of code, see [Editor Scripting](../scripting/editor-scripting.md).

## Engine and Project extensions

| Kind | Where | Notes |
| --- | --- | --- |
| Project extensions | **Project Settings > Project Extensions** | Live in the project. You can edit, enable and export them. |
| Engine extensions | **Engine Settings > Engine Extensions** | Copied into every new project. Existing projects keep their own copies. |

## Use an extension

1. Open **Project Settings > Project Extensions**.
2. Turn on **Enable** for the extension. Haptic asks you to confirm, because its code can change your project's assets and code, and a gameplay extension's code also runs in your game. Enable only code you trust.
3. The extension's commands appear as buttons in its row. Choose one, fill in the fields and run it.

Rows also show **Experimental**, **Beta** and **Gameplay** badges, the version, dependencies and any errors. An extension whose dependency is missing, disabled or circular does not start.

## GLSL to Material

**GLSL to Material** is a bundled, Experimental extension, off by default. Its command converts fragment shader code into an editable Material.

1. Enable **GLSL to Material**, then choose its **GLSL to Material** command.
2. Enter a **Material Name** and the **GLSL Source**. Optionally name the variables to bind as **UV Variable** and **Time Variable**.
3. Run the command. The new Material appears in the Content Browser.

Unsupported code is reported before anything is created. See [Materials](../graphics/materials.md).

## Create an extension

1. In **Project Settings > Project Extensions**, choose **New Extension**.
2. Enter a **Display Name** and choose **Create**. **Edit Extension** opens.
3. Fill in the fields and write the code under **Entry Source**, then choose **Save**. Saving reloads enabled extensions.

| Field | Description |
| --- | --- |
| Extension ID | Permanent ID. Read-only. |
| Display Name, Version, Author, Category, Description, Icon | How the extension is listed. |
| Experimental, Beta | Maturity badges. |
| Enabled By Default | Whether new projects turn it on. |
| Editor Only | On by default. Turn it off to add a game library and content to Play and packaged games. See [Gameplay extensions](#gameplay-extensions). |
| Library Name | Shown when Editor Only is off. The name games use to reach the game library. |
| Appear In Content Browser | Shown when Editor Only is off, and off by default. Shows the extension's content folder in the Content Browser. |
| Extension Dependencies | Other extensions it needs. |
| Code Files | Chooses the file the code editor shows. **New Code File** and **Add Code File** add files; **Remove Code File** removes an added file. |

### Code files

Each extension is a folder in the project's `extensions` folder:

| File or folder | Holds |
| --- | --- |
| `extension.json` | The settings above. |
| `index.ts` | The editor entry. |
| `game.ts` | The game entry, for gameplay extensions. Haptic creates it when you turn Editor Only off and save. |
| `code/` | Files you create with **New Code File** or add with **Add Code File**. |
| `assets/` | Content for gameplay extensions. |

You can edit code files in the **Edit Extension** dialog or open the folder in another code editor. Haptic reads the files again when it reloads extensions, when Play starts and when you export.

Files import each other with relative paths, such as `import { clamp } from "./code/math";`. You can leave out `.ts` and `.js`, and import a folder's `index` file by the folder name. Imports of packages or of files outside the extension are not supported. Type-only imports are ignored, so they can name anything.

### Writing the code

The editor entry exports an `activate(api)` function. It can be `async` and can return a cleanup function that runs when the extension stops. TypeScript is accepted without type checking. Dynamic `import()` is not supported.

| API | Use |
| --- | --- |
| `api.registerCommand({ id, title, description, fields, execute })` | Add a command button. `fields` are `text` or `multiline` inputs; `execute(values)` receives their text. |
| `api.assets.list()` | List the project's assets. |
| `api.assets.read(path)` | Read an asset document. |
| `api.assets.create(path, { type, name, payload })` | Create an asset under `assets/`. Fails if the path exists. |
| `api.assets.update(path, document)` | Change an asset. Close its tab first. |
| `api.code.read(path)` / `api.code.write(path, source)` | Read or write `.ts` and `.js` files under `code/`. |
| `api.materials.convertGlsl(source, options)` | Convert GLSL to a Material document without saving it. |
| `api.log(message)` | Write a message to the editor's diagnostics. |

```js
export function activate(api) {
  api.registerCommand({
    id: "count-assets",
    title: "Count Assets",
    async execute() {
      const assets = await api.assets.list();
      api.log(`This project has ${assets.length} assets.`);
    },
  });
}
```

Extensions run as trusted code, not in a sandbox. Disabling an extension, editing it or closing the project stops it and removes its commands.

## Gameplay extensions

Turn off **Editor Only** to make a gameplay extension. While it is enabled:

- Its game entry loads before your game's scripts in Play, Preview Build and packaged games.
- Everything the game entry exports becomes its game library. [Execute JavaScript](../scripting/javascript.md) nodes call it as `extensions.<Library Name>`.
- Its `assets` folder joins the project's content. You can use those assets in pickers, scenes and scripts, and the game packs the ones it reaches, as it does with project assets.

A game entry for an extension with the Library Name `weather`:

```js
export function rainChance(humidity) {
  return Math.min(1, humidity / 80);
}
```

An Execute JavaScript node with the input **humidity** and the output **chance** calls it:

```js
chance = extensions.weather.rainChance(humidity);
```

- Libraries load after the extensions they depend on. A game entry can use those libraries through `extensions` too.
- A syntax error or an import that cannot be found stops Play and export, naming the file and line.
- Two enabled gameplay extensions cannot share a Library Name. Play and export stop and name them.
- A library that fails to load is reported in the session report, and the game runs without it.
- The game entry runs in the game, not the editor, so it has no `api`.
- **Appear In Content Browser** shows the extension's content folder in the Content Browser tree, whatever **Show Plugin Content** says. Turn it on to browse, create and import assets there.

## Share extensions

- **Export** offers **Export To File** (a `.hextension` file, saved as in [Saving exported files](index.md#saving-exported-files)) and **Export To Engine Extensions**. Both include every code file and the content folder.
- **Import Extension** adds a `.hextension` file. Imported extensions stay disabled until you enable them. Replacing an installed extension asks first.
- Packages are limited to 64 MiB compressed, 256 MiB expanded and 4,096 files, and each code file to 1 MiB.

Extensions are saved in the project folder, so project backups include them. Assets an extension creates are ordinary project assets.
