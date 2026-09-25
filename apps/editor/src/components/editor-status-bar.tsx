import { CircleAlertIcon } from "lucide-react";
import { useDocuments } from "../context/document-context";
import { useValidation } from "../context/validation-context";
import { getBuildLabel } from "../lib/build-identity";
import { usePhoneLayout } from "../shell/use-platform-layout";

function saveStateLabel(unsaved: number, projectDirty: boolean): string {
  if (unsaved > 0)
    return `${unsaved} Unsaved ${unsaved === 1 ? "Document" : "Documents"}`;
  return projectDirty ? "Unsaved Project Changes" : "All Changes Saved";
}

export function EditorStatusBar() {
  const { openDocuments, activeDocumentId, dirtyDocuments, projectDirty } =
    useDocuments();
  const { errorCount } = useValidation();
  const phone = usePhoneLayout();
  if (phone) return null;
  const active = openDocuments.find((doc) => doc.id === activeDocumentId);
  const dirty = dirtyDocuments.length > 0 || projectDirty;
  return (
    <footer className="editor-statusbar" data-testid="editor-status-bar">
      <p className="editor-status-summary">
        <span
          className="editor-status-dot"
          data-dirty={dirty ? "true" : "false"}
          aria-hidden="true"
        />
        {saveStateLabel(dirtyDocuments.length, projectDirty)}
        {errorCount > 0 ? (
          <span className="editor-status-errors">
            <CircleAlertIcon aria-hidden="true" />
            {errorCount} {errorCount === 1 ? "Error" : "Errors"}
          </span>
        ) : null}
        {active ? (
          <>
            <span aria-hidden="true">·</span>
            <span className="editor-status-document">{active.ref.label}</span>
          </>
        ) : null}
      </p>
      <span className="editor-status-version">{getBuildLabel()}</span>
    </footer>
  );
}
