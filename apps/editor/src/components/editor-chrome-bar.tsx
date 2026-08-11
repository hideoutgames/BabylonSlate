import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  FileJsonIcon,
  LayersIcon,
  LayoutGridIcon,
  LogOutIcon,
  PlusIcon,
  Redo2Icon,
  SaveIcon,
  SettingsIcon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import { useState } from "react";
import {
  labelFromPath,
  CONTENT_BROWSER_ID,
  CONTENT_BROWSER_REF,
  type DocumentKind,
} from "@babylonslate/core";
import { Button } from "@babylonslate/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@babylonslate/ui/components/dropdown-menu";
import { useDocuments } from "../context/document-context";
import type { OpenDocument } from "../services/document-service";
import { ProjectSettingsSheet } from "./project-settings-sheet";
import "../shell/editor-chrome.css";

function kindIcon(kind: DocumentKind) {
  if (kind === "content-browser") {
    return <LayoutGridIcon className="size-4 shrink-0" />;
  }
  return kind === "scene" ? (
    <LayersIcon className="size-4 shrink-0" />
  ) : (
    <FileJsonIcon className="size-4 shrink-0" />
  );
}

interface SortableTabProps {
  doc: OpenDocument;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}

function SortableDocumentTab({
  doc,
  active,
  onSelect,
  onClose,
}: SortableTabProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: doc.id });

  const style = {
    transform: transform
      ? CSS.Transform.toString({ ...transform, y: 0 })
      : undefined,
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-testid="document-tab"
      data-active={active ? "true" : "false"}
      data-document-kind={doc.ref.kind}
      className={`chrome-tab chrome-tab-closable ${active ? "chrome-tab-active" : ""} ${isDragging ? "chrome-tab-dragging" : ""}`}
      {...attributes}
      {...listeners}
    >
      <button
        type="button"
        data-testid={active ? "document-tab-active" : "document-tab-select"}
        className="chrome-tab-label"
        onClick={onSelect}
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
        className="chrome-tab-close"
        aria-label={`Close ${doc.ref.label}`}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={onClose}
      >
        <XIcon />
      </button>
    </div>
  );
}

function PinnedContentBrowserTab({
  active,
  onSelect,
}: {
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      data-testid="document-tab"
      data-active={active ? "true" : "false"}
      data-document-kind="content-browser"
      data-pinned="true"
      className={`chrome-tab chrome-tab-pinned ${active ? "chrome-tab-active" : ""}`}
    >
      <button
        type="button"
        data-testid={active ? "document-tab-active" : "document-tab-select"}
        className="chrome-tab-label"
        onClick={onSelect}
      >
        {kindIcon("content-browser")}
        <span>{CONTENT_BROWSER_REF.label}</span>
      </button>
    </div>
  );
}

const TAB_DRAG_ACTIVATION = { delay: 300, tolerance: 8 } as const;

export function EditorChromeBar({
  onCloseProject,
  onSaveProject,
}: {
  onCloseProject?: () => void;
  onSaveProject?: () => void;
}) {
  const {
    projectName,
    openDocuments,
    activeDocumentId,
    setActiveDocument,
    closeDocument,
    reorderClosableTabs,
    saveProject,
    saveAll,
    undoActiveDocument,
    redoActiveDocument,
    canUndoActiveDocument,
    canRedoActiveDocument,
    openDocument,
    getAvailableDocuments,
  } = useDocuments();

  const [settingsOpen, setSettingsOpen] = useState(false);

  const contentBrowserDoc = openDocuments.find(
    (doc) => doc.id === CONTENT_BROWSER_ID,
  );
  const closableDocs = openDocuments.filter(
    (doc) => doc.ref.kind !== "content-browser",
  );
  const available = getAvailableDocuments();

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: TAB_DRAG_ACTIVATION,
    }),
    useSensor(TouchSensor, {
      activationConstraint: TAB_DRAG_ACTIVATION,
    }),
    useSensor(KeyboardSensor),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const fromIndex = closableDocs.findIndex((doc) => doc.id === active.id);
    const toIndex = closableDocs.findIndex((doc) => doc.id === over.id);
    if (fromIndex < 0 || toIndex < 0) return;

    reorderClosableTabs(fromIndex, toIndex);
  };

  return (
    <div className="editor-chrome-shell">
      <header
        className="editor-chrome-bar"
        data-testid="editor-chrome-bar"
      >
        <div
          className="editor-chrome-title"
          data-testid="project-name"
          title={projectName ?? undefined}
        >
          {projectName ?? ""}
        </div>

        <div className="editor-chrome-tabs" data-testid="document-tab-bar">
          {contentBrowserDoc ? (
            <PinnedContentBrowserTab
              active={activeDocumentId === CONTENT_BROWSER_ID}
              onSelect={() => setActiveDocument(CONTENT_BROWSER_ID)}
            />
          ) : null}

          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={closableDocs.map((doc) => doc.id)}
              strategy={horizontalListSortingStrategy}
            >
              {closableDocs.map((doc) => (
                <SortableDocumentTab
                  key={doc.id}
                  doc={doc}
                  active={doc.id === activeDocumentId}
                  onSelect={() => setActiveDocument(doc.id)}
                  onClose={() => closeDocument(doc.id)}
                />
              ))}
            </SortableContext>
          </DndContext>

          {projectName && available.length > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    size="sm"
                    variant="ghost"
                    data-testid="document-tab-add"
                    className="chrome-action-button shrink-0"
                  />
                }
              >
                <PlusIcon data-icon="inline-start" />
                Add
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {available.map((item) => (
                  <DropdownMenuItem
                    key={`${item.kind}:${item.path}`}
                    data-testid={`add-document-${item.kind}-${item.path.replace(/\//g, "-")}`}
                    onClick={() => {
                      void openDocument({
                        kind: item.kind,
                        path: item.path,
                        label: labelFromPath(item.path),
                      });
                    }}
                  >
                    {kindIcon(item.kind)}
                    <span className="truncate">{labelFromPath(item.path)}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </header>

      <div
        className="editor-global-toolbar"
        data-testid="editor-global-toolbar"
      >
        <div className="editor-global-toolbar-actions">
          <Button
            size="sm"
            variant="ghost"
            data-testid="undo-document"
            className="chrome-action-button"
            aria-label="Undo"
            disabled={!canUndoActiveDocument}
            onClick={() => undoActiveDocument()}
          >
            <Undo2Icon data-icon="inline-start" />
            Undo
          </Button>
          <Button
            size="sm"
            variant="ghost"
            data-testid="redo-document"
            className="chrome-action-button"
            aria-label="Redo"
            disabled={!canRedoActiveDocument}
            onClick={() => redoActiveDocument()}
          >
            <Redo2Icon data-icon="inline-start" />
            Redo
          </Button>
          <Button
            size="sm"
            variant="ghost"
            data-testid="save-project"
            className="chrome-action-button"
            disabled={!projectName}
            onClick={() => {
              if (onSaveProject) onSaveProject();
              else void saveProject();
            }}
          >
            <SaveIcon data-icon="inline-start" />
            Save
          </Button>
          <Button
            size="sm"
            variant="ghost"
            data-testid="save-all-project"
            className="chrome-action-button"
            disabled={!projectName}
            onClick={() => {
              if (onSaveProject) onSaveProject();
              else void saveAll();
            }}
          >
            <SaveIcon data-icon="inline-start" />
            Save All
          </Button>
          <Button
            size="sm"
            variant="ghost"
            data-testid="close-project"
            className="chrome-action-button"
            disabled={!projectName}
            onClick={() => onCloseProject?.()}
          >
            <LogOutIcon data-icon="inline-start" />
            Close
          </Button>
        </div>

        <Button
          size="icon-sm"
          variant="ghost"
          data-testid="project-settings"
          className="chrome-icon-button"
          aria-label="Project settings"
          disabled={!projectName}
          onClick={() => setSettingsOpen(true)}
        >
          <SettingsIcon />
        </Button>
      </div>

      <ProjectSettingsSheet open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
}
