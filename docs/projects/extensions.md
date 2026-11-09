# Extensions

Extensions are small JavaScript or TypeScript packages. Every extension can add editor commands that read and create assets and project code, place them in editor menus, and add its own asset types. An extension with **Editor Only** turned off also adds a game library and content to Play and packaged games.

For editor tools built with visual scripting instead of code, see [Editor Scripting](../scripting/editor-scripting.md).

## Engine and Project extensions

| Kind | Where | Notes |
| --- | --- | --- |
| Project extensions | **Project Settings > Project Extensions** | Live in the project. You can edit, enable and export them. |
| Engine extensions | **Engine Settings > Engine Extensions** | Copied into every new project. Existing projects keep their own copies. |

## Use an extension

1. Open **Project Settings > Project Extensions**.
2. Turn on **Enable** for the extension. Haptic asks you to confirm, because its code can change your project's assets and code, and a gameplay extension's code also runs in your game. Enable only code you trust.
3. The extension's commands appear as buttons in its row, and in the editor menus the extension adds them to. Choose one, fill in the fields and run it.

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
3. Fill in the fields and write the code under **Code Files**, then choose **Save**. Saving reloads enabled extensions.

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
| Contributions | What the extension adds to the editor, as JSON. See [Project Settings](#project-settings), [Menus](#menus), [Asset types](#asset-types) and [Graph nodes](#graph-nodes). |
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
| `api.registerCommand({ id, title, description, fields, execute })` | Add a command button. `fields` use the [field types](#field-types). `execute(values, context)` receives each field's value and, when the command runs from a [menu](#menus), what the menu was opened on. The text it returns is shown when the command completes. |
| `api.settings.get()` / `api.settings.onChange(listener)` | Read the extension's [Project Settings](#project-settings) values, and run `listener` when they change. `onChange` returns a function that stops it. |
| `api.assets.list()` | List the project's assets. |
| `api.assets.read(path)` | Read an asset document. |
| `api.assets.create(path, { type, name, payload })` | Create an asset under `assets/`. Fails if the path exists. An [extension asset type](#asset-types) is written as `extension.<Extension ID>.<id>`. |
| `api.assets.update(path, document)` | Change an asset. Close its tab first. |
| `api.code.read(path)` / `api.code.write(path, source)` | Read or write `.ts` and `.js` files under `code/`. |
| `api.materials.convertGlsl(source, options)` | Convert GLSL to a Material document without saving it. |
| `api.log(message)` | Write a message to the editor's diagnostics. |

```js
export function activate(api) {
  api.registerCommand({
    id: "count-assets",
    title: "Count Assets",
    fields: [{ id: "type", label: "Type", type: "text", default: "Material" }],
    async execute(values) {
      const assets = await api.assets.list();
      return `This project has ${assets.filter((asset) => asset.type === values.type).length} ${values.type} assets.`;
    },
  });
}
```

Extensions run as trusted code, not in a sandbox. Disabling an extension, editing it or closing the project stops it and removes its commands.

## Project Settings

An extension can add its own category to **Project Settings**. Write it under **Contributions** in **Edit Extension**, or as `contributes` in `extension.json`. The category appears while the extension is enabled, under the title you choose, and **Search settings** finds its fields.

```json
{
  "settings": {
    "title": "Weather",
    "sections": [
      {
        "id": "general",
        "title": "General",
        "fields": [
          { "id": "region", "label": "Region", "type": "text", "default": "North" },
          { "id": "rain", "label": "Rain Chance", "type": "number", "min": 0, "max": 1, "default": 0.25 },
          { "id": "storms", "label": "Storms", "type": "toggle", "hint": "Adds lightning to heavy rain." }
        ]
      }
    ]
  }
}
```

- Values are saved in the project, so each project keeps its own.
- Editor code reads them with `api.settings`.
- Game code of a [gameplay extension](#gameplay-extensions) imports them: `import { settings } from "haptic:extension";`. The game receives the values the project had when Play started or the game was exported.
- Values are stored in the project file and ship with games, so never put passwords or private keys in them.

### Field types

Settings and command fields share these types. Each field has an `id`, a `label`, an optional `hint` (shown as the label's tooltip) and an optional `default`.

| Type | Value | Options |
| --- | --- | --- |
| `text` | Text on one line | `required` stops a command while it is empty |
| `multiline` | Text on several lines | `required` |
| `code` | Code with highlighting | `language`: `javascript` or `glsl`; `required` |
| `number` | A number | `min`, `max`, `integer`, `unit` |
| `toggle` | On or off | |
| `choice` | One of a list | `options`: a list of `{ "value", "label" }` |

## Menus

An extension can add its commands to editor menus. List them under `menus` in **Contributions**:

```json
{
  "menus": [
    { "menu": "contentBrowser.asset", "command": "inspect", "title": "Inspect Asset" },
    { "menu": "outliner.actor", "command": "inspect" }
  ]
}
```

- `command` is the `id` of a command the extension registers. The entry appears only while the extension runs and has registered that command.
- `title` is the entry's label. Without it, the entry uses the command's title.
- Entries appear after the menu's own items, with the extension's icon, in the order of the extensions and of their `menus` list. A command can be listed in several menus, but only once per menu.
- A command with fields opens its dialog first. A command without fields runs at once, and its returned text or its error is shown in a message.

| `menu` | Where | `context` |
| --- | --- | --- |
| `settings` | The **Settings** menu in the toolbar | `{}` |
| `debug` | The **Debug** menu next to **Play** | `{}` |
| `contentBrowser.asset` | The context menu of assets in the **Content Browser** | `{ assets: [{ path, type, name, guid }] }` |
| `contentBrowser.folder` | The context menu of folders in the **Content Browser** | `{ folders: [path] }` |
| `contentBrowser.empty` | The context menu of empty space in the **Content Browser** grid | `{ folder }`: the folder being shown |
| `outliner.actor` | The context menu of actors in the **Outliner** | `{ scene, actors: [{ id, name, classId }] }` |
| `outliner.folder` | The context menu of a folder in the **Outliner** | `{ scene, folder: { id, name } }` |
| `viewport` | The viewport's context menu | `{ scene, actors: [{ id, name, classId }] }`: the selected actors |
| `graph.node` | The context menu of a node in a graph | `{ asset, graphId, node: { id, type } }` |

Context menus open with a right-click, or a long-press on touch. Asset and folder entries appear when the selection holds only assets or only folders. `scene` and `asset` are asset paths. The `context` is a copy, so changing it changes nothing in the editor; use `api.assets` to make changes.

```js
export function activate(api) {
  api.registerCommand({
    id: "inspect",
    title: "Inspect",
    execute(values, context) {
      const names = (context.assets ?? context.actors ?? []).map((item) => item.name);
      return names.length > 0 ? names.join("\n") : "Nothing selected.";
    },
  });
}
```

## Asset types

An extension can add its own asset types. Declare them under `assetTypes` in **Contributions**:

```json
{
  "assetTypes": [
    {
      "id": "preset",
      "title": "Weather Preset",
      "category": "Weather",
      "description": "Rain, wind and fog for one kind of weather.",
      "iconKey": "Sparkles",
      "editorOnly": false,
      "sections": [
        {
          "id": "sky",
          "title": "Sky",
          "fields": [
            { "id": "rain", "label": "Rain Chance", "type": "number", "min": 0, "max": 1, "default": 0.5 },
            { "id": "storms", "label": "Storms", "type": "toggle" }
          ]
        }
      ]
    }
  ]
}
```

- While the extension is enabled, **New Asset** in the Content Browser lists the type under its `category` (the extension's name if none). The new asset holds every field's default and opens at once.
- The asset's **Inspector** shows the type's sections. Fields use the [field types](#field-types), and each field's value is saved in the asset.
- `iconKey` names one of the icons the extension's **Icon** field offers, such as `Sparkles`. Without it, the type uses the extension's icon.
- Assets are ordinary `.hasset` files, named after the asset. They stay in the project when the extension is disabled or removed, but cannot be edited until an enabled extension declares their type again.
- `editorOnly` is on unless you turn it off. Editor Only assets never reach games.

### Assets in games

With `editorOnly` off, a [gameplay extension](#gameplay-extensions)'s game code reads every asset of the type in the project:

```js
import { assets } from "haptic:extension";

export function wettest() {
  return Math.max(...assets.list("preset").map((asset) => asset.values.rain));
}
```

| Call | Returns |
| --- | --- |
| `assets.list()` | Every asset of the extension's gameplay types, as `{ guid, name, type, values }`. `type` is the asset type's `id`. |
| `assets.list(type)` | The assets of one asset type. |
| `assets.get(guid)` | One asset, or `null`. |

- Assets ship with the game whether or not anything else uses them. Play uses the values open tabs show, saved or not; Preview Build and packaged games use saved values.
- The values are read-only. A field the extension no longer declares is left out, and a missing value takes its default.
- An Editor Only extension has no game library, so its gameplay asset types do not reach games. Project Extensions lists this as a diagnostic.

## Graph nodes

A [gameplay extension](#gameplay-extensions) can add nodes to Class graphs. Each node calls a function its game entry exports. Declare them under `nodes` in **Contributions**:

```json
{
  "nodes": [
    {
      "id": "setPresence",
      "title": "Set Presence",
      "category": "Presence",
      "description": "Shows what the player is doing.",
      "call": "setPresence",
      "hosts": ["GameInstance"],
      "inputs": [
        { "id": "details", "name": "Details", "type": "string", "default": "In Menus" },
        { "id": "party", "name": "Party Size", "type": "int", "default": 1 }
      ],
      "outputs": [{ "id": "ok", "name": "Success", "type": "bool" }]
    }
  ]
}
```

```js
export function setPresence(details, party) {
  // Inputs arrive as arguments in the order they are listed.
  return true;
}
```

- The node's inputs are the function's arguments, in order. With one output, the node outputs what the function returns. With several, it reads each output's `id` from the object the function returns.
- `pure` makes a node without execution pins, evaluated where its outputs are read. `latent` makes the node wait for the promise the function returns before it continues.
- `hosts` lists Classes whose graphs offer the node, including their child Classes. `["GameInstance"]` limits it to Game Instance graphs. Without `hosts`, every Class graph offers it.
- Pin types are `bool`, `int`, `float`, `string`, `vec2`, `vec3`, `vec4`, `rotator`, `quat`, `transform` and `color`. Inputs of `bool`, `int`, `float` and `string` can have a `default`.
- Nodes appear in **Add Node** under their `category` (the extension's name if none) while the extension is enabled and **Editor Only** is off. Editor Scripting graphs and Animation Graphs do not offer them.
- If the extension is disabled, set to Editor Only or removed, graphs keep its nodes, and **Compiler Results** lists each one as an error until the extension returns or you delete the node.

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

### Platform directives

Mark code that only some platforms should run, and only those platforms' packages carry it, with directive comments:

```ts
// #if WITH_DESKTOP
import { connect } from "./code/desktop";
// #endif

export function startPresence() {
  // #if WITH_DESKTOP && !WITH_LINUX
  connect();
  // #elif WITH_MOBILE
  console.log("Phones and tablets have no presence");
  // #else
  // Web and Linux do nothing.
  // #endif
}
```

- A region starts with `// #if`, may have `// #elif` and `// #else` branches, and ends with `// #endif`. Regions can be nested.
- Conditions combine symbols with `&&`, `||`, `!` and brackets.
- Lines in a branch that does not apply are left out before the code runs, imports included, so a file only one platform imports never reaches the others. The file keeps its line numbers.
- Directives are comments, so the file is still valid TypeScript.

| Symbol | True for |
| --- | --- |
| `WITH_EDITOR` | Play in the editor, and editor code. Never in Preview Build or a package. |
| `WITH_WEB` | Web packages, Preview Build, and Play in a browser. |
| `WITH_DESKTOP` | Windows, macOS and Linux. |
| `WITH_WINDOWS`, `WITH_MACOS`, `WITH_LINUX` | That operating system. |
| `WITH_MOBILE` | Android and iOS. |
| `WITH_ANDROID`, `WITH_IOS` | That operating system. |

Each place your code runs has its own platform:

- **Play** uses the platform of the editor you play in, with `WITH_EDITOR`: the desktop app on Windows, for example, has `WITH_DESKTOP`, `WITH_WINDOWS` and `WITH_EDITOR`.
- **Preview Build** plays the web game.
- **Packaging** uses the platform you package for.
- **Editor code** uses the editor's platform, with `WITH_EDITOR`.

A directive that is malformed or names an unknown symbol stops Play and packaging, naming the file and line.

## Share extensions

- **Export** offers **Export To File** (a `.hextension` file, saved as in [Saving exported files](index.md#saving-exported-files)) and **Export To Engine Extensions**. Both include every code file and the content folder.
- **Import Extension** adds a `.hextension` file. Imported extensions stay disabled until you enable them. Replacing an installed extension asks first.
- Packages are limited to 64 MiB compressed, 256 MiB expanded and 4,096 files, and each code file to 1 MiB.

Extensions are saved in the project folder, so project backups include them. Assets an extension creates are ordinary project assets.
