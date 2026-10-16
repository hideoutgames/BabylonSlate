# Plugin Settings

The settings document of a plugin: how it is listed, what it depends on and which editor classes it runs.

## Create

You do not create this asset from **New Asset**. Haptic creates one for each plugin in **Project Settings > Plugins**, when you choose **New Plugin** or import a plugin. See [Plugins](../projects/plugins.md).

## Editor

In **Project Settings > Plugins**, choose **Open** on a plugin. The document has an **Inspector** only. For an Engine plugin it opens read-only, with the note "Engine plugins are read-only."

## Settings

| Setting | Description |
| --- | --- |
| GUID | The plugin's permanent ID. Read-only. |
| Display Name | The name shown in the plugin list and the Content Browser. |
| Version | The author's version label. |
| Author | Who made the plugin. |
| Category | A grouping label. |
| Icon Key | The icon shown next to the plugin. **Default** clears it. |
| Description | A short description. |
| Experimental | Marks the plugin Experimental. Enabling it asks for confirmation. |
| Beta | Marks the plugin Beta. Enabling it asks for confirmation. |
| Enabled By Default | Whether new projects turn the plugin on. |
| Editor Utility Objects | Classes that run in the editor while the plugin is enabled. **Add Class** picks or creates one. |
| Plugin Dependencies | Other plugins this one needs. **Add Dependency** records the plugin's current version. **Remove Dependency** deletes the entry. |

## Related

- [Plugins](../projects/plugins.md)
- [Editor Scripting](../scripting/editor-scripting.md)
