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
  HammerIcon,
  LayoutGridIcon,
  PlayIcon,
  Redo2Icon,
  SaveAllIcon,
  SearchIcon,
  SettingsIcon,
  Undo2Icon,
  XIcon,
  BugIcon,
  Maximize2Icon,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  CONTENT_BROWSER_ID,
  CONTENT_BROWSER_REF,
  assetTypeForDocumentKind,
  type DocumentKind,
  type SerializedGraph,
} from "@babylonslate/core";
import {
  TypeVisualIcon,
  documentHistoryHotkey,
  resolveTypeVisual,
} from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import { Toggle } from "@babylonslate/ui/components/toggle";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@babylonslate/ui/components/tooltip";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@babylonslate/ui/components/dropdown-menu";
import { useDocuments } from "../context/document-context";
import { usePlay } from "../context/play-context";
import { useValidation } from "../context/validation-context";
import type { OpenDocument } from "../services/document-service";
import { classParentLookup } from "../lib/content-browser-helpers";
import { classIdForGraphPath } from "../services/script-compiler";
import {
  classHierarchyFromParentOf,
  classMemberSymbolsFromGraphs,
  knownClassIdSet,
  validateSerializedGraph,
} from "../services/graph-validation";
import { collectClassGraphsForPalette } from "../lib/logic-graph-document";
import { SettingsModal } from "./settings-modal";
import { GlobalSearchDialog } from "./global-search-dialog";
import { IconActionButton } from "./icon-action-button";
import { CompilationErrorIndicator } from "./compilation-error-indicator";
import { WindowsMenu } from "./windows-menu";
import { displayProjectName } from "../lib/display-project-name";
import { canFocusLayout } from "../shell/layout-ops";
import "../shell/editor-chrome.css";

function kindIcon(kind: DocumentKind, assetType?: string) {
  if (kind === "content-browser") {
    return <LayoutGridIcon className="size-4 shrink-0" />;
  }
  const visual = resolveTypeVisual({
    assetType: assetType ?? assetTypeForDocumentKind(kind),
  });
  return <TypeVisualIcon visual={visual} className="size-4 shrink-0" />;
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
  const { assetRegistry } = useDocuments();
  const indexed = assetRegistry
    ?.list()
    .find((asset) => asset.path === doc.ref.path);
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
        {kindIcon(doc.ref.kind, indexed?.header.type)}
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
  onCloseDocument,
}: {
  onCloseProject?: () => void;
  onSaveProject?: () => void;
  onCloseDocument?: (id: string) => void;
}) {
  const {
    projectName,
    openDocuments,
    activeDocumentId,
    setActiveDocument,
    closeDocument,
    reorderClosableTabs,
    saveAll,
    dirtyDocuments,
    undoActiveDocument,
    redoActiveDocument,
    canUndoActiveDocument,
    canRedoActiveDocument,
    isLayoutFocused,
    toggleLayoutFocus,
    collectScriptBundles,
    graphsNeedCompile,
    activateDockPanel,
    assetRegistry,
  } = useDocuments();

  const {
    requestPlay,
    playing,
    preparing,
    canPlay,
    previewBuild,
    setPreviewBuild,
  } = usePlay();
  const { errorCount, setDiagnostics } = useValidation();
  const [settingsScope, setSettingsScope] = useState<
    "project" | "engine" | null
  >(null);
  const [searchOpen, setSearchOpen] = useState(false);

  const contentBrowserDoc = openDocuments.find(
    (doc) => doc.id === CONTENT_BROWSER_ID,
  );
  const closableDocs = openDocuments.filter(
    (doc) => doc.ref.kind !== "content-browser",
  );
  const activeKind = openDocuments.find((doc) => doc.id === activeDocumentId)
    ?.ref.kind;
  const canFocus = canFocusLayout(activeKind);

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
    const pointers = new Set<number>();
    const onPointerDown = (event: PointerEvent) => {
      pointers.add(event.pointerId);
    };
    const onPointerUp = (event: PointerEvent) => {
      pointers.delete(event.pointerId);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen((current) => !current);
        return;
      }
      const history = documentHistoryHotkey(event, {
        activePointerCount: pointers.size,
      });
      if (!history) return;
      event.preventDefault();
      if (history === "undo") undoActiveDocument();
      else redoActiveDocument();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [projectName, redoActiveDocument, undoActiveDocument]);

  return (
    <div className="editor-chrome-shell">
      <header className="editor-chrome-bar" data-testid="editor-chrome-bar">
        <div
          className="editor-chrome-title"
          data-testid="project-name"
          title={projectName ? displayProjectName(projectName) : undefined}
        >
          {projectName ? displayProjectName(projectName) : ""}
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
                  onClose={() =>
                    onCloseDocument
                      ? onCloseDocument(doc.id)
                      : closeDocument(doc.id)
                  }
                />
              ))}
            </SortableContext>
          </DndContext>
        </div>
      </header>

      <div
        className="editor-global-toolbar"
        data-testid="editor-global-toolbar"
      >
        <div className="editor-global-toolbar-start">
          <span className="relative inline-flex">
            <IconActionButton
              label={
                dirtyDocuments.length > 0
                  ? "Save All (unsaved changes)"
                  : "Save All"
              }
              data-testid="save-all-project"
              className="chrome-icon-button"
              disabled={!projectName || dirtyDocuments.length === 0}
              onClick={() => {
                if (onSaveProject) onSaveProject();
                else void saveAll();
              }}
            >
              <SaveAllIcon />
            </IconActionButton>
            {dirtyDocuments.length > 0 ? (
              <span
                data-testid="save-all-dirty"
                className="pointer-events-none absolute top-0.5 end-0.5 size-1.5 rounded-full bg-destructive"
              />
            ) : null}
          </span>
          <IconActionButton
            label="Undo"
            data-testid="undo-document"
            className="chrome-icon-button"
            disabled={!canUndoActiveDocument}
            onClick={() => undoActiveDocument()}
          >
            <Undo2Icon />
          </IconActionButton>
          <IconActionButton
            label="Redo"
            data-testid="redo-document"
            className="chrome-icon-button"
            disabled={!canRedoActiveDocument}
            onClick={() => redoActiveDocument()}
          >
            <Redo2Icon />
          </IconActionButton>
          {activeKind === "graph" ? (
            <>
              <Button
                size="sm"
                variant="outline"
                data-testid="compile-graph"
                className="chrome-action-button"
                aria-label="Compile"
                disabled={!projectName || !graphsNeedCompile}
                onClick={() => {
                  const graphs = openDocuments.filter(
                    (doc) => doc.ref.kind === "graph" && doc.content,
                  );
                  setDiagnostics(
                    graphs.flatMap((doc) => {
                      const parentOf = classParentLookup(
                        assetRegistry?.list() ?? [],
                      );
                      const classGraphs = collectClassGraphsForPalette({
                        assets: assetRegistry?.list() ?? [],
                        openDocuments,
                        classIdForPath: classIdForGraphPath,
                      });
                      return validateSerializedGraph(
                        doc.content as SerializedGraph,
                        {
                          assetGuid: doc.ref.path,
                          graphId: doc.id,
                          classId: classIdForGraphPath(doc.ref.path),
                          hierarchy: classHierarchyFromParentOf(parentOf),
                          members: classMemberSymbolsFromGraphs(classGraphs),
                          knownClassIds: knownClassIdSet(
                            parentOf,
                            Object.keys(classGraphs),
                          ),
                        },
                      );
                    }),
                  );
                  void collectScriptBundles();
                  activateDockPanel("compiler-results");
                }}
              >
                <HammerIcon data-icon="inline-start" />
                Compile
              </Button>
              <CompilationErrorIndicator
                errorCount={errorCount}
                onOpenResults={() => activateDockPanel("compiler-results")}
              />
            </>
          ) : null}
        </div>

        <div className="editor-global-toolbar-center">
          <div className="editor-play-island" data-testid="play-debug-island">
            <Button
              size="sm"
              variant="ghost"
              data-testid="play-preview"
              className="chrome-action-button chrome-play-button relative"
              aria-label={
                canPlay
                  ? "Play"
                  : previewBuild
                    ? "Play (Set Startup Scene)"
                    : "Play (Open a Scene)"
              }
              title={
                canPlay
                  ? undefined
                  : previewBuild
                    ? "Set Startup Scene in Project Settings."
                    : "Open a scene to play"
              }
              disabled={!projectName || playing || preparing || !canPlay}
              onClick={() => {
                const inject =
                  typeof window !== "undefined" &&
                  new URLSearchParams(window.location.search).get(
                    "previewThrow",
                  ) === "1";
                void requestPlay({ injectFixtureThrow: inject });
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
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Preview debug</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuCheckboxItem
                    data-testid="preview-build-toggle"
                    checked={previewBuild}
                    disabled={playing || preparing}
                    onCheckedChange={(checked) =>
                      setPreviewBuild(checked === true)
                    }
                  >
                    Preview Build
                  </DropdownMenuCheckboxItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <div className="editor-global-toolbar-end">
          <WindowsMenu />
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  variant="outline"
                  size="sm"
                  aria-label="Focus"
                  pressed={isLayoutFocused}
                  disabled={!projectName || !canFocus}
                  onPressedChange={() => toggleLayoutFocus()}
                  data-testid="focus-layout"
                  className="chrome-icon-button"
                >
                  <Maximize2Icon />
                </Toggle>
              }
            />
            <TooltipContent>Focus</TooltipContent>
          </Tooltip>
          <IconActionButton
            label="Search project"
            data-testid="global-search"
            className="chrome-icon-button"
            disabled={!projectName}
            onClick={() => setSearchOpen(true)}
          >
            <SearchIcon />
          </IconActionButton>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="settings-menu"
                  className="chrome-action-button"
                  aria-label="Settings"
                  disabled={!projectName}
                />
              }
            >
              <SettingsIcon data-icon="inline-start" />
              Settings
              <ChevronDownIcon data-icon="inline-end" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                data-testid="project-settings"
                onClick={() => setSettingsScope("project")}
              >
                Project Settings
              </DropdownMenuItem>
              <DropdownMenuItem
                data-testid="engine-settings"
                onClick={() => setSettingsScope("engine")}
              >
                Engine Settings
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <GlobalSearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
      <SettingsModal
        open={settingsScope === "project"}
        onOpenChange={(open) => {
          if (!open) setSettingsScope(null);
        }}
        scope="project"
        onCloseProject={onCloseProject}
      />
      <SettingsModal
        open={settingsScope === "engine"}
        onOpenChange={(open) => {
          if (!open) setSettingsScope(null);
        }}
        scope="engine"
      />
    </div>
  );
}
