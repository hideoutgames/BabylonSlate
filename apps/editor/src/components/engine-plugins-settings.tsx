import { useMemo } from "react";
import type { ExecuteJavaScriptAsset } from "@haptic/core";
import { resolvePluginEnabled } from "@haptic/assets";
import {
  useDocumentActions,
  useProjectState,
  useRegistryState,
} from "../context/document-context";
import {
  ensureEnginePluginLibrary,
  type EnginePluginEntry,
} from "../lib/engine-plugin-library";
import { savePluginArchive } from "../lib/plugin-download";
import { inboundRefsFromOtherRoots, pluginRootId } from "../lib/plugin-ui";
import { EngineLibrarySettings, type EngineLibraryProject } from "./engine-library-settings";
import { ExecuteJavaScriptImportDialog, useExecuteJavaScriptReview } from "./execute-javascript-import-dialog";

const pluginGuidOf = (entry: EnginePluginEntry) => entry.pluginGuid;

/** The open project's side of an Engine Plugin: its copy (a project copy or the bundled fallback) and enable override. */
function usePluginProject(
  confirmExecuteJavaScript: (assets: ExecuteJavaScriptAsset[]) => Promise<boolean>,
): EngineLibraryProject<EnginePluginEntry> | undefined {
  const { projectDocument, projectName } = useProjectState();
  const { updateProjectSettings, applyPluginOverrides, importPlugin } = useDocumentActions();
  const { pluginDescriptors, assetRegistry } = useRegistryState();
  return useMemo(() => {
    if (!projectDocument) return undefined;
    const name = projectName ?? "the open project";
    const overrides = projectDocument.settings.pluginOverrides ?? {};
    const find = (guid: string) => pluginDescriptors.find((plugin) => plugin.pluginGuid === guid);
    return {
      name,
      isEnabled: (guid) => {
        const plugin = find(guid);
        return Boolean(plugin && resolvePluginEnabled(plugin.settings.enabledByDefault, overrides[guid]?.enabled));
      },
      notes: (entry, enabled) => {
        if (enabled) return find(entry.pluginGuid) ? [] : [`It is not in ${name} yet, so a project choice copies it in.`];
        const inbound = assetRegistry
          ? inboundRefsFromOtherRoots(assetRegistry.list(), (guid) => assetRegistry.showReferences(guid), pluginRootId(entry.pluginGuid))
          : [];
        return inbound.length > 0
          ? [`Other assets in ${name} still reference it: ${inbound.map((asset) => asset.name).join(", ")}.`]
          : [];
      },
      setEnabled: async (guid, enabled, archive) => {
        let target = guid;
        if (!find(guid)) {
          if (!enabled) return;
          // Only content bundled with Haptic copies in unasked. Whether an entry is bundled comes from where the library
          // reads it (the app's own catalog), never from the archive; any other entry discloses its Execute JavaScript.
          const bundled = (await (await ensureEnginePluginLibrary()).list()).some((entry) => entry.pluginGuid === guid && entry.bundled);
          const bytes = await archive();
          let result = await importPlugin(bytes, undefined, { allowExecuteJavaScript: bundled });
          if (result.status === "executeJavaScript") {
            if (!await confirmExecuteJavaScript(result.assets)) return false;
            result = await importPlugin(bytes, undefined, { allowExecuteJavaScript: true });
          }
          if (result.status !== "imported") {
            const existing = result.status === "conflict" ? result.incoming.settings.displayName : guid;
            throw new Error(`${name} already has a plugin named ${existing}. Import this one in Project Settings > Plugins to replace it.`);
          }
          target = result.descriptor.pluginGuid;
        }
        const next = { ...overrides, [target]: { enabled } };
        // Mount or unmount first so Content Browser roots never resolve as enabled before they exist.
        await applyPluginOverrides(next);
        updateProjectSettings({ pluginOverrides: next });
      },
    };
  }, [applyPluginOverrides, assetRegistry, confirmExecuteJavaScript, importPlugin, pluginDescriptors, projectDocument, projectName, updateProjectSettings]);
}

export function EnginePluginsSettings() {
  const { assets, review, answer } = useExecuteJavaScriptReview();
  const project = usePluginProject(review);
  return (
    <>
      <EngineLibrarySettings
        kind="Plugin"
        ensureLibrary={ensureEnginePluginLibrary}
        guidOf={pluginGuidOf}
        save={savePluginArchive}
        project={project}
      />
      <ExecuteJavaScriptImportDialog assets={assets} onConfirm={() => answer(true)} onCancel={() => answer(false)} />
    </>
  );
}
