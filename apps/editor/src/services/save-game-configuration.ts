import {
  SaveGameService,
  validateSaveGameDefinition,
  type SaveGameConfiguration,
  type SaveGameProjectSettings,
  type SaveGameStorage,
} from "@babylonslate/core";
import { createSaveGameStorage } from "@babylonslate/vfs";

/** Resolve the saved asset before launching either editor Play host. */
export async function prepareSaveGameConfiguration(options: {
  projectId: string | null;
  settings: SaveGameProjectSettings | undefined;
  loadDefinition: (guid: string) => Promise<unknown>;
  /** Disposable sessions supply their overlay before wipe-on-start runs. */
  storage?: SaveGameStorage;
}): Promise<SaveGameConfiguration | undefined> {
  const settings = options.settings;
  if (!settings?.definitionGuid) return undefined;
  if (!options.projectId) throw new Error("Save Game requires a stable project ID.");
  const definition = validateSaveGameDefinition(await options.loadDefinition(settings.definitionGuid));
  const configuration: SaveGameConfiguration = {
    projectId: options.projectId,
    definition,
    defaultSlot: settings.defaultSlot,
    defaultProfile: settings.defaultProfile,
    preview: true,
  };
  if (settings.wipeOnPlay) {
    const result = await new SaveGameService({ ...configuration, storage: options.storage ?? createSaveGameStorage() }).resetPreviewData();
    if (!result.ok) throw new Error(`Could not reset preview saves: ${result.error.message}`);
  }
  return configuration;
}
