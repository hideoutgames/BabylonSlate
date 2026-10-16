# Editor Extensions

Editor extensions are small JavaScript or TypeScript tools that run inside the editor. They add commands that read and create assets and project code. They never run in your game.

For editor tools built with visual scripting instead of code, see [Editor Scripting](../scripting/editor-scripting.md).

## Engine and Project extensions

| Kind | Where | Notes |
| --- | --- | --- |
| Project extensions | **Project Settings > Project Extensions** | Live in the project. You can edit, enable and export them. |
| Engine extensions | **Engine Settings > Engine Extensions** | Copied into every new project. Existing projects keep their own copies. |

## Use an extension

1. Open **Project Settings > Project Extensions**.
2. Turn on **Enable** for the extension. Haptic asks you to confirm, because its code can change your project's assets and code. Enable only code you trust.
3. The extension's commands appear as buttons in its row. Choose one, fill in the fields and run it.

Rows also show **Experimental** or **Beta** badges, the version, dependencies and any errors. An extension whose dependency is missing, disabled or circular does not start.

## GLSL to Material

**GLSL to Material** is a bundled, Experimental extension, off by default. Its command converts fragment shader code into an editable Material.

1. Enable **GLSL to Material**, then choose its **GLSL to Material** command.
2. Enter a **Material Name** and the **GLSL Source**. Optionally name the variables to bind as **UV Variable** and **Time Variable**.
3. Run the command. The new Material appears in the Content Browser.

Unsupported code is reported before anything is created. See [Materials](../graphics/materials.md).

## Create an extension

1. In **Project Settings > Project Extensions**, choose **New Extension**.
2. Enter a **Display Name** and choose **Create**. **Edit Extension** opens.
3. Fill in the details and write the code under **Entry Source**, then choose **Save**. Saving reloads enabled extensions.

| Field | Description |
| --- | --- |
| Extension ID | Permanent ID. Read-only. |
| Display Name, Version, Author, Category, Description, Icon | How the extension is listed. |
| Experimental, Beta | Maturity badges. |
| Enabled By Default | Whether new projects turn it on. |
| Extension Dependencies | Other extensions it needs. |
| Entry Source | The extension's code. |

### Writing the code

The entry file exports an `activate(api)` function. It can be `async` and can return a cleanup function that runs when the extension stops. The code is a single file: `import`, `require` and re-exports are not supported. TypeScript is accepted without type checking.

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

Extensions run as trusted editor code, not in a sandbox. Disabling an extension, editing it or closing the project stops it and removes its commands.

## Share extensions

- **Export** offers **Export To Download** (a `.babextension` file) and **Export To Engine Extensions**.
- **Import Extension** adds a `.babextension` file. Imported extensions stay disabled until you enable them. Replacing an installed extension asks first.
- Packages are limited to 64 MiB compressed, 256 MiB expanded and 4,096 files.

Extensions are saved in the project folder, so project backups include them. Assets an extension creates are ordinary project assets.
