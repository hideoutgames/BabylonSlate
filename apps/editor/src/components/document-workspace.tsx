import { CONTENT_BROWSER_ID } from "@babylonslate/shared";
import { useEffect, useState } from "react";
import { useDocuments } from "../context/document-context";
import { DocumentWorkspaceProvider } from "../context/document-workspace-context";
import { ContentBrowserWorkspace } from "./content-browser-workspace";
import { DockviewShell } from "../shell/dockview-shell";

export function DocumentWorkspace() {
  const {
    tabOrder,
    activeDocumentId,
    openDocuments,
    projectDocument,
    registerDockviewApi,
  } = useDocuments();

  const [mountedIds, setMountedIds] = useState<Set<string>>(() => new Set());

  const projectKey = projectDocument?.metadata.name ?? null;

  useEffect(() => {
    if (projectKey) {
      setMountedIds(new Set([CONTENT_BROWSER_ID]));
    } else {
      setMountedIds(new Set());
    }
  }, [projectKey]);

  const resolvedActiveId =
    tabOrder.length === 0
      ? null
      : activeDocumentId && tabOrder.includes(activeDocumentId)
        ? activeDocumentId
        : (tabOrder.find((id) => id === CONTENT_BROWSER_ID) ?? tabOrder[0]);

  useEffect(() => {
    if (!resolvedActiveId) return;
    setMountedIds((prev) => {
      if (prev.has(resolvedActiveId)) return prev;
      const next = new Set(prev);
      next.add(resolvedActiveId);
      return next;
    });
  }, [resolvedActiveId]);

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
        const active = id === resolvedActiveId;
        const shouldMount =
          mountedIds.has(id) ||
          (doc.ref.kind === "content-browser" && active);

        if (doc.ref.kind === "content-browser") {
          if (!shouldMount) return null;
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
              {shouldMount ? (
                <DockviewShell
                  documentKind={doc.ref.kind}
                  initialLayout={doc.layout}
                  onReady={(api) => registerDockviewApi(id, api)}
                />
              ) : null}
            </div>
          </DocumentWorkspaceProvider>
        );
      })}
    </div>
  );
}
