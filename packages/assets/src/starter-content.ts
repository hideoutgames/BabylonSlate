import { ENGINE_VERSION } from "@babylonslate/core";
import { encodeAssetDocument } from "./asset-document";
import type { ProjectTreeFile } from "./babproject";
import {
  createDefaultPluginSettings,
  encodePluginSettingsDocument,
} from "./plugin-settings";

export const STARTER_CONTENT_FOLDER = "starter-content";
export const STARTER_CONTENT_DISPLAY_NAME = "Starter Content";
export const STARTER_CONTENT_PLUGIN_GUID =
  "c0ffee00-0000-4000-8000-000000000001";
export const STARTER_ACTOR_GUID = "c0ffee00-0000-4000-8000-000000000002";
export const STARTER_ACTOR_CLASS_NAME = "StarterActor";
export const STARTER_CONTENT_SETTINGS_FILE = "starter-content.plugin.babasset";
export const STARTER_ACTOR_FILE = "assets/StarterActor.class.babasset";

/** Directory-form Starter Content files (no plugin.json; discovery uses PluginSettings). */
export async function buildStarterContentFiles(): Promise<ProjectTreeFile[]> {
  const settings = createDefaultPluginSettings({
    pluginGuid: STARTER_CONTENT_PLUGIN_GUID,
    displayName: STARTER_CONTENT_DISPLAY_NAME,
  });
  settings.enabledByDefault = false;
  settings.iconKey = "Puzzle";
  settings.description = "Bundled engine starter classes with no artwork.";
  settings.author = "BabylonSlate";
  settings.category = "Engine";
  settings.engineVersionRange = `^${ENGINE_VERSION}`;

  const classBytes = await encodeAssetDocument(
    {
      type: "Class",
      name: STARTER_ACTOR_CLASS_NAME,
      guid: STARTER_ACTOR_GUID,
      version: 1,
      payload: { nodes: [], edges: [] },
    },
    { engineVersion: ENGINE_VERSION, parentClass: "Actor" },
  );

  return [
    {
      path: STARTER_CONTENT_SETTINGS_FILE,
      data: await encodePluginSettingsDocument(settings),
    },
    {
      path: STARTER_ACTOR_FILE,
      data: classBytes,
    },
  ];
}
