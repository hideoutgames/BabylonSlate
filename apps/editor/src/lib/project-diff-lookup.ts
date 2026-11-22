import type { AssetRegistry, ExtensionDescriptor, PluginDescriptor } from "@haptic/assets";
import type { ProjectDiffLookup } from "@haptic/assets/project-settings-diff";
import { DEFAULT_PROJECT_APPEARANCE, PROJECT_COLOR_PRESETS, PROJECT_ICON_PRESETS } from "../components/homepage-project-appearance";
import { classIdFromClassAsset } from "./class-asset-lookup";

/** Engine classes Project Settings can name, as its class pickers show them. */
const ENGINE_CLASS_NAMES: Readonly<Record<string, string>> = {
  GameInstance: "Game Instance",
  EditorUtilityObject: "Editor Utility Object",
};

/**
 * The names a Project Settings diff shows, as the editor knows them now: assets
 * by guid from the registry, project classes by class id (the pickers show the
 * id), plugins and extensions from the project's lists, and the project
 * browser's icon and color names. Each answer is read when asked.
 */
export function projectDiffLookup(state: {
  assetRegistry: Pick<AssetRegistry, "getByGuid" | "list"> | null | undefined;
  pluginDescriptors: readonly PluginDescriptor[];
  extensions: readonly ExtensionDescriptor[];
}): ProjectDiffLookup {
  return {
    assetName: (guid) => state.assetRegistry?.getByGuid(guid)?.header.name ?? null,
    className: (classId) => {
      const engine = ENGINE_CLASS_NAMES[classId];
      if (engine) return engine;
      const found = state.assetRegistry?.list().some((asset) => asset.header.type === "Class" && classIdFromClassAsset(asset) === classId);
      return found ? classId : null;
    },
    plugin: (guid) => {
      const plugin = state.pluginDescriptors.find((entry) => entry.pluginGuid === guid);
      return plugin ? { name: plugin.settings.displayName, enabledByDefault: plugin.settings.enabledByDefault } : null;
    },
    extension: (guid) => {
      const extension = state.extensions.find((entry) => entry.extensionGuid === guid);
      return extension
        ? { name: extension.settings.displayName, enabledByDefault: extension.settings.enabledByDefault, settings: extension.settings.contributes.settings ?? null }
        : null;
    },
    iconName: (id) => PROJECT_ICON_PRESETS.find((preset) => preset.id === id)?.label ?? null,
    colorName: (id) => PROJECT_COLOR_PRESETS.find((preset) => preset.id === id)?.label ?? null,
    defaultAppearance: { icon: DEFAULT_PROJECT_APPEARANCE.icon, color: DEFAULT_PROJECT_APPEARANCE.color },
  };
}
