import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowUpDownIcon,
  CheckCheckIcon,
  ChevronDownIcon,
  CircleCheckIcon,
  FolderGit2Icon,
  FolderOpenIcon,
  Grid2x2Icon,
  Grid3x3Icon,
  LayoutTemplateIcon,
  ListIcon,
  LoaderCircleIcon,
  PlusIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import {
  DEFAULT_RENDER_HEIGHT,
  DEFAULT_RENDER_WIDTH,
  PIXEL_ART_DESIGN_SIZES,
  type ProjectAppearance,
  type ProjectFolderHandle,
} from "@haptic/core";
import { SearchInput } from "@haptic/editor-kit";
import {
  getHostPlatform,
  isTestModeEnabled,
  pickImportFiles,
  type NewProjectHosting,
} from "@haptic/vfs";
import { isSourceControlHost } from "@haptic/source-control";
import { Alert, AlertDescription } from "@haptic/ui/components/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@haptic/ui/components/alert-dialog";
import { Button } from "@haptic/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuGroup,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@haptic/ui/components/dropdown-menu";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
} from "@haptic/ui/components/empty";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@haptic/ui/components/toggle-group";
import {
  filterListedProjects,
  HOMEPAGE_PROJECT_SORT_OPTIONS,
  removeDeletesProject,
  sortListedProjects,
  type HomepageProjectSortMode,
  type ListedProject,
  type UpdateListedProjectOptions,
} from "../lib/listed-projects";
import {
  createProjectNameIssue,
  isBuiltInStarterKind,
  randomProjectName,
  normalizeProjectFolderName,
  remoteNeedsAppStorage,
  type CreateProjectOptions,
  type LaunchPhase,
} from "../lib/create-project";
import { brandWordmarkSrc } from "../lib/branding";
import { getBuildLabel } from "../lib/build-identity";
import { HomepageAccount } from "./homepage-account";
import { useNativeHomepageAccount } from "./homepage-account-context";
import { HomepageDiscordBadge } from "./homepage-discord-badge";
import { HomepageUpdateBadge } from "./homepage-update-badge";
import { ReleaseNews } from "./release-news";
import { HomepageCreateDialog } from "./homepage-create-dialog";
import { ExecuteJavaScriptImportDialog, useExecuteJavaScriptReview } from "./execute-javascript-import-dialog";
import { HomepageDeleteProjectsDialog } from "./homepage-delete-projects-dialog";
import { HomepageGallery } from "./homepage-gallery";
import { HomepageProjectCard } from "./homepage-project-card";
import { HomepageWelcome } from "./homepage-welcome";
import { DEFAULT_PROJECT_APPEARANCE } from "./homepage-project-appearance";
import {
  HomepageTemplateBrowser,
  homepageTemplates,
  recordTemplateUse,
} from "./homepage-template-browser";
import { importTemplateArchive } from "../services/template-service";
import { getAppSettingsSnapshot, updateAppSettings, useDebugMode } from "../context/app-settings-context";
import { useLauncherTransition } from "./launcher-transition";
import type { CloneProjectRequest } from "../context/document-context-types";
import type { TransferMonitor } from "../services/source-control-sync";
import type { NewRepositoryRequest } from "../services/source-control-publish";
import homepageStyles from "./homepage.css?inline";

const SettingsModal = lazy(() =>
  import("./settings-modal").then((module) => ({
    default: module.SettingsModal,
  })),
);
// Clone (host APIs, the Git client) loads when it is opened.
const CloneProjectDialog = lazy(() => import("./clone-project-dialog"));

const PROJECT_LAYOUT_OPTIONS = [
  { value: "large", label: "Large Cards", icon: Grid2x2Icon },
  { value: "small", label: "Small Cards", icon: Grid3x3Icon },
  { value: "list", label: "List", icon: ListIcon },
] as const;

function storageLocationLabel(hostPlatform: string) {
  if (hostPlatform === "web") return "Browser Storage";
  if (hostPlatform === "electron") return "Projects Folder";
  return "App Documents";
}

interface HomepageProps {
  projects: ListedProject[];
  dataReady?: boolean;
  templates: Array<{ id: string; name: string; imageUrl?: string }>;
  needsReconnect: boolean;
  recoveryAvailable: boolean;
  onCreateEmpty: (
    name: string,
    options?: CreateProjectOptions,
  ) => Promise<void>;
  onCreateFromTemplate: (
    templateId: string,
    name: string,
    options?: CreateProjectOptions,
  ) => Promise<void>;
  onOpenExternal: (source?: "folder" | "zip") => Promise<void>;
  onOpenProject: (handle: ProjectFolderHandle) => Promise<void>;
  /** Clone Project; the clone then opens like a listed project. */
  onCloneProject?: (request: CloneProjectRequest, transfer: TransferMonitor, signal: AbortSignal) => Promise<ProjectFolderHandle>;
  onUpdateProject: (
    handle: ProjectFolderHandle,
    details: UpdateListedProjectOptions,
  ) => Promise<void>;
  onRemoveFromList: (handle: ProjectFolderHandle) => Promise<void>;
  onReconnect: () => Promise<void>;
  onRecover: () => void | Promise<void>;
  onDismissRecovery: () => void;
  onSettingsChanged: () => Promise<void>;
}

export function Homepage({
  projects,
  dataReady = true,
  templates,
  needsReconnect,
  recoveryAvailable,
  onCreateEmpty,
  onCreateFromTemplate,
  onOpenExternal,
  onOpenProject,
  onCloneProject,
  onUpdateProject,
  onRemoveFromList,
  onReconnect,
  onRecover,
  onDismissRecovery,
  onSettingsChanged,
}: HomepageProps) {
  const transition = useLauncherTransition();
  useEffect(() => {
    transition.reportHomeLoading(
      !dataReady
        ? "Loading project library"
        : "Preparing interface",
    );
  }, [dataReady, transition.reportHomeLoading]);
  useEffect(() => {
    if (!dataReady) return;
    let cancelled = false;
    const images = Array.from(
      document.querySelectorAll<HTMLImageElement>(
        '[data-testid="homepage"] img',
      ),
    );
    void Promise.allSettled([
      document.fonts.ready,
      ...images.map((image) => image.decode()),
    ]).then(() => {
      if (!cancelled) transition.ready("home");
    });
    return () => {
      cancelled = true;
    };
  }, [dataReady, projects.length, transition.ready]);
  // A New Project's Engine Plugins with Execute JavaScript: asked while the launcher card shows, so above it.
  const executeJavaScript = useExecuteJavaScriptReview();
  const launch = async (
    action: () => Promise<void>,
    label = "Haptic",
    phase: LaunchPhase = "opening",
  ) => {
    transition.begin(label, phase);
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    try {
      await action();
    } finally {
      transition.settle();
    }
  };

  const [view, setView] = useState("projects");
  const [layout, setLayout] = useState<"large" | "small" | "list">(() => {
    try {
      const saved = localStorage.getItem("haptic:project-layout");
      return saved === "small" || saved === "list" ? saved : "large";
    } catch {
      return "large";
    }
  });
  const changeLayout = (value: "large" | "small" | "list") => {
    setLayout(value);
    try {
      localStorage.setItem("haptic:project-layout", value);
    } catch {
      /* Optional preference. */
    }
  };

  const debugMode = useDebugMode();
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<HomepageProjectSortMode>("last-opened-desc");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [accountOpen, setAccountOpen] = useState(false);
  /** The signed-in account, null for a guest, undefined until sign-in settles. */
  const [accountId, setAccountId] = useState<string | null>();
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [chooseTemplate, setChooseTemplate] = useState(true);
  const [editTarget, setEditTarget] = useState<ListedProject | null>(null);
  const [removeTarget, setRemoveTarget] = useState<ListedProject | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  /** Selection mode: cards toggle their selection instead of opening. */
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  /** The selection as listed in the Delete dialog; fixed while it is open. */
  const [deleteTargets, setDeleteTargets] = useState<ListedProject[]>([]);
  const [deleteOpen, setDeleteOpen] = useState(false);
  // The mobile account gate checks the session again whenever the window
  // regains focus (iOS also sends focus while the app stays in front) and
  // covers the Homepage meanwhile, which would unmount a form or confirmation
  // being filled in. While one is open the check waits, and it runs once the
  // last one closes.
  const holdSessionCheck = useNativeHomepageAccount()?.profile.holdSessionCheck;
  const holdSessionCheckRef = useRef(holdSessionCheck);
  holdSessionCheckRef.current = holdSessionCheck;
  const formOpen = createOpen || cloneOpen || settingsOpen || accountOpen || removeOpen || deleteOpen;
  useEffect(() => {
    if (formOpen) return holdSessionCheckRef.current?.({ checkWhenReleased: true });
  }, [formOpen]);
  const [name, setName] = useState("");
  // Shown as the Name placeholder; used when the field is left empty.
  const [suggestedName, setSuggestedName] = useState("");
  const [appearance, setAppearance] = useState<ProjectAppearance>(
    DEFAULT_PROJECT_APPEARANCE,
  );
  const [templateId, setTemplateId] = useState("blank");
  const [width, setWidth] = useState(DEFAULT_RENDER_WIDTH);
  const [height, setHeight] = useState(DEFAULT_RENDER_HEIGHT);
  const [blackBars, setBlackBars] = useState(false);
  const [pixelArt, setPixelArt] = useState(false);
  const [pickFolder, setPickFolder] = useState(false);
  const hostPlatform = getHostPlatform();
  /** Clone and New Project's Remote need source control on this host (none on production web). */
  const sourceControlAvailable = isSourceControlHost(hostPlatform, isTestModeEnabled());
  const canClone = onCloneProject !== undefined && sourceControlAvailable;
  const [hosting, setHosting] = useState<NewProjectHosting>("local");
  const [rememberedOrigin, setRememberedOrigin] = useState("");
  /** Remote: the repository the fields describe, null while one is missing. */
  const [repository, setRepository] = useState<NewRepositoryRequest | null>(null);
  const changeHosting = (next: NewProjectHosting) => {
    setHosting(next);
    // The Remote fields report again when they mount.
    setRepository(null);
    // A chosen folder on iOS and Android cannot hold a Remote project.
    if (next === "remote" && remoteNeedsAppStorage(hostPlatform)) setPickFolder(false);
  };
  const createName = name.trim() || suggestedName;
  const nameIssue = editTarget
    ? name.trim()
      ? null
      : "Name Required"
    : createProjectNameIssue(
        createName,
        projects.map((project) => project.name),
      );
  const deleting = !!removeTarget && removeDeletesProject(removeTarget.tier);
  const visibleProjects = useMemo(
    () =>
      sortListedProjects(
        filterListedProjects(projects, { search, locationFilters: [] }),
        sort,
      ),
    [projects, search, sort],
  );
  const selectedProjects = projects.filter((project) =>
    selectedIds.has(project.id),
  );
  const allVisibleSelected =
    visibleProjects.length > 0 &&
    visibleProjects.every((project) => selectedIds.has(project.id));
  const endSelection = () => {
    setSelecting(false);
    setSelectedIds(new Set());
  };
  /** Outside selection mode, enters it with this project selected. */
  const toggleSelected = (id: string) => {
    if (!selecting) {
      setSelecting(true);
      setSelectedIds(new Set([id]));
      return;
    }
    setSelectedIds((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  };
  const toggleSelectAll = () =>
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const project of visibleProjects) {
        if (allVisibleSelected) next.delete(project.id);
        else next.add(project.id);
      }
      return next;
    });
  // An emptied library hides the toolbar, and with it Cancel.
  useEffect(() => {
    if (projects.length === 0) {
      setSelecting(false);
      setSelectedIds(new Set());
    }
  }, [projects.length]);
  const allTemplates = homepageTemplates(templates, { debugMode });
  const templateCount = allTemplates.length;
  /** The empty library offers the built-in starters directly. */
  const starterTemplates = ["empty", "2d", "blank"].flatMap((id) =>
    allTemplates.filter((template) => template.id === id),
  );
  const LayoutIcon =
    PROJECT_LAYOUT_OPTIONS.find((option) => option.value === layout)?.icon ??
    Grid2x2Icon;

  const run = async (
    action: () => void | Promise<void>,
    label: string | null = "Opening Project",
  ) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setOperation(label);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      busyRef.current = false;
      setBusy(false);
      setOperation(null);
    }
  };
  const create = (id = "blank", choose = true) => {
    if (busyRef.current) return;
    setEditTarget(null);
    setName("");
    setSuggestedName(randomProjectName(projects.map((project) => project.name)));
    setAppearance(DEFAULT_PROJECT_APPEARANCE);
    setTemplateId(id);
    setChooseTemplate(choose);
    setWidth(DEFAULT_RENDER_WIDTH);
    setHeight(DEFAULT_RENDER_HEIGHT);
    setBlackBars(false);
    setPixelArt(false);
    setPickFolder(false);
    // The last choice on this device, read as the dialog opens (settings hydrate after the Homepage mounts).
    const remembered = getAppSettingsSnapshot().settings.newProjectHosting;
    setHosting(sourceControlAvailable ? remembered.hosting : "local");
    setRememberedOrigin(remembered.origin);
    setRepository(null);
    setError(null);
    setCreateOpen(true);
  };
  const edit = (project: ListedProject) => {
    setEditTarget(project);
    setName(project.label);
    setAppearance(project.appearance ?? DEFAULT_PROJECT_APPEARANCE);
    setError(null);
    setCreateOpen(true);
  };
  const importTemplate = () =>
    void run(async () => {
      const files = await pickImportFiles({
        accept: ".zip",
        multiple: false,
      });
      if (!files[0]) return;
      await importTemplateArchive(files[0].name, files[0].bytes);
      await onSettingsChanged();
    }, null);
  const changeView = (next: string) => {
    setView(next);
    setSearch("");
    endSelection();
  };

  return (
    <div
      className="homepage homepage-theme safe-frame safe-frame-top"
      data-testid="homepage"
    >
      <style data-haptic-home-styles>{homepageStyles}</style>
      <aside className="homepage-sidebar">
        <div className="homepage-brand">
          <img src={brandWordmarkSrc()} alt="" />
          <h1 className="sr-only">Haptic</h1>
        </div>
        <ToggleGroup
          className="homepage-navigation"
          aria-label="Library"
          orientation="vertical"
          spacing={0}
          value={[view]}
          onValueChange={(values) => {
            if (values[0]) changeView(values[0]);
          }}
          disabled={busy}
        >
          <ToggleGroupItem value="projects">
            <FolderOpenIcon data-icon="inline-start" />
            <span className="homepage-navigation-label">Projects</span>
            <span className="homepage-navigation-count">{projects.length}</span>
          </ToggleGroupItem>
          <ToggleGroupItem value="templates">
            <LayoutTemplateIcon data-icon="inline-start" />
            <span className="homepage-navigation-label">Templates</span>
            <span className="homepage-navigation-count">{templateCount}</span>
          </ToggleGroupItem>
        </ToggleGroup>
        <div className="homepage-sidebar-badges">
          <HomepageUpdateBadge />
          <HomepageDiscordBadge accountId={accountId} />
        </div>
        <div className="homepage-sidebar-end">
          <div className="homepage-sidebar-account">
            <HomepageAccount
              disabled={busy}
              onOpenChange={setAccountOpen}
              onAccountChange={setAccountId}
              onEngineSettings={() => setSettingsOpen(true)}
              onChangelog={() => setChangelogOpen(true)}
            />
          </div>
        </div>
      </aside>
      <div className="homepage-content">
        <header className="homepage-header">
          <div className="homepage-heading">
            <h2>{view === "projects" ? "Projects" : "Templates"}</h2>
            {operation ? (
              <p role="status" className="homepage-status-operation">
                <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
                {operation}…
              </p>
            ) : (
              <p className="homepage-status-summary">
                {selecting
                  ? `${selectedProjects.length} Selected`
                  : view === "projects"
                  ? `${projects.length} ${projects.length === 1 ? "Project" : "Projects"}`
                  : `${templateCount} ${templateCount === 1 ? "Template" : "Templates"}`}
                <span aria-hidden="true">·</span>
                {storageLocationLabel(hostPlatform)}
              </p>
            )}
          </div>
          <div className="homepage-header-actions" role="toolbar" aria-label="Launcher">
            {hostPlatform === "web" ? (
              <DropdownMenu modal={false}>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label="Open Folder"
                      data-testid="open-project"
                      disabled={busy}
                    />
                  }
                >
                  <FolderOpenIcon data-icon="inline-start" />
                  <span className="homepage-optional-label">Open</span>
                  <ChevronDownIcon data-icon="inline-end" />
                </DropdownMenuTrigger>
                <DropdownMenuContent className="homepage-theme" align="end">
                  <DropdownMenuItem
                    onClick={() =>
                      void run(() => launch(() => onOpenExternal("folder")))
                    }
                  >
                    Import Folder
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() =>
                      void run(() => launch(() => onOpenExternal("zip")))
                    }
                  >
                    Import ZIP
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Button
                variant="outline"
                size="sm"
                aria-label="Open Folder"
                data-testid="open-project"
                disabled={busy}
                onClick={() => void run(() => launch(onOpenExternal))}
              >
                <FolderOpenIcon data-icon="inline-start" />
                <span className="homepage-optional-label">Open</span>
              </Button>
            )}
            {canClone ? (
              <Button
                variant="outline"
                size="sm"
                aria-label="Clone Project"
                data-testid="clone-project"
                disabled={busy}
                onClick={() => setCloneOpen(true)}
              >
                <FolderGit2Icon data-icon="inline-start" />
                <span className="homepage-optional-label">Clone</span>
              </Button>
            ) : null}
            <Button
              size="sm"
              className="homepage-new"
              data-testid="create-project"
              disabled={busy}
              onClick={() => create()}
            >
              {busy ? (
                <LoaderCircleIcon
                  className="animate-spin"
                  data-icon="inline-start"
                />
              ) : (
                <PlusIcon data-icon="inline-start" />
              )}
              New Project
            </Button>
          </div>
        </header>
        <main className="homepage-main">
          {needsReconnect && (
            <Alert className="homepage-notice">
              <AlertDescription>Reconnect Project</AlertDescription>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void run(() => launch(onReconnect), "Reconnecting Project")
                }
              >
                Reconnect
              </Button>
            </Alert>
          )}
          {recoveryAvailable && (
            <Alert className="homepage-notice">
              <AlertDescription>Recover Previous Session?</AlertDescription>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void run(onRecover, "Recovering Edits")}
              >
                Recover
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={onDismissRecovery}
              >
                Dismiss
              </Button>
            </Alert>
          )}
          {error && !createOpen && (
            <Alert
              variant="destructive"
              className="homepage-error"
              data-testid="homepage-error"
            >
              <AlertDescription>{error}</AlertDescription>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Dismiss Error"
                onClick={() => setError(null)}
              >
                <XIcon />
              </Button>
            </Alert>
          )}
          <div className="homepage-view">
            <div className="homepage-library-view" hidden={view !== "projects"}>
              <div className="homepage-panel">
                {projects.length > 0 && (
                  <div className="homepage-panel-toolbar">
                    <SearchInput
                      className="homepage-search"
                      value={search}
                      onChange={setSearch}
                      placeholder="Search Projects…"
                      aria-label="Search Projects"
                      data-testid="homepage-project-search"
                    />
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            variant="outline"
                            size="sm"
                            aria-label="Sort"
                            data-testid="homepage-project-sort"
                          />
                        }
                      >
                        <ArrowUpDownIcon data-icon="inline-start" />
                        <span className="homepage-optional-label">Sort</span>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent className="homepage-theme" align="end">
                        <DropdownMenuGroup>
                          <DropdownMenuRadioGroup
                            value={sort}
                            onValueChange={(value) =>
                              setSort(value as HomepageProjectSortMode)
                            }
                          >
                            {HOMEPAGE_PROJECT_SORT_OPTIONS.map((option) => (
                              <DropdownMenuRadioItem
                                closeOnClick
                                key={option.mode}
                                value={option.mode}
                              >
                                {option.label}
                              </DropdownMenuRadioItem>
                            ))}
                          </DropdownMenuRadioGroup>
                        </DropdownMenuGroup>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            variant="outline"
                            size="sm"
                            aria-label="Project View"
                          />
                        }
                      >
                        <LayoutIcon data-icon="inline-start" />
                        <span className="homepage-optional-label">View</span>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent className="homepage-theme" align="end">
                        <DropdownMenuGroup>
                          <DropdownMenuRadioGroup
                            value={layout}
                            onValueChange={(value) =>
                              changeLayout(value as typeof layout)
                            }
                          >
                            {PROJECT_LAYOUT_OPTIONS.map((option) => (
                              <DropdownMenuRadioItem
                                closeOnClick
                                key={option.value}
                                value={option.value}
                              >
                                {option.label}
                              </DropdownMenuRadioItem>
                            ))}
                          </DropdownMenuRadioGroup>
                        </DropdownMenuGroup>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    {selecting && (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          aria-label={
                            allVisibleSelected ? "Deselect All" : "Select All"
                          }
                          data-testid="homepage-project-select-all"
                          disabled={busy || visibleProjects.length === 0}
                          onClick={toggleSelectAll}
                        >
                          <CheckCheckIcon data-icon="inline-start" />
                          <span className="homepage-optional-label">
                            {allVisibleSelected ? "Deselect All" : "Select All"}
                          </span>
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          aria-label="Delete Selected Projects"
                          data-testid="homepage-project-delete-selected"
                          disabled={busy || selectedProjects.length === 0}
                          onClick={() => {
                            setDeleteTargets(selectedProjects);
                            setDeleteOpen(true);
                          }}
                        >
                          <Trash2Icon data-icon="inline-start" />
                          <span className="homepage-optional-label">Delete</span>
                        </Button>
                      </>
                    )}
                    {/* Last in the row, so Cancel takes Select's place. */}
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={selecting ? "Cancel Selection" : "Select Projects"}
                      data-testid="homepage-project-select-mode"
                      disabled={busy}
                      onClick={() =>
                        selecting ? endSelection() : setSelecting(true)
                      }
                    >
                      {selecting ? (
                        <XIcon data-icon="inline-start" />
                      ) : (
                        <CircleCheckIcon data-icon="inline-start" />
                      )}
                      <span className="homepage-optional-label">
                        {selecting ? "Cancel" : "Select"}
                      </span>
                    </Button>
                  </div>
                )}
                <HomepageGallery
                  label="Projects"
                  layout={layout}
                  items={visibleProjects.map((project) => ({
                    id: project.id,
                    content: (
                      <HomepageProjectCard
                        project={project}
                        layout={layout}
                        busy={busy}
                        deleting={removeDeletesProject(project.tier)}
                        selecting={selecting}
                        selected={selectedIds.has(project.id)}
                        onToggleSelected={() => toggleSelected(project.id)}
                        onOpen={() =>
                          void run(() =>
                            launch(() => onOpenProject(project), project.label),
                          )
                        }
                        onEdit={() => edit(project)}
                        onRemove={() => {
                          setRemoveTarget(project);
                          setRemoveOpen(true);
                        }}
                      />
                    ),
                  }))}
                  empty={
                    search ? (
                      <Empty
                        className="homepage-empty"
                        data-testid="homepage-projects-empty"
                        data-search="true"
                      >
                        <EmptyHeader>
                          <EmptyTitle>No Results</EmptyTitle>
                        </EmptyHeader>
                      </Empty>
                    ) : (
                      <HomepageWelcome
                        starters={starterTemplates}
                        disabled={busy}
                        onStart={(id) => create(id, false)}
                        onBrowse={() => changeView("templates")}
                      />
                    )
                  }
                />
              </div>
            </div>
            <div className="homepage-library-view" hidden={view !== "templates"}>
              <div className="homepage-panel">
                <HomepageTemplateBrowser
                  templates={templates}
                  disabled={busy}
                  onImport={importTemplate}
                  onSelect={(id) => create(id, false)}
                />
              </div>
            </div>
          </div>
        </main>
        <span className="homepage-status-version">{getBuildLabel()}</span>
      </div>
      <HomepageCreateDialog
        open={createOpen}
        onOpenChange={(open) => {
          if (!busy) setCreateOpen(open);
        }}
        chooseTemplate={chooseTemplate}
        mode={editTarget ? "edit" : "create"}
        busy={busy}
        name={name}
        onNameChange={setName}
        suggestedName={editTarget ? undefined : suggestedName}
        nameIssue={nameIssue}
        appearance={appearance}
        onAppearanceChange={setAppearance}
        error={error}
        templateId={templateId}
        onTemplateIdChange={setTemplateId}
        templates={templates}
        onImportTemplate={importTemplate}
        hostPlatform={hostPlatform}
        pickFolder={pickFolder}
        onPickFolderChange={setPickFolder}
        width={width}
        onWidthChange={setWidth}
        height={height}
        onHeightChange={setHeight}
        blackBars={blackBars}
        onBlackBarsChange={setBlackBars}
        hosting={editTarget || !sourceControlAvailable ? null : hosting}
        onHostingChange={changeHosting}
        rememberedOrigin={rememberedOrigin}
        remoteReady={repository !== null}
        onRepositoryChange={setRepository}
        pixelArt={pixelArt}
        onPixelArtChange={(enabled) => {
          setPixelArt(enabled);
          // A pixel-art design size: the larger of the two offered; the fields stay editable.
          const size = enabled ? PIXEL_ART_DESIGN_SIZES[0] : { width: DEFAULT_RENDER_WIDTH, height: DEFAULT_RENDER_HEIGHT };
          setWidth(size.width);
          setHeight(size.height);
        }}
        onSubmit={() => {
          if (busy || nameIssue) return;
          void run(
            async () => {
              if (editTarget)
                await onUpdateProject(editTarget, {
                  name: name.trim(),
                  appearance,
                });
              else {
                const remote = sourceControlAvailable && hosting === "remote";
                // Only a Remote choice publishes, never a request left from before.
                const newRepository = remote ? repository : null;
                if (remote && !newRepository) return;
                if (sourceControlAvailable) {
                  // Remembered on this device for the next New Project; a failed save only loses the default.
                  void updateAppSettings((settings) => {
                    settings.newProjectHosting = { hosting, origin: newRepository?.origin ?? settings.newProjectHosting.origin };
                  }).catch(() => undefined);
                }
                await launch(async () => {
                  const options: CreateProjectOptions = {
                    appearance,
                    renderWidth: width,
                    renderHeight: height,
                    blackBars,
                    pixelArt,
                    onPhase: transition.setPhase,
                    reviewExecuteJavaScript: (plugins) => executeJavaScript.review(plugins.flatMap((plugin) =>
                      plugin.assets.map((asset) => ({ ...asset, plugin: plugin.displayName })))),
                    ...(newRepository ? { repository: newRepository } : {}),
                    ...(hostPlatform === "web"
                      ? {}
                      : { pickFolder: pickFolder && !(remote && remoteNeedsAppStorage(hostPlatform)) }),
                  };
                  const folderName = normalizeProjectFolderName(createName);
                  if (!folderName) return;
                  if (isBuiltInStarterKind(templateId))
                    await onCreateEmpty(folderName, {
                      ...options,
                      kind: templateId,
                    });
                  else
                    await onCreateFromTemplate(
                      templateId.slice("template:".length),
                      folderName,
                      options,
                    );
                  recordTemplateUse(templateId);
                }, createName, "creating");
              }
              setCreateOpen(false);
            },
            editTarget ? "Updating Project" : "Creating Project",
          );
        }}
      />
      <ExecuteJavaScriptImportDialog
        purpose="newProject"
        className="homepage-theme z-[1001]"
        assets={executeJavaScript.assets}
        onConfirm={() => executeJavaScript.answer(true)}
        onCancel={() => executeJavaScript.answer(false)}
      />
      <AlertDialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <AlertDialogContent
          className="homepage-theme"
          variant={deleting ? "destructive" : "warning"}
          data-testid="homepage-remove-dialog"
        >
          <AlertDialogHeader>
            <AlertDialogTitle className="break-words">
              {removeTarget
                ? `${deleting ? "Delete" : "Remove"} ${removeTarget.label}?`
                : null}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleting
                ? "This permanently deletes the project."
                : "This only takes the project off this list. Nothing is deleted."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {!deleting && (
            <ul
              className="flex flex-col divide-y rounded-md border text-xs text-muted-foreground"
              aria-label="Remove or Delete"
              data-testid="homepage-remove-compare"
            >
              <li className="flex flex-col gap-0.5 px-2.5 py-1.5">
                <span className="font-medium text-foreground">
                  Remove From List
                </span>
                The folder and its files stay where they are. To list the
                project again, choose Open and pick its folder.
              </li>
              <li className="flex flex-col gap-0.5 px-2.5 py-1.5">
                <span className="font-medium text-foreground">Delete</span>
                Erases a project's files for good. Haptic only deletes projects
                in its own storage, never a folder you chose.
              </li>
            </ul>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="homepage-remove-cancel">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant={deleting ? "destructive" : undefined}
              data-testid="homepage-remove-confirm"
              onClick={() => {
                if (removeTarget)
                  void run(
                    () => onRemoveFromList(removeTarget),
                    deleting
                      ? "Deleting Project"
                      : "Removing Project From List",
                  );
                setRemoveOpen(false);
              }}
            >
              {deleting ? "Delete" : "Remove From List"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <HomepageDeleteProjectsDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        projects={deleteTargets}
        onConfirm={(targets) =>
          void run(async () => {
            // One at a time: a failure stops here, and the projects not yet deleted stay selected.
            for (const project of targets) await onRemoveFromList(project);
            endSelection();
          }, targets.length === 1 ? "Deleting Project" : "Deleting Projects")
        }
      />
      {cloneOpen && onCloneProject ? (
        <Suspense fallback={null}>
          <CloneProjectDialog
            open
            onOpenChange={setCloneOpen}
            existingNames={projects.map((project) => project.name)}
            onClone={async (request, transfer, signal) => {
              const handle = await onCloneProject(request, transfer, signal);
              setCloneOpen(false);
              await run(() => launch(() => onOpenProject(handle), request.name));
            }}
          />
        </Suspense>
      ) : null}
      <ReleaseNews open={changelogOpen} onOpenChange={setChangelogOpen} ready={dataReady && !transition.active && !accountOpen && !settingsOpen && !createOpen && !busy} />
      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsModal
            open
            onOpenChange={setSettingsOpen}
            scope="engine"
            onEngineSaved={onSettingsChanged}
            data-testid="engine-settings-modal"
          />
        </Suspense>
      )}
    </div>
  );
}
