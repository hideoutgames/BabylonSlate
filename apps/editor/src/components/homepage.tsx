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
  FolderOpenIcon,
  Grid2x2Icon,
  Grid3x3Icon,
  ListIcon,
  LoaderCircleIcon,
  MoonIcon,
  PlusIcon,
  SearchIcon,
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
import { HomepageAccount } from "./homepage-account";
import { HomepageCreateDialog } from "./homepage-create-dialog";
import { HomepageEmptyArt } from "./homepage-empty-art";
import { HomepageGallery } from "./homepage-gallery";
import { HomepageProjectCard } from "./homepage-project-card";
import { DEFAULT_PROJECT_APPEARANCE } from "./homepage-project-appearance";
import { useHomepageScheme } from "./homepage-scheme";
import {
  HomepageTemplateBrowser,
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

  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<HomepageProjectSortMode>("last-opened-desc");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
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
    setName(defaultCreateProjectDisplayName(isTestModeEnabled()));
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

  return (
    <div
      className="homepage homepage-theme safe-frame safe-frame-top"
      data-testid="homepage"
      data-slate-theme={scheme}
    >
      <style data-slate-home-styles>{homepageStyles}</style>
      <header className="homepage-header">
        <div className="homepage-brand">
          <img src={brandIconSrc(scheme)} alt="" />
          <h1>Slate</h1>
        </div>
        <ToggleGroup
          className="homepage-navigation"
          aria-label="Library"
          value={[view]}
          onValueChange={(values) => {
            if (values[0]) {
              setView(values[0]);
              setSearch("");
              setSearchOpen(false);
            }
          }}
          disabled={busy}
        >
          <ToggleGroupItem value="projects">Projects</ToggleGroupItem>
          <ToggleGroupItem value="templates">Templates</ToggleGroupItem>
        </ToggleGroup>
        <div className="homepage-utilities">
          <Button
            variant="ghost"
            size="touch-icon"
            aria-label={scheme === "dark" ? "Light Mode" : "Dark Mode"}
            disabled={busy}
            onClick={() =>
              void run(
                () => setScheme(scheme === "dark" ? "light" : "dark"),
                "Updating Theme",
              )
            }
          >
            {scheme === "dark" ? <SunIcon /> : <MoonIcon />}
          </Button>
          <Button
            variant="ghost"
            size="touch-icon"
            aria-label="Engine Settings"
            data-testid="engine-settings"
            disabled={busy}
            onClick={() => setSettingsOpen(true)}
          >
            <Settings2Icon />
          </Button>
          <HomepageAccount disabled={busy} onOpenChange={setAccountOpen} />
        </div>
      </header>
      <main className="homepage-main">
        {operation && (
          <p role="status" className="shrink-0 text-sm text-muted-foreground">
            {operation}…
          </p>
        )}
        <div className="homepage-library-toolbar">
          <div className="homepage-library-label">
            <span>{view === "projects" ? "Projects" : "Templates"}</span>
            <span>
              {String(
                view === "projects" ? projects.length : templates.length + 3,
              ).padStart(2, "0")}
            </span>
          </div>
          {view === "projects" && projects.length > 0 && (
            <div className="homepage-search-tools">
              {searchOpen && (
                <SearchInput
                  className="homepage-search"
                  value={search}
                  onChange={setSearch}
                  placeholder="Search"
                  data-testid="homepage-project-search"
                />
              )}
              <Button
                variant="ghost"
                size="touch-icon"
                aria-label={searchOpen ? "Close Search" : "Search Projects"}
                onClick={() => {
                  setSearchOpen(!searchOpen);
                  setSearch("");
                }}
              >
                {searchOpen ? <XIcon /> : <SearchIcon />}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="touch-icon"
                      aria-label="Sort"
                      data-testid="homepage-project-sort"
                    />
                  }
                >
                  <ArrowUpDownIcon />
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
                      variant="ghost"
                      size="touch-icon"
                      aria-label="Project View"
                    />
                  }
                >
                  {layout === "list" ? (
                    <ListIcon />
                  ) : layout === "small" ? (
                    <Grid3x3Icon />
                  ) : (
                    <Grid2x2Icon />
                  )}
                </DropdownMenuTrigger>
                <DropdownMenuContent className="homepage-theme" align="end">
                  <DropdownMenuGroup>
                    <DropdownMenuRadioGroup
                      value={layout}
                      onValueChange={(value) =>
                        changeLayout(value as typeof layout)
                      }
                    >
                      <DropdownMenuRadioItem closeOnClick value="large">
                        Large Cards
                      </DropdownMenuRadioItem>
                      <DropdownMenuRadioItem closeOnClick value="small">
                        Small Cards
                      </DropdownMenuRadioItem>
                      <DropdownMenuRadioItem closeOnClick value="list">
                        List
                      </DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                  </DropdownMenuGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>
        {needsReconnect && (
          <Alert className="homepage-notice">
            <AlertDescription>Reconnect Project</AlertDescription>
            <Button
              variant="outline"
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
              disabled={busy}
              onClick={() => void run(onRecover, "Recovering Edits")}
            >
              Recover
            </Button>
            <Button variant="ghost" disabled={busy} onClick={onDismissRecovery}>
              Dismiss
            </Button>
          </Alert>
        )}
        <div className="homepage-view">
          <div className="homepage-library-view" hidden={view !== "projects"}>
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
                >
                  {!search && (
                    <HomepageEmptyArt
                      onReady={markArtReady}
                      paused={
                        busy ||
                        transition.active ||
                        createOpen ||
                        settingsOpen ||
                        accountOpen ||
                        view !== "projects"
                      }
                    />
                  )}
                  <EmptyHeader>
                    <EmptyTitle>
                      {search ? "No Results" : "No Projects Yet"}
                    </EmptyTitle>
                  </EmptyHeader>
                </Empty>
              }
            />
          </div>
          <div className="homepage-library-view" hidden={view !== "templates"}>
            <HomepageTemplateBrowser
              templates={templates}
              disabled={busy}
              onImport={importTemplate}
              onSelect={(id) => create(id, false)}
            />
          </div>
        </div>
        {error && !createOpen && (
          <Alert
            variant="destructive"
            className="homepage-error"
            data-testid="homepage-error"
          >
            <AlertDescription>{error}</AlertDescription>
            <Button
              variant="ghost"
              size="touch-icon"
              aria-label="Dismiss Error"
              onClick={() => setError(null)}
            >
              <XIcon />
            </Button>
          </Alert>
        )}
      </main>
      <footer className="homepage-dock">
        <Button
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
                  variant="ghost"
                  size="touch-icon"
                  aria-label="Open Folder"
                  data-testid="open-project"
                  disabled={busy}
                />
              }
            >
              <FolderOpenIcon />
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
            variant="ghost"
            size="touch-icon"
            aria-label="Open Folder"
            data-testid="open-project"
            disabled={busy}
            onClick={() => void run(() => launch(onOpenExternal))}
          >
            <FolderOpenIcon />
          </Button>
        )}
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
