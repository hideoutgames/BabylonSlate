import { useEffect } from "react";
import {
  useDocumentActions,
  useProjectState,
  useRegistryState,
} from "../context/document-context";
import { getAppSettingsSnapshot } from "../context/app-settings-context";
import { useProjectTrust } from "./use-project-trust";

/**
 * Mirrors editor utility startup: activates editor entries; Play links gameplay libraries separately.
 * Project Extensions run only once this computer trusts the project (Workspace Trust).
 */
export function EditorExtensionsRuntime() {
  const { getOpenDocuments } = useDocumentActions();
  const { projectDocument } = useProjectState();
  const { extensionService, projectGuid } = useRegistryState();
  const { ready, trusted, persisted, setTrusted } = useProjectTrust();
  const overrides = JSON.stringify(projectDocument?.settings.extensionOverrides ?? {});
  // Execute JavaScript's gate reads trust from Engine Settings as they are when it checks.
  useEffect(() => {
    if (!extensionService || !projectGuid) return;
    extensionService.setTrustSource(() => {
      const { settings, hydrated } = getAppSettingsSnapshot();
      const key = extensionService.projectTrustKey(projectGuid);
      return hydrated && key !== null && (settings.trustedProjects.includes(key) || extensionService.createdHere(key));
    });
    return () => extensionService.setTrustSource(null);
  }, [extensionService, projectGuid]);
  useEffect(() => {
    if (!extensionService) return;
    // Checks the tabs open when the Extension writes, not those at the last render.
    extensionService.setAssetWriteGuard((path) => {
      if (getOpenDocuments().some((document) => document.ref.path === path)) {
        throw new Error("Close this asset's editor tab before modifying it through an Extension.");
      }
    });
  }, [extensionService, getOpenDocuments]);
  const settingValues = JSON.stringify(projectDocument?.settings.extensionSettings ?? {});
  // Before the refresh below, so extensions activate with the current values.
  useEffect(() => {
    extensionService?.setSettingValues(JSON.parse(settingValues));
  }, [extensionService, settingValues]);
  // A project created here is trusted from the start; record it so that lasts across restarts.
  useEffect(() => {
    if (ready && trusted && !persisted) void setTrusted(true).catch(() => { /* Retried on the next change. */ });
  }, [ready, trusted, persisted, setTrusted]);
  useEffect(() => {
    // Waits for Engine Settings, which hold the trust, so nothing runs before the answer is known.
    if (!extensionService || !projectGuid || !ready) return;
    void extensionService.refresh(JSON.parse(overrides), trusted).catch(() => { /* Settings displays startup diagnostics. */ });
  }, [extensionService, projectGuid, overrides, ready, trusted]);
  useEffect(() => () => {
    void extensionService?.close();
  }, [extensionService, projectGuid]);
  return null;
}
