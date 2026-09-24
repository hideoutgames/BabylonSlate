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
  RefreshCwIcon,
  SaveAllIcon,
  SearchIcon,
  SettingsIcon,
  Undo2Icon,
  XIcon,
  BugIcon,
  Maximize2Icon,
  EllipsisIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  CONTENT_BROWSER_ID,
  type DocumentRef,
  type SerializedGraph,
} from "@babylonslate/core";
import {
  TypeVisualIcon,
  documentHistoryHotkey,
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
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuGroup,
  DropdownMenuTrigger,
} from "@babylonslate/ui/components/dropdown-menu";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@babylonslate/ui/components/sheet";
import { cn } from "@babylonslate/ui/lib/utils";
import { usePhoneLayout } from "../shell/use-platform-layout";
import { DocumentSwitcher } from "./document-switcher";
import { useDocuments } from "../context/document-context";
import { usePlay } from "../context/play-context";
import { useValidation } from "../context/validation-context";
import type { OpenDocument } from "../services/document-service";
import { physicsPairingDiagnostics } from "../lib/physics-pairing-diagnostics";
import { PREFAB_ROOT_ID } from "../lib/prefab-preview";
import { SettingsModal } from "./settings-modal";
import { GlobalSearchDialog } from "./global-search-dialog";
import { IconActionButton } from "./icon-action-button";
import { ActionFeedbackButton } from "./action-feedback-button";
import { CompilationErrorIndicator } from "./compilation-error-indicator";
import { WindowsMenu } from "./windows-menu";
import { PlayDebugMenuItems } from "./play-debug-menu-items";
import { displayProjectName } from "../lib/display-project-name";
import { useMaterialRenderControl } from "../context/material-render-control-context";
import {
  playChromeLaunchAriaLabel,
  playChromeLaunchLabel,
} from "../lib/play-chrome-label";
import { canFocusLayout } from "../shell/layout-ops";
import type { IndexedAsset } from "@babylonslate/assets";
import { documentTypeVisual } from "../lib/document-type-visual";
import "../shell/editor-chrome.css";

function kindIcon(ref: DocumentRef, assets: readonly IndexedAsset[]) {
  if (ref.kind === "content-browser") {
    return <LayoutGridIcon className="size-4 shrink-0" />;
  }
  const visual = documentTypeVisual(ref, assets);
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
      className={cn(
        "chrome-tab chrome-tab-closable",
        active && "chrome-tab-active",
        isDragging && "chrome-tab-dragging",
      )}
      {...attributes}
      {...listeners}
    >
      <Button
        variant="ghost"
        size="sm"
        data-testid={active ? "document-tab-active" : "document-tab-select"}
        className="chrome-tab-label"
        aria-current={active ? "page" : undefined}
        onClick={onSelect}
      >
        {kindIcon(doc.ref, assetRegistry?.list() ?? [])}
        <span>
          {doc.ref.label}
          {doc.dirty ? " *" : ""}
        </span>
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        data-testid="document-tab-close"
        className="chrome-tab-close"
        aria-label={`Close ${doc.ref.label}`}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={onClose}
      >
        <XIcon />
      </Button>
    </div>
  );
}

function PinnedDocumentTab({
  doc,
  active,
  onSelect,
  onClose,
}: {
  doc: OpenDocument;
  active: boolean;
  onSelect: () => void;
  onClose?: () => void;
}) {
  const { assetRegistry } = useDocuments();

  return (
    <div
      data-testid="document-tab"
      data-active={active ? "true" : "false"}
      data-document-kind={doc.ref.kind}
      data-pinned="true"
      className={cn(
        "chrome-tab chrome-tab-pinned",
        active && "chrome-tab-active",
      )}
    >
      <Button
        variant="ghost"
        size="sm"
        data-testid={active ? "document-tab-active" : "document-tab-select"}
        className="chrome-tab-label"
        aria-current={active ? "page" : undefined}
        onClick={onSelect}
      >
        {kindIcon(doc.ref, assetRegistry?.list() ?? [])}
        <span>
          {doc.ref.label}
          {doc.dirty ? " *" : ""}
        </span>
      </Button>
      {onClose ? (
        <Button
          variant="ghost"
          size="icon-sm"
          data-testid="document-tab-close"
          className="chrome-tab-close"
          aria-label={`Close ${doc.ref.label}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onClose}
        >
          <XIcon />
        </Button>
      ) : null}
    </div>
  );
}

const TAB_DRAG_ACTIVATION = { delay: 300, tolerance: 8 } as const;

export function EditorChromeBar({
  onCloseProject,
  onSaveProject,
  onCloseDocument,
  onCloseAllDocuments,
}: {
  onCloseProject?: () => void;
  onSaveProject?: () => Promise<boolean>;
  onCloseDocument?: (id: string) => void;
  onCloseAllDocuments?: () => void;
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
    projectDirty,
    undoActiveDocument,
    redoActiveDocument,
    canUndoActiveDocument,
    canRedoActiveDocument,
    isLayoutFocused,
    toggleLayoutFocus,
    collectPlayPreviewScripts,
    graphsNeedCompile,
    activateDockPanel,
    assetRegistry,
  } = useDocuments();
  const { control: materialRenderControl } = useMaterialRenderControl();

  const {
    requestPlay,
    playing,
    preparing,
    canPlay,
    previewBuild,
    setPreviewBuild,
    playFromScene,
    setPlayFromScene,
    overlayStats,
    overlayConsole,
    overlayInspector,
    pauseOnPlay,
    setOverlayStats,
    setOverlayConsole,
    setOverlayInspector,
    setPauseOnPlay,
  } = usePlay();
  const { errorCount, setDiagnostics } = useValidation();
  const [settingsScope, setSettingsScope] = useState<
    "project" | "engine" | null
  >(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const phone = usePhoneLayout();

  const contentBrowserDoc = openDocuments.find(
    (doc) => doc.id === CONTENT_BROWSER_ID,
  );
  const pinnedSceneDoc = openDocuments.find((doc) => doc.ref.kind === "scene");
  const scrollableDocs = openDocuments.filter(
    (doc) => doc.ref.kind !== "content-browser" && doc.ref.kind !== "scene",
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

    const fromIndex = scrollableDocs.findIndex((doc) => doc.id === active.id);
    const toIndex = scrollableDocs.findIndex((doc) => doc.id === over.id);
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

  const openSearch = () => {
    setToolsOpen(false);
    setSearchOpen(true);
  };
  const openSettings = (scope: "project" | "engine") => {
    setToolsOpen(false);
    setSettingsScope(scope);
  };
  const debugMenu = (
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
      <PlayDebugMenuItems
        overlayStats={overlayStats}
        overlayConsole={overlayConsole}
        overlayInspector={overlayInspector}
        pauseOnPlay={pauseOnPlay}
        previewBuild={previewBuild}
        playFromScene={playFromScene}
        sessionLocked={playing || preparing}
        onOverlayStatsChange={setOverlayStats}
        onOverlayConsoleChange={setOverlayConsole}
        onOverlayInspectorChange={setOverlayInspector}
        onPauseOnPlayChange={setPauseOnPlay}
        onPreviewBuildChange={setPreviewBuild}
        onPlayFromSceneChange={setPlayFromScene}
      />
    </DropdownMenu>
  );
  const utilityTools = (
    <>
      {phone && activeKind === "graph" ? (
        <CompilationErrorIndicator
          errorCount={errorCount}
          onOpenResults={() => {
            setToolsOpen(false);
            activateDockPanel("compiler-results");
          }}
        />
      ) : null}
      <WindowsMenu />
      {!phone ? (
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
      ) : null}
      {phone ? (
        <Button
          variant="outline"
          size="touch"
          data-testid="global-search"
          disabled={!projectName}
          onClick={openSearch}
        >
          <SearchIcon data-icon="inline-start" /> Search Project
        </Button>
      ) : (
        <IconActionButton
          label="Search project"
          data-testid="global-search"
          className="chrome-icon-button"
          disabled={!projectName}
          onClick={openSearch}
        >
          <SearchIcon />
        </IconActionButton>
      )}
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
          <DropdownMenuGroup>
            <DropdownMenuItem
              data-testid="project-settings"
              onClick={() => openSettings("project")}
            >
              Project Settings
            </DropdownMenuItem>
            <DropdownMenuItem
              data-testid="engine-settings"
              onClick={() => openSettings("engine")}
            >
              Engine Settings
            </DropdownMenuItem>
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );

  return (
    <div className="editor-chrome-shell" data-phone={phone ? "true" : "false"}>
      <header className="editor-chrome-bar" data-testid="editor-chrome-bar">
        {!phone ? (
          <div
            className="editor-chrome-title"
            data-testid="project-name"
            title={projectName ? displayProjectName(projectName) : undefined}
          >
            {projectName ? displayProjectName(projectName) : ""}
          </div>
        ) : null}
        {phone ? (
          <div className="editor-phone-documents">
            <Button
              variant="ghost"
              size="touch-icon"
              aria-label="Content Browser"
              title="Content Browser"
              onClick={() => setActiveDocument(CONTENT_BROWSER_ID)}
              aria-current={
                activeDocumentId === CONTENT_BROWSER_ID ? "page" : undefined
              }
            >
              <LayoutGridIcon />
            </Button>
            <DocumentSwitcher
              documents={openDocuments}
              assets={assetRegistry?.list()}
              activeDocumentId={activeDocumentId}
              onSelect={setActiveDocument}
              onClose={onCloseDocument ?? closeDocument}
              onCloseAll={onCloseAllDocuments}
              compact
            />
          </div>
        ) : (
          <div className="editor-chrome-tabs" data-testid="document-tab-bar">
            <div
              className="editor-chrome-tabs-pinned"
              data-testid="document-tab-pinned"
            >
              {contentBrowserDoc ? (
                <PinnedDocumentTab
                  doc={contentBrowserDoc}
                  active={activeDocumentId === CONTENT_BROWSER_ID}
                  onSelect={() => setActiveDocument(CONTENT_BROWSER_ID)}
                />
              ) : null}
              {pinnedSceneDoc ? (
                <PinnedDocumentTab
                  doc={pinnedSceneDoc}
                  active={activeDocumentId === pinnedSceneDoc.id}
                  onSelect={() => setActiveDocument(pinnedSceneDoc.id)}
                  onClose={() =>
                    onCloseDocument
                      ? onCloseDocument(pinnedSceneDoc.id)
                      : closeDocument(pinnedSceneDoc.id)
                  }
                />
              ) : null}
            </div>

            <div
              className="editor-chrome-tabs-scroll"
              data-testid="document-tab-scroll"
            >
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
              >
                <SortableContext
                  items={scrollableDocs.map((doc) => doc.id)}
                  strategy={horizontalListSortingStrategy}
                >
                  {scrollableDocs.map((doc) => (
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
            <DocumentSwitcher
              documents={openDocuments}
              assets={assetRegistry?.list()}
              activeDocumentId={activeDocumentId}
              onSelect={setActiveDocument}
              onClose={onCloseDocument ?? closeDocument}
              onCloseAll={onCloseAllDocuments}
            />
          </div>
        )}
      </header>

      <div
        className="editor-global-toolbar"
        data-testid="editor-global-toolbar"
      >
        <div className="editor-global-toolbar-start">
          <span className="relative inline-flex">
            <ActionFeedbackButton
              key={`save:${projectName}`}
              icon={SaveAllIcon}
              iconOnly
              label={
                dirtyDocuments.length > 0 || projectDirty
                  ? "Save All (unsaved changes)"
                  : "Save All"
              }
              data-testid="save-all-project"
              className="chrome-icon-button"
              disabled={
                !projectName || (dirtyDocuments.length === 0 && !projectDirty)
              }
              onAction={onSaveProject ?? saveAll}
            />
            {dirtyDocuments.length > 0 || projectDirty ? (
              <span
                data-testid="save-all-dirty"
                className="pointer-events-none absolute top-0.5 end-0.5 size-1.5 rounded-full bg-destructive"
              />
            ) : null}
          </span>
          <ActionFeedbackButton
            key={`undo:${activeDocumentId}`}
            icon={Undo2Icon}
            iconOnly
            showSuccessIcon={false}
            label="Undo"
            data-testid="undo-document"
            className="chrome-icon-button"
            disabled={!canUndoActiveDocument}
            onAction={() => undoActiveDocument()}
          />
          <ActionFeedbackButton
            key={`redo:${activeDocumentId}`}
            icon={Redo2Icon}
            iconOnly
            showSuccessIcon={false}
            label="Redo"
            data-testid="redo-document"
            className="chrome-icon-button"
            disabled={!canRedoActiveDocument}
            onAction={() => redoActiveDocument()}
          />
          {activeKind === "graph" ? (
            <>
              <ActionFeedbackButton
                key={`compile:${activeDocumentId}`}
                icon={HammerIcon}
                data-testid="compile-graph"
                className="chrome-action-button"
                label="Compile"
                disabled={!projectName || !graphsNeedCompile}
                onAction={async () => {
                  activateDockPanel("compiler-results");
                  const result = await collectPlayPreviewScripts();
                  const diagnostics = [
                    ...result.diagnostics,
                    ...openDocuments
                      .filter((doc) => doc.ref.kind === "graph" && doc.content)
                      .flatMap((doc) =>
                        physicsPairingDiagnostics(
                          [
                            {
                              id: PREFAB_ROOT_ID,
                              components:
                                (doc.content as SerializedGraph).components ??
                                [],
                            },
                          ],
                          { assetGuid: doc.ref.path, graphId: doc.id },
                        ),
                      ),
                  ];
                  setDiagnostics(diagnostics);
                  const errors = diagnostics.filter(
                    (entry) => entry.severity === "error",
                  );
                  if (errors.length)
                    throw new Error(
                      `${errors.length} Error(s). See Compiler Results.`,
                    );
                }}
              >
                <span className="chrome-optional-label">Compile</span>
              </ActionFeedbackButton>
              {!phone ? (
                <CompilationErrorIndicator
                  errorCount={errorCount}
                  onOpenResults={() => activateDockPanel("compiler-results")}
                />
              ) : null}
            </>
          ) : null}
          {activeKind === "material" ? (
            <ActionFeedbackButton
              key={`render:${activeDocumentId}`}
              icon={RefreshCwIcon}
              feedback={materialRenderControl?.feedback}
              data-testid="material-render"
              className="chrome-action-button"
              label="Render"
              disabled={
                !projectName ||
                !materialRenderControl ||
                materialRenderControl.disabled
              }
              onAction={() => materialRenderControl?.requestRender()}
            >
              <span className="chrome-optional-label">Render</span>
            </ActionFeedbackButton>
          ) : null}
        </div>

        <div className="editor-global-toolbar-center">
          <div className="editor-play-island" data-testid="play-debug-island">
            <Button
              size="sm"
              variant="ghost"
              data-testid="play-preview"
              className="chrome-action-button chrome-play-button relative"
              aria-label={playChromeLaunchAriaLabel(previewBuild, canPlay, {
                playFromScene,
              })}
              title={
                canPlay
                  ? undefined
                  : playFromScene && !previewBuild
                    ? "Open a scene to play"
                    : "Set Startup Scene in Project Settings."
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
              <PlayIcon data-icon="inline-start" fill="currentColor" />
              {phone && previewBuild
                ? "Build"
                : playChromeLaunchLabel(previewBuild)}
              {errorCount > 0 ? (
                <span
                  className="absolute -top-0.5 -right-0.5 flex size-4 items-center justify-center rounded-md bg-destructive text-[10px] text-white"
                  data-testid="play-error-badge"
                >
                  {errorCount > 9 ? "9+" : errorCount}
                </span>
              ) : null}
            </Button>
            {!phone ? debugMenu : null}
          </div>
        </div>

        <div className="editor-global-toolbar-end">
          {phone ? (
            <Sheet open={toolsOpen} onOpenChange={setToolsOpen}>
              <SheetTrigger
                render={
                  <Button
                    variant="outline"
                    size="touch-icon"
                    aria-label="More Tools"
                    data-testid="editor-more-tools"
                  />
                }
              >
                <EllipsisIcon />
              </SheetTrigger>
              <SheetContent
                side="bottom"
                className="editor-tools-sheet"
                data-testid="editor-tools-sheet"
              >
                <SheetHeader>
                  <SheetTitle>Editor Tools</SheetTitle>
                </SheetHeader>
                <div className="editor-tools-sheet-actions">
                  {debugMenu}
                  {utilityTools}
                </div>
              </SheetContent>
            </Sheet>
          ) : (
            utilityTools
          )}
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
