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
  ChevronDownIcon,
  FileJsonIcon,
  LayersIcon,
  LayoutGridIcon,
  PlayIcon,
  PlusIcon,
  Redo2Icon,
  SaveIcon,
  SaveAllIcon,
  SearchIcon,
  SettingsIcon,
  Undo2Icon,
  XIcon,
  BugIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  labelFromPath,
  CONTENT_BROWSER_ID,
  CONTENT_BROWSER_REF,
  type DocumentKind,
} from "@babylonslate/core";
import { isTestModeEnabled } from "@babylonslate/vfs";
import { Button } from "@babylonslate/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@babylonslate/ui/components/dropdown-menu";
import { useDocuments } from "../context/document-context";
import { usePlay } from "../context/play-context";
import { useValidation } from "../context/validation-context";
import { PlayBlockedDialog } from "./play-blocked-dialog";
import type { OpenDocument } from "../services/document-service";
import { SettingsModal } from "./settings-modal";
import { GlobalSearchDialog } from "./global-search-dialog";
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

  const { startPlay, playing, alwaysRender, setAlwaysRender, renderStats } =
    usePlay();
  const { diagnostics, errorCount, setFocusDiagnostic } = useValidation();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [playBlockedOpen, setPlayBlockedOpen] = useState(false);

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

  useEffect(() => {
    if (!projectName) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k") {
        return;
      }
      event.preventDefault();
      setSearchOpen((current) => !current);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [projectName]);

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
        <div className="editor-global-toolbar-start">
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
            <SaveAllIcon data-icon="inline-start" />
            Save All
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
        </div>

        <div className="editor-global-toolbar-center">
          <div className="editor-play-island" data-testid="play-debug-island">
            <Button
              size="sm"
              variant="ghost"
              data-testid="play-preview"
              className="chrome-action-button chrome-play-button relative"
              aria-label="Play"
              disabled={!projectName || playing}
              onClick={() => {
                const inject =
                  typeof window !== "undefined" &&
                  new URLSearchParams(window.location.search).get(
                    "previewThrow",
                  ) === "1";
                if (errorCount > 0 && !inject) {
                  setPlayBlockedOpen(true);
                  return;
                }
                startPlay({ injectFixtureThrow: inject });
              }}
            >
              <PlayIcon data-icon="inline-start" />
              Play
              {errorCount > 0 ? (
                <span
                  className="absolute -top-0.5 -right-0.5 flex size-4 items-center justify-center rounded-md bg-destructive text-[10px] text-white"
                  data-testid="play-error-badge"
                >
                  {errorCount > 9 ? "9+" : errorCount}
                </span>
              ) : null}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    size="sm"
                    variant="ghost"
                    data-testid="debug-menu"
                    className="chrome-action-button"
                    aria-label="Debug"
                    disabled={!projectName}
                  />
                }
              >
                <BugIcon data-icon="inline-start" />
                Debug
                <ChevronDownIcon data-icon="inline-end" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="center">
                <DropdownMenuLabel>Preview debug</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {isTestModeEnabled() || import.meta.env.DEV ? (
                  <DropdownMenuCheckboxItem
                    data-testid="always-render-toggle"
                    checked={alwaysRender}
                    onCheckedChange={(checked) =>
                      setAlwaysRender(checked === true)
                    }
                  >
                    Always Render
                    {renderStats
                      ? ` (${renderStats.renderedFps}/${renderStats.invalidationsPerSecond})`
                      : ""}
                  </DropdownMenuCheckboxItem>
                ) : (
                  <DropdownMenuItem disabled>
                    No debug options in this build
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <PlayBlockedDialog
            open={playBlockedOpen}
            diagnostics={diagnostics}
            onOpenChange={setPlayBlockedOpen}
            onNavigate={(d) => {
              setFocusDiagnostic(d);
              setPlayBlockedOpen(false);
            }}
            onPlayAnyway={() => {
              setPlayBlockedOpen(false);
              startPlay();
            }}
          />
        </div>

        <div className="editor-global-toolbar-end">
          <Button
            size="icon-sm"
            variant="ghost"
            data-testid="global-search"
            className="chrome-icon-button"
            aria-label="Search project"
            disabled={!projectName}
            onClick={() => setSearchOpen(true)}
          >
            <SearchIcon />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            data-testid="project-settings"
            className="chrome-action-button"
            aria-label="Project settings"
            disabled={!projectName}
            onClick={() => setSettingsOpen(true)}
          >
            <SettingsIcon data-icon="inline-start" />
            Project Settings
          </Button>
        </div>
      </div>

      <GlobalSearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
      <SettingsModal
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        initialScope="project"
        allowEngine
        onCloseProject={onCloseProject}
      />
    </div>
  );
}
