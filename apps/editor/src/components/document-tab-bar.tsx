import { useCallback, useRef, useState, type DragEvent } from "react";
import { FileJsonIcon, GripVerticalIcon, LayersIcon, PlusIcon, XIcon } from "lucide-react";
import { Button } from "@babylonslate/ui/components/button";
import type { DocumentKind } from "@babylonslate/shared";
import { labelFromPath } from "@babylonslate/shared";
import { useDocuments } from "../context/document-context";

function kindIcon(kind: DocumentKind) {
  return kind === "scene" ? (
    <LayersIcon className="size-4 shrink-0" />
  ) : (
    <FileJsonIcon className="size-4 shrink-0" />
  );
}

export function DocumentTabBar() {
  const {
    projectName,
    openDocuments,
    tabOrder,
    activeDocumentId,
    setActiveDocument,
    closeDocument,
    reorderTabs,
    openDocument,
    getAvailableDocuments,
  } = useDocuments();

  const [showAddMenu, setShowAddMenu] = useState(false);
  const dragIndexRef = useRef<number | null>(null);

  const handleDragStart = useCallback((index: number, event: DragEvent) => {
    dragIndexRef.current = index;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", String(index));
  }, []);

  const handleDragOver = useCallback((event: DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  const handleDrop = useCallback(
    (toIndex: number, event: DragEvent) => {
      event.preventDefault();
      const fromIndex = dragIndexRef.current;
      if (fromIndex === null || fromIndex === toIndex) return;
      reorderTabs(fromIndex, toIndex);
      dragIndexRef.current = null;
    },
    [reorderTabs],
  );

  if (!projectName) {
    return null;
  }

  const available = getAvailableDocuments();

  return (
    <div
      className="flex h-11 shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-card px-2"
      data-testid="document-tab-bar"
      onDragOver={handleDragOver}
    >
      {tabOrder.map((id, index) => {
        const doc = openDocuments.find((entry) => entry.id === id);
        if (!doc) return null;
        const active = id === activeDocumentId;

        return (
          <div
            key={id}
            draggable
            data-testid="document-tab"
            data-active={active ? "true" : "false"}
            data-document-kind={doc.ref.kind}
            className={`flex min-h-11 shrink-0 items-center gap-1 rounded-md border px-2 text-sm ${
              active
                ? "border-border bg-secondary text-secondary-foreground"
                : "border-transparent bg-transparent hover:bg-accent"
            }`}
            onDragStart={(event) => handleDragStart(index, event)}
            onDrop={(event) => handleDrop(index, event)}
            onDragOver={handleDragOver}
          >
            <GripVerticalIcon className="size-3 shrink-0 cursor-grab text-muted-foreground" />
            <button
              type="button"
              data-testid={
                active ? "document-tab-active" : "document-tab-select"
              }
              className="flex min-h-11 items-center gap-1.5"
              onClick={() => setActiveDocument(id)}
            >
              {kindIcon(doc.ref.kind)}
              <span>
                {doc.ref.label}
                {doc.dirty ? " *" : ""}
              </span>
            </button>
            <button
              type="button"
              data-testid="document-tab-close"
              className="flex size-11 items-center justify-center rounded-md hover:bg-accent"
              aria-label={`Close ${doc.ref.label}`}
              onClick={() => closeDocument(id)}
            >
              <XIcon className="size-4" />
            </button>
          </div>
        );
      })}

      <div className="relative shrink-0">
        <Button
          size="sm"
          variant="ghost"
          data-testid="document-tab-add"
          className="min-h-11"
          onClick={() => setShowAddMenu((open) => !open)}
        >
          <PlusIcon data-icon="inline-start" />
          Add
        </Button>
        {showAddMenu && available.length > 0 ? (
          <div className="absolute left-0 top-full z-50 mt-1 min-w-48 rounded-md border border-border bg-popover p-1 shadow-md">
            {available.map((item) => (
              <button
                key={`${item.kind}:${item.path}`}
                type="button"
                className="flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-accent"
                onClick={() => {
                  void openDocument({
                    kind: item.kind,
                    path: item.path,
                    label: labelFromPath(item.path),
                  });
                  setShowAddMenu(false);
                }}
              >
                {kindIcon(item.kind)}
                <span className="truncate">{labelFromPath(item.path)}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
