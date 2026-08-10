import { CONTENT_BROWSER_ID } from "@babylonslate/shared";
import { useDocuments } from "../context/document-context";
import { DocumentWorkspaceProvider } from "../context/document-workspace-context";
import { ContentBrowserWorkspace } from "./content-browser-workspace";
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

  const resolvedActiveId =
    activeDocumentId && tabOrder.includes(activeDocumentId)
      ? activeDocumentId
      : (tabOrder.find((id) => id === CONTENT_BROWSER_ID) ?? tabOrder[0]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {tabOrder.map((id) => {
        const doc = openDocuments.find((entry) => entry.id === id);
        if (!doc) return null;
        const active = id === resolvedActiveId;

        if (doc.ref.kind === "content-browser") {
          return (
            <div
              key={id}
              className={active ? "flex min-h-0 flex-1 flex-col" : "hidden"}
              data-testid="document-workspace-content-browser"
            >
              <ContentBrowserWorkspace />
            </div>
          );
        }

        return (
          <DocumentWorkspaceProvider key={id} documentId={id}>
            <div
              className={active ? "flex min-h-0 flex-1 flex-col" : "hidden"}
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
