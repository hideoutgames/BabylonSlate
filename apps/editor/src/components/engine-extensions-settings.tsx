import { useMemo, useSyncExternalStore } from "react";
import {
  useDocumentActions,
  useProjectState,
  useRegistryState,
} from "../context/document-context";
import {
  ensureEngineExtensionLibrary,
  type EngineExtensionEntry,
} from "../lib/engine-extension-library";
import { saveExtensionArchive } from "../lib/extension-download";
import { EngineLibrarySettings, type EngineLibraryProject } from "./engine-library-settings";

const extensionGuidOf = (entry: EngineExtensionEntry) => entry.extensionGuid;

/** The open project's side of an Engine Extension: its copy (a project copy or the visible engine entry) and enable override. */
function useExtensionProject(): EngineLibraryProject<EngineExtensionEntry> | undefined {
  const { projectDocument, projectName } = useProjectState();
  const { updateProjectSettings } = useDocumentActions();
  const { extensionService: service } = useRegistryState();
  const snapshot = useSyncExternalStore(service.subscribe, service.getSnapshot);
  return useMemo(() => {
    if (!projectDocument) return undefined;
    const name = projectName ?? "the open project";
    const overrides = projectDocument.settings.extensionOverrides ?? {};
    const find = (guid: string) => snapshot.entries.find((entry) => entry.extensionGuid === guid);
    return {
      name,
      isEnabled: (guid) => {
        const entry = find(guid);
        return Boolean(entry && !entry.invalid && (overrides[guid]?.enabled ?? entry.settings.enabledByDefault));
      },
      notes: (entry, enabled) => enabled ? [
        ...(find(entry.extensionGuid) ? [] : [`It is not in ${name} yet, so a project choice copies it in.`]),
        `Its code runs in the editor and can modify project assets and code${entry.settings.editorOnly ? "" : ", and its game library runs in Play and packaged games"}. Enable only code you trust.`,
      ] : [],
      setEnabled: async (guid, enabled, archive) => {
        const entry = find(guid);
        if (!entry) {
          if (!enabled) return;
          const result = await service.import(await archive());
          if (result.status === "conflict") {
            throw new Error(`${name} already has an extension named ${result.name}. Import this one in Project Settings > Extensions to replace it.`);
          }
        } else if (enabled && entry.invalid) {
          throw new Error(entry.invalid);
        }
        const next = { ...service.getOverrides(), [guid]: { enabled } };
        await service.refresh(next);
        updateProjectSettings({ extensionOverrides: next });
      },
    };
  }, [projectDocument, projectName, service, snapshot, updateProjectSettings]);
}

export function EngineExtensionsSettings() {
  const project = useExtensionProject();
  return (
    <EngineLibrarySettings
      kind="Extension"
      ensureLibrary={ensureEngineExtensionLibrary}
      guidOf={extensionGuidOf}
      save={saveExtensionArchive}
      project={project}
    />
  );
}
