# Plugins

A plugin is a self-contained bundle of assets and Classes that you can turn on or off in a project and share between projects.

Plugins contain content only: Classes, scenes, materials, textures and other assets. They add no native code. To add editor tools written in code, use [Editor Extensions](extensions.md).

## Manage plugins

Open **Project Settings > Plugins**. Each plugin has a row with its name, icon, version and a badge:

- **Engine**: comes with the app. Its content is read-only.
- **Project**: lives in this project and can be edited.
- **Experimental** or **Beta**: the author's maturity flags. Enabling such a plugin asks you to confirm.

| Control | Description |
| --- | --- |
| Enable switch | Turn the plugin on or off for this project. |
| Open | Open the plugin's settings document. |
| Export | Save the plugin as a `.babplugin` file, or add it to Engine Plugins. |
| Delete | Project plugins only. Permanently deletes the plugin from disk. |
| Show Plugin Content | Show plugin folders in the Content Browser. Hiding them keeps their assets available. |

When you disable a plugin, its assets leave the project: they disappear from the Content Browser, search, Play and exported games. If other assets still use it, Haptic lists them and asks before disabling.

## Create a plugin

1. In **Project Settings > Plugins**, choose **New Plugin**.
2. Enter a **Display Name** and choose **Create**.

Haptic creates the plugin's folder and turns on **Show Plugin Content**. Add assets to the plugin by creating or importing them inside its folder in the Content Browser.

To put existing project assets in a plugin, move them into its folder with **Move…** or by dragging them in the folder tree. Moved assets keep their identity, so everything that uses them still does. Haptic warns before a move that makes the plugin use content it would not carry with it, or that an export preset would leave out. See [Move assets](../editor/content-browser.md#move-assets).

## Plugin settings

Choose **Open** on a plugin to edit its settings in the **Inspector**.

| Setting | Description |
| --- | --- |
| GUID | The plugin's permanent ID. Read-only. |
| Display Name, Version, Author, Category, Description | How the plugin is listed. |
| Icon Key | The icon shown next to its name. **Default** clears it. |
| Experimental, Beta | Maturity flags shown as badges. |
| Enabled By Default | Whether new projects turn it on. |
| Editor Utility Objects | Classes from the plugin that run in the editor while it is enabled. See [Editor Scripting](../scripting/editor-scripting.md). |
| Plugin Dependencies | Other plugins this one needs. **Add Dependency** records their current version. |

A plugin whose dependency is missing, disabled or circular stays off, and its row shows **Missing Dependency**, **Blocked Dependency** or **Dependency Cycle**. A changed engine or dependency version shows only a warning.

See [Plugin Settings](../assets/plugin-settings.md) for the asset itself.

## Share plugins

- **Export > Export To Download** saves a `.babplugin` file.
- **Import Plugin** adds a `.babplugin` file to the project. If the same plugin and version is already installed, choose **Keep** or **Replace**. A different version updates the installed plugin.
- **Export > Export To Engine Plugins** adds the plugin to your Engine Plugins on this device.

## Engine Plugins

**Engine Settings > Engine Plugins** lists the plugins that are copied into every new project. Existing projects keep their own copies.

| Control | Description |
| --- | --- |
| Enabled By Default | Whether new projects start with the plugin on. |
| Export | Save the plugin as a `.babplugin` file. |
| Delete | Plugins you added only. Bundled plugins cannot be removed. |

### Starter Content

**Starter Content** is a bundled plugin with a starter Actor Class, **StarterActor**, and no artwork. It is off by default. Turn it on in **Project Settings > Plugins** to use it.
