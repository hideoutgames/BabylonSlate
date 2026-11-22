import { useProjectState, useRegistryState } from "../context/document-context";
import { mergePluginEditorUtilityObjects } from "../lib/plugin-ui";

/**
 * The Editor Utility Object classes that start on their own when the project
 * opens: the project's registrations plus those of its mounted, enabled plugins.
 */
export function useRegisteredEditorUtilities(): string[] {
  const { projectDocument } = useProjectState();
  const { pluginDescriptors, assetRegistry } = useRegistryState();
  return mergePluginEditorUtilityObjects(
    projectDocument?.settings.editorUtilityObjects ?? [],
    pluginDescriptors
      .filter((plugin) => assetRegistry?.getRoot(`plugin:${plugin.pluginGuid}`))
      .map((plugin) => plugin.settings),
  );
}
