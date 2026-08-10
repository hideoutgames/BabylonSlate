import type { IDockviewPanelProps } from "dockview";
import { FileJsonIcon, LayersIcon } from "lucide-react";
import { documentId, labelFromPath } from "@babylonslate/shared";
import { useDocuments } from "../context/document-context";

export function ContentPanel(_props: IDockviewPanelProps) {
  void _props;
  const { projectDocument, openDocument, setActiveDocument, tabOrder } =
    useDocuments();

  if (!projectDocument) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No project open
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
    <div className="flex h-full flex-col gap-1 overflow-y-auto p-2">
      <div className="px-2 text-xs font-semibold text-muted-foreground">
        Scenes
      </div>
      {projectDocument.scenes.map((path) => (
        <button
          key={path}
          type="button"
          data-testid={`content-item-${path}`}
          className="flex min-h-11 items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-accent"
          onClick={() => void openOrFocus("scene", path)}
        >
          <LayersIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{labelFromPath(path)}</span>
        </button>
      ))}
      <div className="mt-2 px-2 text-xs font-semibold text-muted-foreground">
        Graphs
      </div>
      {projectDocument.graphs.map((path) => (
        <button
          key={path}
          type="button"
          data-testid={`content-item-${path}`}
          className="flex min-h-11 items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-accent"
          onClick={() => void openOrFocus("graph", path)}
        >
          <FileJsonIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{labelFromPath(path)}</span>
        </button>
      ))}
    </div>
  );
}
