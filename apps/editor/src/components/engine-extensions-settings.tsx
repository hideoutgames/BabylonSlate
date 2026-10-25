import {
  ensureEngineExtensionLibrary,
  type EngineExtensionEntry,
} from "../lib/engine-extension-library";
import { downloadExtensionArchive } from "../lib/extension-download";
import { EngineLibrarySettings } from "./engine-library-settings";

const extensionGuidOf = (entry: EngineExtensionEntry) => entry.extensionGuid;

export function EngineExtensionsSettings() {
  return (
    <EngineLibrarySettings
      kind="Extension"
      ensureLibrary={ensureEngineExtensionLibrary}
      guidOf={extensionGuidOf}
      download={downloadExtensionArchive}
    />
  );
}
