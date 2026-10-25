import {
  ensureEnginePluginLibrary,
  type EnginePluginEntry,
} from "../lib/engine-plugin-library";
import { downloadPluginArchive } from "../lib/plugin-download";
import { EngineLibrarySettings } from "./engine-library-settings";

const pluginGuidOf = (entry: EnginePluginEntry) => entry.pluginGuid;

export function EnginePluginsSettings() {
  return (
    <EngineLibrarySettings
      kind="Plugin"
      ensureLibrary={ensureEnginePluginLibrary}
      guidOf={pluginGuidOf}
      download={downloadPluginArchive}
    />
  );
}
