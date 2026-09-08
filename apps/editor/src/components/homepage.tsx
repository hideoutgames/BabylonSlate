import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  ArrowUpDownIcon,
  ArrowUpRightIcon,
  ArrowRightIcon,
  BookOpenIcon,
  BoxIcon,
  FolderOpenIcon,
  Grid2x2Icon,
  LayoutTemplateIcon,
  ListFilterIcon,
  MoreHorizontalIcon,
  OctagonAlertIcon,
  PlusIcon,
  Settings2Icon,
  Trash2Icon,
} from "lucide-react";
import {
  DEFAULT_RENDER_HEIGHT,
  DEFAULT_RENDER_WIDTH,
  type ProjectFolderHandle,
  type ProjectAppearance,
} from "@babylonslate/core";
import {
  ContextMenuOverlay,
  SearchInput,
  useContextMenu,
} from "@babylonslate/editor-kit";
import {
  getHostPlatform,
  isTestModeEnabled,
  type HostPlatform,
} from "@babylonslate/vfs";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@babylonslate/ui/components/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "@babylonslate/ui/components/alert-dialog";
import { Button } from "@babylonslate/ui/components/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  CardFooter,
} from "@babylonslate/ui/components/card";
import { Badge } from "@babylonslate/ui/components/badge";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@babylonslate/ui/components/dropdown-menu";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@babylonslate/ui/components/empty";
import { displayProjectName } from "../lib/display-project-name";
import {
  filterListedProjects,
  HOMEPAGE_PROJECT_SORT_OPTIONS,
  listedProjectLocationLabel,
  listedProjectMetaParts,
  shouldDeleteOpfsOnRemove,
  sortListedProjects,
  type HomepageProjectLocationFilter,
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
import { BrandIcon } from "./brand-icon";
import { brandIconSrc } from "../lib/branding";
import { HomepageAccount } from "./homepage-account";
import { ProjectIdentityBadge } from "./homepage-project-identity";
import { DEFAULT_PROJECT_APPEARANCE } from "./homepage-project-appearance";
import { HomepageCreateDialog } from "./homepage-create-dialog";
import { TemplatePickCard } from "./homepage-template-card";
import { IconActionButton } from "./icon-action-button";
import homepageStyles from "./homepage.css?inline";

const SettingsModal = lazy(() =>
  import("./settings-modal").then((module) => ({
    default: module.SettingsModal,
  })),
);

function createProjectCardDescription(
  templateCount: number,
  hostPlatform: HostPlatform,
): string {
  if (templateCount > 0) {
    return "Creating from a template copies the project and rewrites only its name and identity.";
  }
  if (hostPlatform === "web") {
    return "Start with Empty or 2D.";
  }
  return "Start with Empty or 2D. Optional templates appear when a templates folder is set in Engine Settings.";
}

const HOMEPAGE_LOCATION_FILTERS: ReadonlyArray<{
  id: HomepageProjectLocationFilter;
  label: string;
}> = [
  { id: "on-this-device", label: "On this device" },
  { id: "chosen-folder", label: "Chosen folder" },
];

function HomepageProjectRow({
  project,
  projects,
  busy,
  deleteOnRemove,
  onOpen,
  onRename,
  onRequestRemove,
}: {
  project: ListedProject;
  projects: ListedProject[];
  busy: boolean;
  deleteOnRemove: boolean;
  onOpen: (project: ListedProject) => void;
  onRename: (project: ListedProject) => void;
  onRequestRemove: (project: ListedProject) => void;
}) {
  const skipOpenRef = useRef(false);
  const removeLabel = deleteOnRemove ? "Delete" : "Remove from list";
  const { menu, closeMenu, bind, openMenuAt } = useContextMenu({
    enabled: !busy,
    items: [
      {
        id: "open",
        label: "Open",
        testId: "homepage-project-open",
        onSelect: () => onOpen(project),
      },
      {
        id: "rename",
        label: "Edit Project",
        testId: "homepage-project-rename",
        onSelect: () => onRename(project),
      },
      {
        id: "remove",
        label: removeLabel,
        testId: "homepage-project-remove",
        onSelect: () => onRequestRemove(project),
      },
    ],
  });

  useEffect(() => {
    if (menu?.open) {
      skipOpenRef.current = true;
      return;
    }
    const frame = requestAnimationFrame(() => {
      skipOpenRef.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [menu?.open]);

  const meta = listedProjectMetaParts(projects, project);
  const openProject = () => {
    if (busy) return;
    onOpen(project);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (
      event.key === "ContextMenu" ||
      (event.key === "F10" && event.shiftKey)
    ) {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      openMenuAt(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openProject();
    }
  };

  return (
    <li>
      <Card
        size="sm"
        role="group"
        tabIndex={busy ? -1 : 0}
        aria-label={`Open ${displayProjectName(project.label)}`}
        aria-disabled={busy}
        data-testid={`open-listed-project-${project.name}`}
        className="homepage-project-row"
        {...bind}
        onClick={(event) => {
          if (skipOpenRef.current) {
            skipOpenRef.current = false;
            return;
          }
          if ((event.target as HTMLElement).closest("button")) return;
          openProject();
        }}
        onKeyDown={onKeyDown}
      >
        <CardContent
          className="homepage-project-well"
          data-testid="project-card-well"
          data-color={project.appearance?.color ?? "coral"}
        >
          <ProjectIdentityBadge appearance={project.appearance} />
          <Button
            type="button"
            variant="ghost"
            size="touch-icon"
            className="homepage-project-actions"
            aria-label={`Project Actions for ${displayProjectName(project.label)}`}
            disabled={busy}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              const rect = event.currentTarget.getBoundingClientRect();
              openMenuAt(rect.right, rect.bottom);
            }}
          >
            <MoreHorizontalIcon />
          </Button>
        </CardContent>
        <CardHeader className="homepage-project-caption">
          <CardTitle>{displayProjectName(project.label)}</CardTitle>
          <CardDescription>
            {meta.length > 0 ? meta.join(" · ") : "Ready for your next idea"}
          </CardDescription>
        </CardHeader>
        <CardFooter className="homepage-project-footer">
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Open Project ${displayProjectName(project.label)}`}
            disabled={busy}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              openProject();
            }}
          >
            <span className="homepage-project-open-desktop">Open Project</span>
            <span className="homepage-project-open-phone">Open</span>
            <ArrowUpRightIcon data-icon="inline-end" />
          </Button>
          <IconActionButton
            type="button"
            variant="ghost"
            size="touch-icon"
            label={removeLabel}
            disabled={busy}
            data-testid={`remove-listed-project-${project.name}`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              event.preventDefault();
              onRequestRemove(project);
            }}
          >
            <Trash2Icon />
          </IconActionButton>
        </CardFooter>
      </Card>
      <ContextMenuOverlay
        menu={menu}
        onClose={closeMenu}
        contentTestId="homepage-project-menu"
      />
    </li>
  );
}

interface HomepageProps {
  projects: ListedProject[];
  templates: Array<{ id: string; name: string }>;
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
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [renameTarget, setRenameTarget] = useState<ListedProject | null>(null);
  const [removeTarget, setRemoveTarget] = useState<ListedProject | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [appearance, setAppearance] = useState<ProjectAppearance>(
    DEFAULT_PROJECT_APPEARANCE,
  );
  const [createName, setCreateName] = useState("");
  const [createTemplateId, setCreateTemplateId] = useState<string>("empty");
  const [createWidth, setCreateWidth] = useState(DEFAULT_RENDER_WIDTH);
  const [createHeight, setCreateHeight] = useState(DEFAULT_RENDER_HEIGHT);
  const [createBlackBars, setCreateBlackBars] = useState(false);
  const [pickFolder, setPickFolder] = useState(false);
  const [projectSearch, setProjectSearch] = useState("");
  const [locationFilters, setLocationFilters] = useState<
    HomepageProjectLocationFilter[]
  >([]);
  const [sortMode, setSortMode] =
    useState<HomepageProjectSortMode>("last-opened-desc");
  const hostPlatform = getHostPlatform();
  const deleteRemoveTarget =
    removeTarget !== null &&
    shouldDeleteOpfsOnRemove(hostPlatform, removeTarget.tier);
  const nameIssue = renameTarget
    ? createName.trim()
      ? null
      : "Name required."
    : createProjectNameIssue(
        createName,
        projects.map((project) => project.name),
      );
  const mixedLocations =
    projects.length > 0 &&
    listedProjectLocationLabel(projects, projects[0]!) !== null;
  const visibleProjects = useMemo(
    () =>
      sortListedProjects(
        filterListedProjects(projects, {
          search: projectSearch,
          locationFilters,
        }),
        sortMode,
      ),
    [projects, projectSearch, locationFilters, sortMode],
  );

  const run = async (fn: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const openCreate = (templateId: string) => {
    if (busyRef.current) return;
    setError(null);
    setRenameTarget(null);
    setAppearance(DEFAULT_PROJECT_APPEARANCE);
    setCreateName(defaultCreateProjectDisplayName(isTestModeEnabled()));
    setCreateTemplateId(templateId);
    setPickFolder(false);
    setCreateWidth(DEFAULT_RENDER_WIDTH);
    setCreateHeight(DEFAULT_RENDER_HEIGHT);
    setCreateBlackBars(false);
    setCreateOpen(true);
  };

  return (
    <div
      className="homepage homepage-theme safe-frame safe-frame-top"
      data-testid="homepage"
    >
      <style data-slate-home-styles>{homepageStyles}</style>
      <header className="homepage-header">
        <div className="homepage-brand">
          <BrandIcon className="homepage-brand-icon" />
          <h1>Slate</h1>
          <span className="homepage-brand-caption">A Space for Creating</span>
        </div>
        <nav className="homepage-nav" aria-label="Slate">
          <a
            className="homepage-docs"
            href="https://hideoutgames.github.io/BabylonSlate/docs/"
            target="_blank"
            rel="noreferrer"
          >
            Guide <ArrowUpRightIcon aria-hidden="true" />
          </a>
          <Button
            variant="ghost"
            size="touch"
            aria-label="Engine Settings"
            data-testid="engine-settings"
            disabled={busy}
            onClick={() => {
              if (!busyRef.current) setSettingsOpen(true);
            }}
          >
            <Settings2Icon data-icon="inline-start" />
            <span>Settings</span>
          </Button>
          <HomepageAccount disabled={busy} />
        </nav>
      </header>

      <main className="homepage-main">
        <div className="homepage-main-inner">
          {needsReconnect ? (
            <Alert variant="destructive" data-testid="reconnect-banner">
              <AlertTitle>Project folder unavailable</AlertTitle>
              <AlertDescription className="flex flex-col gap-3">
                <span>
                  The external project folder bookmark is stale. Reconnect to
                  continue.
                </span>
                <Button
                  className="w-fit"
                  data-testid="reconnect-project"
                  disabled={busy}
                  onClick={() => void run(onReconnect)}
                >
                  Reconnect project folder
                </Button>
              </AlertDescription>
            </Alert>
          ) : null}

          {recoveryAvailable ? (
            <Alert data-testid="recovery-prompt">
              <AlertTitle>Recovery journal found</AlertTitle>
              <AlertDescription className="flex flex-col gap-3">
                <span>
                  A recovery journal was found for this project. Replay unsaved
                  edits now, or discard the journal.
                </span>
                <div className="flex gap-2">
                  <Button
                    data-testid="recover-journal"
                    onClick={() => void onRecover()}
                  >
                    Recover edits
                  </Button>
                  <Button
                    variant="outline"
                    data-testid="dismiss-journal"
                    onClick={onDismissRecovery}
                  >
                    Discard journal
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          ) : null}

          <section
            className="homepage-hero"
            data-testid="homepage-start"
            aria-labelledby="homepage-welcome"
          >
            <div className="homepage-hero-copy">
              <p className="homepage-eyebrow">Your Next World Starts Here</p>
              <h2 id="homepage-welcome">
                A blank Slate.
                <br />
                Endless <em>possibilities.</em>
              </h2>
              <p className="homepage-hero-description">
                Big ideas. Small experiments. Whatever you have in mind, make it
                your own.
              </p>
              <div
                className="homepage-start-actions"
                data-testid="homepage-start-actions"
              >
                <Button
                  size="touch"
                  data-testid="create-project"
                  disabled={busy}
                  onClick={() => openCreate("empty")}
                >
                  <PlusIcon data-icon="inline-start" />
                  Create Project
                </Button>
                <Button
                  variant="outline"
                  size="touch"
                  data-testid="open-project"
                  disabled={busy}
                  onClick={() => void run(onOpenExternal)}
                >
                  <FolderOpenIcon data-icon="inline-start" />
                  Open Folder…
                </Button>
              </div>
            </div>
            <div className="homepage-orbit" aria-hidden="true">
              <div className="homepage-dot-field" />
              <span className="homepage-orbit-ring" />
              <span className="homepage-orbit-coordinate">
                X 00 / Y 00 / Z 00
              </span>
              <div className="homepage-orbit-logo">
                <img src={brandIconSrc("light")} alt="" />
              </div>
              <span className="homepage-orbit-note">
                A Little Space. A Lot of Potential.
              </span>
            </div>
          </section>

          <section
            className="homepage-library"
            aria-labelledby="homepage-projects-title"
          >
            <div className="homepage-library-heading">
              <div className="homepage-section-title">
                <h2 id="homepage-projects-title">Your Projects</h2>
                <Badge variant="secondary">{projects.length}</Badge>
              </div>
              {projects.length > 0 ? (
                <div className="homepage-library-tools">
                  <SearchInput
                    value={projectSearch}
                    onChange={setProjectSearch}
                    placeholder="Search projects…"
                    className="min-h-[var(--touch-target,44px)] min-w-40"
                    data-testid="homepage-project-search"
                  />
                  {mixedLocations ? (
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <Button
                            type="button"
                            variant="outline"
                            size="touch"
                            data-testid="homepage-project-filter"
                            aria-label="Filter"
                          />
                        }
                      >
                        <ListFilterIcon data-icon="inline-start" />
                        Filter
                        {locationFilters.length > 0
                          ? ` (${locationFilters.length})`
                          : ""}
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="end"
                        className="min-w-44"
                        data-testid="homepage-project-filter-menu"
                      >
                        <DropdownMenuGroup>
                          <DropdownMenuLabel>Location</DropdownMenuLabel>
                          {HOMEPAGE_LOCATION_FILTERS.map((option) => (
                            <DropdownMenuCheckboxItem
                              key={option.id}
                              checked={locationFilters.includes(option.id)}
                              data-testid={`homepage-project-filter-${option.id}`}
                              onCheckedChange={(checked) => {
                                setLocationFilters((current) =>
                                  checked === true
                                    ? current.includes(option.id)
                                      ? current
                                      : [...current, option.id]
                                    : current.filter(
                                        (entry) => entry !== option.id,
                                      ),
                                );
                              }}
                            >
                              {option.label}
                            </DropdownMenuCheckboxItem>
                          ))}
                        </DropdownMenuGroup>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          type="button"
                          variant="outline"
                          size="touch"
                          data-testid="homepage-project-sort"
                          aria-label="Sort"
                        />
                      }
                    >
                      <ArrowUpDownIcon data-icon="inline-start" />
                      Sort
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                      align="end"
                      className="min-w-44"
                      data-testid="homepage-project-sort-menu"
                    >
                      <DropdownMenuGroup>
                        <DropdownMenuLabel>Sort By</DropdownMenuLabel>
                        <DropdownMenuRadioGroup
                          value={sortMode}
                          onValueChange={(value) => {
                            const next = HOMEPAGE_PROJECT_SORT_OPTIONS.find(
                              (option) => option.mode === value,
                            );
                            if (next) setSortMode(next.mode);
                          }}
                        >
                          {HOMEPAGE_PROJECT_SORT_OPTIONS.map((option) => (
                            <DropdownMenuRadioItem
                              key={option.mode}
                              value={option.mode}
                              data-testid={`homepage-project-sort-${option.mode}`}
                            >
                              {option.label}
                            </DropdownMenuRadioItem>
                          ))}
                        </DropdownMenuRadioGroup>
                      </DropdownMenuGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              ) : null}
            </div>
            {projects.length === 0 ? (
              <Empty data-testid="no-projects" className="homepage-empty">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <FolderOpenIcon />
                  </EmptyMedia>
                  <EmptyTitle>Something Great Starts Here.</EmptyTitle>
                  <EmptyDescription>
                    Your projects will live here. Give your first idea a name
                    and a place to grow.
                  </EmptyDescription>
                </EmptyHeader>
                <Button
                  variant="outline"
                  size="touch"
                  className="homepage-empty-action"
                  onClick={() => openCreate("empty")}
                  disabled={busy}
                >
                  Make Your First Project{" "}
                  <ArrowRightIcon data-icon="inline-end" />
                </Button>
              </Empty>
            ) : visibleProjects.length === 0 ? (
              <Empty data-testid="no-matching-projects">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <FolderOpenIcon />
                  </EmptyMedia>
                  <EmptyTitle>No matching projects</EmptyTitle>
                  <EmptyDescription>
                    Clear search or filters to see recents again.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <ul className="homepage-project-list" data-testid="project-list">
                {visibleProjects.map((project) => (
                  <HomepageProjectRow
                    key={project.id}
                    project={project}
                    projects={projects}
                    busy={busy}
                    deleteOnRemove={shouldDeleteOpfsOnRemove(
                      hostPlatform,
                      project.tier,
                    )}
                    onOpen={(next) => void run(() => onOpenProject(next))}
                    onRename={(next) => {
                      setError(null);
                      setRenameTarget(next);
                      setCreateName(displayProjectName(next.label));
                      setAppearance(
                        next.appearance ?? DEFAULT_PROJECT_APPEARANCE,
                      );
                      setCreateOpen(true);
                    }}
                    onRequestRemove={setRemoveTarget}
                  />
                ))}
              </ul>
            )}
          </section>

          <section className="homepage-starters">
            <div className="homepage-starters-heading">
              <h2>A Starting Point</h2>
              <p data-testid="create-project-description">
                {createProjectCardDescription(templates.length, hostPlatform)}
              </p>
            </div>
            <div
              className="homepage-template-gallery flex-nowrap overflow-x-auto overscroll-x-contain"
              data-testid="homepage-start-gallery"
            >
              <TemplatePickCard
                title="Empty"
                description="Room for a new world"
                testId="homepage-start-empty"
                disabled={busy}
                icon={BoxIcon}
                onSelect={() => openCreate("empty")}
              />
              <TemplatePickCard
                title="2D"
                description="A new dimension of play"
                testId="homepage-start-2d"
                disabled={busy}
                icon={Grid2x2Icon}
                onSelect={() => openCreate("2d")}
              />
              {templates.map((template) => (
                <TemplatePickCard
                  key={template.id}
                  title={template.name}
                  testId={`homepage-start-template-${template.id}`}
                  disabled={busy}
                  icon={LayoutTemplateIcon}
                  onSelect={() => openCreate(template.id)}
                />
              ))}
            </div>
          </section>

          {error ? (
            <Alert variant="destructive" data-testid="homepage-error">
              <AlertTitle>Error</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {busy ? (
            <p role="status" className="homepage-busy">
              Getting things ready…
            </p>
          ) : null}
          <footer className="homepage-footer">
            <span>Made for making. Built around you.</span>
            <div className="homepage-footer-links">
              <span>Local Projects · Full Creative Freedom</span>
              <a
                href="https://hideoutgames.github.io/BabylonSlate/docs/"
                target="_blank"
                rel="noreferrer"
                className="homepage-docs"
              >
                <BookOpenIcon aria-hidden="true" />
                Documentation
              </a>
            </div>
          </footer>
        </div>
      </main>

      <HomepageCreateDialog
        appearance={appearance}
        onAppearanceChange={setAppearance}
        open={createOpen}
        mode={renameTarget ? "edit" : "create"}
        error={error}
        onOpenChange={(open) => {
          if (!busy) setCreateOpen(open);
        }}
        busy={busy}
        name={createName}
        onNameChange={setCreateName}
        nameIssue={nameIssue}
        templateId={createTemplateId}
        onTemplateIdChange={setCreateTemplateId}
        templates={templates}
        hostPlatform={hostPlatform}
        pickFolder={pickFolder}
        onPickFolderChange={setPickFolder}
        width={createWidth}
        onWidthChange={setCreateWidth}
        height={createHeight}
        onHeightChange={setCreateHeight}
        blackBars={createBlackBars}
        onBlackBarsChange={setCreateBlackBars}
        onSubmit={() => {
          if (nameIssue || busy) return;
          if (renameTarget) {
            const target = renameTarget;
            void run(async () => {
              await onUpdateProject(target, {
                name: createName.trim(),
                appearance,
              });
              setCreateOpen(false);
              setRenameTarget(null);
            });
            return;
          }
          const folderName = normalizeProjectFolderName(createName);
          if (!folderName) return;
          const options: CreateProjectOptions = {
            appearance,
            renderWidth: createWidth,
            renderHeight: createHeight,
            blackBars: createBlackBars,
            ...(hostPlatform === "web" ? {} : { pickFolder }),
          };
          void run(async () => {
            if (createTemplateId === "empty" || createTemplateId === "2d") {
              await onCreateEmpty(folderName, {
                ...options,
                kind: createTemplateId,
              });
            } else {
              await onCreateFromTemplate(createTemplateId, folderName, options);
            }
            setCreateOpen(false);
          });
        }}
      />

      <AlertDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(null);
        }}
      >
        <AlertDialogContent
          variant={deleteRemoveTarget ? "destructive" : "default"}
          data-testid="homepage-remove-dialog"
        >
          {deleteRemoveTarget ? (
            <AlertDialogHeader>
              <AlertDialogMedia>
                <OctagonAlertIcon />
              </AlertDialogMedia>
              <AlertDialogTitle>Delete Project?</AlertDialogTitle>
              <AlertDialogDescription>
                This project lives in the browser and will be removed
                permanently. Export Project first if you need a copy.
              </AlertDialogDescription>
            </AlertDialogHeader>
          ) : (
            <AlertDialogHeader>
              <AlertDialogTitle>Remove from List?</AlertDialogTitle>
              <AlertDialogDescription>
                The project files stay on disk. This only drops the recent from
                the Homepage list.
              </AlertDialogDescription>
            </AlertDialogHeader>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="homepage-remove-cancel">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant={deleteRemoveTarget ? "destructive" : undefined}
              data-testid="homepage-remove-confirm"
              onClick={() => {
                const target = removeTarget;
                if (!target) return;
                void run(() => onRemoveFromList(target));
                setRemoveTarget(null);
              }}
            >
              {deleteRemoveTarget ? "Delete" : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {settingsOpen ? (
        <Suspense fallback={null}>
          <SettingsModal
            open={settingsOpen}
            onOpenChange={setSettingsOpen}
            scope="engine"
            onEngineSaved={onSettingsChanged}
            data-testid="engine-settings-modal"
          />
        </Suspense>
      ) : null}
    </div>
  );
}
