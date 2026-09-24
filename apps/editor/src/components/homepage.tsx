import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ArrowUpDownIcon,
  ChevronDownIcon,
  FolderOpenIcon,
  Grid2x2Icon,
  Grid3x3Icon,
  LayoutTemplateIcon,
  ListIcon,
  LoaderCircleIcon,
  MoonIcon,
  PlusIcon,
  Settings2Icon,
  SunIcon,
  XIcon,
} from "lucide-react";
import {
  DEFAULT_RENDER_HEIGHT,
  DEFAULT_RENDER_WIDTH,
  type ProjectAppearance,
  type ProjectFolderHandle,
} from "@babylonslate/core";
import { SearchInput } from "@babylonslate/editor-kit";
import {
  getHostPlatform,
  isTestModeEnabled,
  pickImportFiles,
} from "@babylonslate/vfs";
import { Alert, AlertDescription } from "@babylonslate/ui/components/alert";
import type { UncleanExit } from "../lib/session-liveness";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@babylonslate/ui/components/alert-dialog";
import { Button } from "@babylonslate/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuGroup,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@babylonslate/ui/components/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@babylonslate/ui/components/empty";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@babylonslate/ui/components/toggle-group";
import {
  filterListedProjects,
  HOMEPAGE_PROJECT_SORT_OPTIONS,
  shouldDeleteOpfsOnRemove,
  sortListedProjects,
  type HomepageProjectSortMode,
  type ListedProject,
  type UpdateListedProjectOptions,
} from "../lib/listed-projects";
import {
  createProjectNameIssue,
  defaultCreateProjectDisplayName,
  normalizeProjectFolderName,
  type CreateProjectOptions,
} from "../lib/create-project";
import { brandIconSrc } from "../lib/branding";
import { getBuildLabel } from "../lib/build-identity";
import { IconActionButton } from "./icon-action-button";
import { HomepageAccount } from "./homepage-account";
import { HomepageApplicationSettings } from "./homepage-application-settings";
import { HomepageCreateDialog } from "./homepage-create-dialog";
import { HomepageEmptyArt } from "./homepage-empty-art";
import { HomepageGallery } from "./homepage-gallery";
import { HomepageProjectCard } from "./homepage-project-card";
import { DEFAULT_PROJECT_APPEARANCE } from "./homepage-project-appearance";
import { useHomepageScheme } from "./homepage-scheme";
import {
  HomepageTemplateBrowser,
  homepageTemplates,
  recordTemplateUse,
} from "./homepage-template-browser";
import { importTemplateArchive } from "../services/template-service";
import { useLauncherTransition } from "./launcher-transition";
import homepageStyles from "./homepage.css?inline";

const SettingsModal = lazy(() =>
  import("./settings-modal").then((module) => ({
    default: module.SettingsModal,
  })),
);

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
  onUpdateProject: (
    handle: ProjectFolderHandle,
    details: UpdateListedProjectOptions,
  ) => Promise<void>;
  onRemoveFromList: (handle: ProjectFolderHandle) => Promise<void>;
  onReconnect: () => Promise<void>;
  onRecover: () => void | Promise<void>;
  onDismissRecovery: () => void;
  uncleanExit?: UncleanExit | null;
  onDismissUncleanExit?: () => void;
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
  onUpdateProject,
  onRemoveFromList,
  onReconnect,
  onRecover,
  onDismissRecovery,
  uncleanExit,
  onDismissUncleanExit,
  onSettingsChanged,
}: HomepageProps) {
  const [scheme, setScheme] = useHomepageScheme();
  const transition = useLauncherTransition();
  const [artReady, setArtReady] = useState(false);
  const markArtReady = useCallback(() => setArtReady(true), []);
  useEffect(() => {
    transition.reportHomeLoading(
      !dataReady
        ? "Loading project library"
        : projects.length === 0 && !artReady
          ? "Loading 3D models"
          : "Preparing interface",
    );
  }, [dataReady, projects.length, artReady, transition.reportHomeLoading]);
  useEffect(() => {
    if (!dataReady || (projects.length === 0 && !artReady)) return;
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
  }, [dataReady, projects.length, artReady, transition.ready]);
  const launch = async (action: () => Promise<void>, label = "Slate") => {
    transition.begin(label);
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
      const saved = localStorage.getItem("slate:project-layout");
      return saved === "small" || saved === "list" ? saved : "large";
    } catch {
      return "large";
    }
  });
  const changeLayout = (value: "large" | "small" | "list") => {
    setLayout(value);
    try {
      localStorage.setItem("slate:project-layout", value);
    } catch {
      /* Optional preference. */
    }
  };

  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<HomepageProjectSortMode>("last-opened-desc");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [applicationSettingsOpen, setApplicationSettingsOpen] =
    useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [chooseTemplate, setChooseTemplate] = useState(true);
  const [editTarget, setEditTarget] = useState<ListedProject | null>(null);
  const [removeTarget, setRemoveTarget] = useState<ListedProject | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [name, setName] = useState("");
  const [appearance, setAppearance] = useState<ProjectAppearance>(
    DEFAULT_PROJECT_APPEARANCE,
  );
  const [templateId, setTemplateId] = useState("blank");
  const [width, setWidth] = useState(DEFAULT_RENDER_WIDTH);
  const [height, setHeight] = useState(DEFAULT_RENDER_HEIGHT);
  const [blackBars, setBlackBars] = useState(false);
  const [pickFolder, setPickFolder] = useState(false);
  const hostPlatform = getHostPlatform();
  const nameIssue = editTarget
    ? name.trim()
      ? null
      : "Name Required"
    : createProjectNameIssue(
        name,
        projects.map((project) => project.name),
      );
  const deleting =
    !!removeTarget && shouldDeleteOpfsOnRemove(hostPlatform, removeTarget.tier);
  const visibleProjects = useMemo(
    () =>
      sortListedProjects(
        filterListedProjects(projects, { search, locationFilters: [] }),
        sort,
      ),
    [projects, search, sort],
  );
  const templateCount = homepageTemplates(templates).length;
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
    setName(
      defaultCreateProjectDisplayName(
        isTestModeEnabled(),
        projects.map((project) => project.name),
      ),
    );
    setAppearance(DEFAULT_PROJECT_APPEARANCE);
    setTemplateId(id);
    setChooseTemplate(choose);
    setWidth(DEFAULT_RENDER_WIDTH);
    setHeight(DEFAULT_RENDER_HEIGHT);
    setBlackBars(false);
    setPickFolder(false);
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
        accept: ".zip,.babproject",
        multiple: false,
      });
      if (!files[0]) return;
      await importTemplateArchive(files[0].name, files[0].bytes);
      await onSettingsChanged();
    }, null);
  const changeView = (next: string) => {
    setView(next);
    setSearch("");
  };

  return (
    <div
      className="homepage homepage-theme safe-frame safe-frame-top"
      data-testid="homepage"
      data-slate-theme={scheme}
    >
      <style data-slate-home-styles>{homepageStyles}</style>
      <header className="homepage-titlebar">
        <div className="homepage-brand">
          <img src={brandIconSrc(scheme)} alt="" />
          <h1>Slate</h1>
        </div>
        <ToggleGroup
          className="homepage-navigation"
          aria-label="Library"
          spacing={0}
          value={[view]}
          onValueChange={(values) => {
            if (values[0]) changeView(values[0]);
          }}
          disabled={busy}
        >
          <ToggleGroupItem value="projects">
            <FolderOpenIcon data-icon="inline-start" />
            Projects
          </ToggleGroupItem>
          <ToggleGroupItem value="templates">
            <LayoutTemplateIcon data-icon="inline-start" />
            Templates
          </ToggleGroupItem>
        </ToggleGroup>
        <div className="homepage-titlebar-end">
          <HomepageAccount
            disabled={busy}
            onOpenChange={setAccountOpen}
            onApplicationSettings={() => setApplicationSettingsOpen(true)}
            onEngineSettings={() => setSettingsOpen(true)}
          />
        </div>
      </header>
      <div className="homepage-toolbar" role="toolbar" aria-label="Launcher">
        <div className="homepage-toolbar-start">
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
              <DropdownMenuContent className="homepage-theme" align="start">
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
        </div>
        <div className="homepage-toolbar-end">
          <IconActionButton
            label={scheme === "dark" ? "Light Mode" : "Dark Mode"}
            variant="ghost"
            disabled={busy}
            onClick={() =>
              void run(
                () => setScheme(scheme === "dark" ? "light" : "dark"),
                "Updating Theme",
              )
            }
          >
            {scheme === "dark" ? <SunIcon /> : <MoonIcon />}
          </IconActionButton>
          <Button
            variant="outline"
            size="sm"
            aria-label="Engine Settings"
            data-testid="engine-settings"
            disabled={busy}
            onClick={() => setSettingsOpen(true)}
          >
            <Settings2Icon data-icon="inline-start" />
            <span className="homepage-optional-label">Engine Settings</span>
          </Button>
        </div>
      </div>
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
        {uncleanExit && (
          <Alert className="homepage-notice" data-testid="unclean-exit-notice">
            <AlertDescription>
              {`BabylonSlate restarted unexpectedly${
                uncleanExit.project
                  ? ` while ${uncleanExit.project.name} was open`
                  : ""
              }.`}
              {uncleanExit.project
                ? " Reopen it to recover journaled edits; edits that were never journaled are lost."
                : ""}
              {uncleanExit.recentCount >= 3
                ? ` This has happened ${uncleanExit.recentCount} times in the last 10 minutes.`
                : ""}
            </AlertDescription>
            <Button variant="ghost" size="sm" onClick={onDismissUncleanExit}>
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
                      deleting={shouldDeleteOpfsOnRemove(
                        hostPlatform,
                        project.tier,
                      )}
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
                  <Empty
                    className="homepage-empty"
                    data-testid="homepage-projects-empty"
                    data-search={search ? "true" : "false"}
                  >
                    {!search && (
                      <HomepageEmptyArt
                        onReady={markArtReady}
                        paused={
                          busy ||
                          transition.active ||
                          createOpen ||
                          settingsOpen ||
                          applicationSettingsOpen ||
                          accountOpen ||
                          view !== "projects"
                        }
                      />
                    )}
                    <EmptyHeader>
                      <EmptyTitle>
                        {search ? "No Results" : "No Projects Yet"}
                      </EmptyTitle>
                      {!search && (
                        <EmptyDescription>
                          Start from a template or open an existing project
                          folder.
                        </EmptyDescription>
                      )}
                    </EmptyHeader>
                    {!search && (
                      <EmptyContent className="homepage-empty-actions">
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() => create()}
                        >
                          <PlusIcon data-icon="inline-start" />
                          Create Project
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => changeView("templates")}
                        >
                          <LayoutTemplateIcon data-icon="inline-start" />
                          Browse Templates
                        </Button>
                      </EmptyContent>
                    )}
                  </Empty>
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
      <footer className="homepage-statusbar">
        {operation ? (
          <p role="status" className="homepage-status-operation">
            <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
            {operation}…
          </p>
        ) : (
          <p className="homepage-status-summary">
            {view === "projects"
              ? `${projects.length} ${projects.length === 1 ? "Project" : "Projects"}`
              : `${templateCount} ${templateCount === 1 ? "Template" : "Templates"}`}
            <span aria-hidden="true">·</span>
            {storageLocationLabel(hostPlatform)}
          </p>
        )}
        <span className="homepage-status-version">{getBuildLabel()}</span>
      </footer>
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
                await launch(async () => {
                  const options: CreateProjectOptions = {
                    appearance,
                    renderWidth: width,
                    renderHeight: height,
                    blackBars,
                    ...(hostPlatform === "web" ? {} : { pickFolder }),
                  };
                  const folderName = normalizeProjectFolderName(name);
                  if (!folderName) return;
                  if (
                    templateId === "blank" ||
                    templateId === "empty" ||
                    templateId === "2d"
                  )
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
                }, name.trim());
              }
              setCreateOpen(false);
            },
            editTarget ? "Updating Project" : "Creating Project",
          );
        }}
      />
      <AlertDialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <AlertDialogContent
          className="homepage-theme"
          variant={deleting ? "destructive" : "default"}
          data-testid="homepage-remove-dialog"
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleting ? "Delete Project?" : "Remove Project?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleting
                ? "This permanently deletes the project."
                : "Project files stay on this device."}
            </AlertDialogDescription>
          </AlertDialogHeader>
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
              {deleting ? "Delete" : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <HomepageApplicationSettings
        open={applicationSettingsOpen}
        onOpenChange={setApplicationSettingsOpen}
      />
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
