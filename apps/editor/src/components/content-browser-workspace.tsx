import { FileJsonIcon, LayersIcon } from "lucide-react";
import { documentId, labelFromPath } from "@babylonslate/core";
import { useDocuments } from "../context/document-context";

export function ContentBrowserWorkspace() {
  const { projectDocument, openDocument, setActiveDocument, tabOrder } =
    useDocuments();

  if (!projectDocument) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
        Open a project to browse scenes and graphs
      </div>
    );
  }

  const openIds = new Set(tabOrder);

  const openOrFocus = async (kind: "scene" | "graph", path: string) => {
    const id = documentId({ kind, path });
    if (openIds.has(id)) {
      setActiveDocument(id);
      return;
    }
    await openDocument({
      kind,
      path,
      label: labelFromPath(path),
    });
  };

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden bg-card"
      data-testid="content-browser-workspace"
    >
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-foreground">Content Browser</h2>
        <p className="text-xs text-muted-foreground">
          Open scenes and graphs for {projectDocument.metadata.name}
        </p>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-4">
      <div className="px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Scenes
      </div>
      {projectDocument.scenes.map((path) => (
        <button
          key={path}
          type="button"
          data-testid={`content-item-${path}`}
          className="flex min-h-11 items-center gap-2 rounded-sm px-2 text-left text-sm hover:bg-accent"
          onClick={() => void openOrFocus("scene", path)}
        >
          <LayersIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{labelFromPath(path)}</span>
        </button>
      ))}
      <div className="mt-4 px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Graphs
      </div>
      {projectDocument.graphs.map((path) => (
        <button
          key={path}
          type="button"
          data-testid={`content-item-${path}`}
          className="flex min-h-11 items-center gap-2 rounded-sm px-2 text-left text-sm hover:bg-accent"
          onClick={() => void openOrFocus("graph", path)}
        >
          <FileJsonIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{labelFromPath(path)}</span>
        </button>
      ))}
      </div>
    </div>
  );
}
