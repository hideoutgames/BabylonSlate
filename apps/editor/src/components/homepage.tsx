import { lazy, Suspense, useMemo, useRef, useState } from "react";
import {
  ArrowUpDownIcon,
  BoxIcon,
  FolderOpenIcon,
  Grid2x2Icon,
  LayoutTemplateIcon,
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
import { getHostPlatform, isTestModeEnabled } from "@babylonslate/vfs";
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
import { TemplatePickCard } from "./homepage-template-card";
import homepageStyles from "./homepage.css?inline";

const SettingsModal = lazy(() =>
  import("./settings-modal").then((module) => ({
    default: module.SettingsModal,
  })),
);

interface HomepageProps {
  projects: ListedProject[];
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
  onOpenExternal: () => Promise<void>;
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
  const [view, setView] = useState("projects");
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<HomepageProjectSortMode>("last-opened-desc");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
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
  const [templateId, setTemplateId] = useState("empty");
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

  const run = async (action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const create = (id = "empty", choose = true) => {
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
  const choices = [
    { id: "empty", name: "Blank", icon: BoxIcon, imageUrl: undefined },
    { id: "2d", name: "2D", icon: Grid2x2Icon, imageUrl: undefined },
    ...templates.map((template) => ({ ...template, icon: LayoutTemplateIcon })),
  ];

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
            onClick={() => setScheme(scheme === "dark" ? "light" : "dark")}
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
          <HomepageAccount disabled={busy} />
        </div>
      </header>
      <main className="homepage-main">
        <div className="homepage-library-toolbar">
          <div className="homepage-library-label">
            <span>{view === "projects" ? "Projects" : "Templates"}</span>
            <span>
              {String(
                view === "projects" ? projects.length : choices.length,
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
            </div>
          )}
        </div>
        {needsReconnect && (
          <Alert className="homepage-notice">
            <AlertDescription>Reconnect Project</AlertDescription>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void run(onReconnect)}
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
              onClick={() =>
                void run(async () => {
                  await onRecover();
                })
              }
            >
              Recover
            </Button>
            <Button variant="ghost" disabled={busy} onClick={onDismissRecovery}>
              Dismiss
            </Button>
          </Alert>
        )}
        <div className="homepage-view" key={view}>
          {view === "projects" ? (
            <HomepageGallery
              label="Projects"
              items={visibleProjects.map((project) => ({
                id: project.id,
                content: (
                  <HomepageProjectCard
                    project={project}
                    busy={busy}
                    deleting={shouldDeleteOpfsOnRemove(
                      hostPlatform,
                      project.tier,
                    )}
                    onOpen={() => void run(() => onOpenProject(project))}
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
                  {!search && <HomepageEmptyArt scheme={scheme} />}
                  <EmptyHeader>
                    <EmptyTitle>
                      {search ? "No Results" : "No Projects Yet"}
                    </EmptyTitle>
                  </EmptyHeader>
                </Empty>
              }
            />
          ) : (
            <HomepageGallery
              label="Templates"
              items={choices.map((choice) => ({
                id: choice.id,
                content: (
                  <TemplatePickCard
                    title={choice.name}
                    icon={choice.icon}
                    imageUrl={choice.imageUrl}
                    testId={`homepage-start-${choice.id}`}
                    disabled={busy}
                    onSelect={() => create(choice.id, false)}
                  />
                ),
              }))}
            />
          )}
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
        <Button
          variant="ghost"
          size="touch-icon"
          aria-label="Open Folder"
          data-testid="open-project"
          disabled={busy}
          onClick={() => void run(onOpenExternal)}
        >
          <FolderOpenIcon />
        </Button>
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
          void run(async () => {
            if (editTarget)
              await onUpdateProject(editTarget, {
                name: name.trim(),
                appearance,
              });
            else {
              const options: CreateProjectOptions = {
                appearance,
                renderWidth: width,
                renderHeight: height,
                blackBars,
                ...(hostPlatform === "web" ? {} : { pickFolder }),
              };
              const folderName = normalizeProjectFolderName(name);
              if (!folderName) return;
              if (templateId === "empty" || templateId === "2d")
                await onCreateEmpty(folderName, {
                  ...options,
                  kind: templateId,
                });
              else await onCreateFromTemplate(templateId, folderName, options);
            }
            setCreateOpen(false);
          });
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
                  void run(() => onRemoveFromList(removeTarget));
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
