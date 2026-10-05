import { useEffect } from "react";
import { useDocuments } from "../context/document-context";

/** Mirrors editor utility startup while keeping code modules out of Play. */
export function EditorExtensionsRuntime() {
  const { extensionService, projectDocument, getOpenDocuments, projectGuid } = useDocuments();
  const overrides = JSON.stringify(projectDocument?.settings.extensionOverrides ?? {});
  useEffect(() => {
    if (!extensionService) return;
    // Checks the tabs open when the Extension writes, not those at the last render.
    extensionService.setAssetWriteGuard((path) => {
      if (getOpenDocuments().some((document) => document.ref.path === path)) {
        throw new Error("Close this asset's editor tab before modifying it through an Extension.");
      }
    });
  }, [extensionService, getOpenDocuments]);
  useEffect(() => {
    if (!extensionService || !projectGuid) return;
    void extensionService.refresh(JSON.parse(overrides)).catch(() => { /* Settings displays startup diagnostics. */ });
  }, [extensionService, projectGuid, overrides]);
  useEffect(() => () => {
    void extensionService?.close();
  }, [extensionService, projectGuid]);
  return null;
}
