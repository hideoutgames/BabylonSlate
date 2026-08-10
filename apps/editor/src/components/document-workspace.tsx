import { useDocuments } from "../context/document-context";
import { DocumentWorkspaceProvider } from "../context/document-workspace-context";
import { DockviewShell } from "../shell/dockview-shell";

export function DocumentWorkspace() {
  const {
    tabOrder,
    activeDocumentId,
    openDocuments,
    registerDockviewApi,
  } = useDocuments();

  if (tabOrder.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Open a project to begin
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {tabOrder.map((id) => {
        const doc = openDocuments.find((entry) => entry.id === id);
        if (!doc) return null;
        const active = id === activeDocumentId;

        return (
          <DocumentWorkspaceProvider key={id} documentId={id}>
            <div
              className={active ? "flex min-h-0 flex-1" : "hidden"}
              data-testid={`document-workspace-${doc.ref.kind}`}
            >
              <DockviewShell
                documentKind={doc.ref.kind}
                initialLayout={doc.layout}
                onReady={(api) => registerDockviewApi(id, api)}
              />
            </div>
          </DocumentWorkspaceProvider>
        );
      })}
    </div>
  );
}
