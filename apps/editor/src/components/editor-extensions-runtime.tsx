import { useEffect, useRef } from "react";
import { useDocuments } from "../context/document-context";

/** Mirrors editor utility startup while keeping code modules out of Play. */
export function EditorExtensionsRuntime() {
  const { extensionService, projectDocument, openDocuments, projectGuid } = useDocuments();
  const documents = useRef(openDocuments);
  documents.current = openDocuments;
  const overrides = JSON.stringify(projectDocument?.settings.extensionOverrides ?? {});
  useEffect(() => {
    if (!extensionService || !projectGuid) return;
    extensionService.setAssetWriteGuard((path) => {
      if (documents.current.some((document) => document.ref.path === path)) {
        throw new Error("Close this asset's editor tab before modifying it through an Extension.");
      }
    });
    void extensionService.refresh(JSON.parse(overrides)).catch(() => { /* Settings displays startup diagnostics. */ });
  }, [extensionService, projectGuid, overrides]);
  useEffect(() => () => {
    void extensionService?.close();
  }, [extensionService, projectGuid]);
  return null;
}
