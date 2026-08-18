import { useMemo, useState } from "react";
import {
  ArrowUpDownIcon,
  BoxIcon,
  FolderOpenIcon,
  Grid2x2Icon,
  LayoutTemplateIcon,
  ListFilterIcon,
  PlusIcon,
} from "lucide-react";
import {
  DEFAULT_RENDER_HEIGHT,
  DEFAULT_RENDER_WIDTH,
  type ProjectFolderHandle,
} from "@babylonslate/core";
import {
  getHostPlatform,
  isTestModeEnabled,
  type HostPlatform,
} from "@babylonslate/vfs";
import { Alert, AlertDescription, AlertTitle } from "@babylonslate/ui/components/alert";
import { Button } from "@babylonslate/ui/components/button";
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
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@babylonslate/ui/components/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@babylonslate/ui/components/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@babylonslate/ui/components/empty";
import {
  Field,
  FieldGroup,
  FieldLabel,
} from "@babylonslate/ui/components/field";
import { Input } from "@babylonslate/ui/components/input";
import { SearchInput } from "@babylonslate/editor-kit";
import { displayProjectName } from "../lib/display-project-name";
import {
  filterListedProjects,
  HOMEPAGE_PROJECT_SORT_OPTIONS,
  listedProjectLocationLabel,
  listedProjectMetaParts,
  sortListedProjects,
  type HomepageProjectLocationFilter,
  type HomepageProjectSortMode,
  type ListedProject,
} from "../lib/listed-projects";
import {
  createProjectNameIssue,
  defaultCreateProjectDisplayName,
  normalizeProjectFolderName,
  type CreateProjectOptions,
} from "../lib/create-project";
import { BrandIcon } from "./brand-icon";
import { HomepageCreateDialog } from "./homepage-create-dialog";
import { TemplatePickCard } from "./homepage-template-card";
import { SettingsModal } from "./settings-modal";
import "./homepage.css";

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

interface HomepageProps {
  projects: ListedProject[];
  templates: Array<{ id: string; name: string }>;
  needsReconnect: boolean;
  recoveryAvailable: boolean;
  onCreateEmpty: (name: string, options?: CreateProjectOptions) => Promise<void>;
  onCreateFromTemplate: (
    templateId: string,
    name: string,
    options?: CreateProjectOptions,
  ) => Promise<void>;
  onOpenExternal: () => Promise<void>;
  onOpenProject: (handle: ProjectFolderHandle) => Promise<void>;
  onRenameProject: (handle: ProjectFolderHandle, name: string) => Promise<void>;
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
  onRenameProject,
  onRemoveFromList,
  onReconnect,
  onRecover,
  onDismissRecovery,
  onSettingsChanged,
}: HomepageProps) {
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [renameTarget, setRenameTarget] = useState<ListedProject | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
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
  const nameIssue = createProjectNameIssue(
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
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const openCreate = (templateId: string) => {
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
      className="homepage flex min-h-svh h-dvh flex-col overflow-hidden bg-background text-foreground lg:flex-row"
      data-testid="homepage"
    >
      <aside className="homepage-rail flex shrink-0 items-center justify-between gap-4 border-b border-border px-6 py-4 lg:h-full lg:w-[min(22rem,34vw)] lg:flex-col lg:items-start lg:justify-between lg:border-r lg:border-b-0 lg:px-10 lg:py-12">
        <div className="flex items-center gap-4 lg:flex-col lg:items-start lg:gap-8">
          <BrandIcon className="homepage-brand-icon size-12 lg:size-40" />
          <h1 className="m-0 font-heading text-xl tracking-tight lg:text-3xl">
            BabylonSlate
          </h1>
        </div>
        <Button
          variant="outline"
          size="touch"
          data-testid="engine-settings"
          onClick={() => setSettingsOpen(true)}
        >
          Engine Settings
        </Button>
      </aside>

      <main className="homepage-main mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col gap-10 overflow-hidden px-6 py-8 lg:px-10 lg:py-12">
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

        <section className="flex shrink-0 flex-col gap-4" data-testid="homepage-start">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="flex flex-col gap-1">
              <h2 className="m-0 font-heading text-lg">Start</h2>
              <p
                className="text-sm text-muted-foreground"
                data-testid="create-project-description"
              >
                {createProjectCardDescription(templates.length, hostPlatform)}
              </p>
            </div>
            <div
              className="flex flex-wrap items-center gap-2"
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
          <div
            className="homepage-stagger flex flex-nowrap gap-3 overflow-x-auto overscroll-x-contain pb-1"
            data-testid="homepage-start-gallery"
          >
            <TemplatePickCard
              title="Empty"
              description="Blank 3D project"
              testId="homepage-start-empty"
              icon={BoxIcon}
              onSelect={() => openCreate("empty")}
            />
            <TemplatePickCard
              title="2D"
              description="Pixel-perfect Rapier"
              testId="homepage-start-2d"
              icon={Grid2x2Icon}
              onSelect={() => openCreate("2d")}
            />
            {templates.map((template) => (
              <TemplatePickCard
                key={template.id}
                title={template.name}
                testId={`homepage-start-template-${template.id}`}
                icon={LayoutTemplateIcon}
                onSelect={() => openCreate(template.id)}
              />
            ))}
          </div>
        </section>

        <section className="flex min-h-0 flex-1 flex-col gap-4">
          <div className="flex shrink-0 flex-col gap-3">
            <div className="flex flex-col gap-1">
              <h2 className="m-0 font-heading text-lg">Projects</h2>
              <p className="text-sm text-muted-foreground">
                Recently opened projects on this device.
              </p>
            </div>
            {projects.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2">
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
            <Empty data-testid="no-projects">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FolderOpenIcon />
                </EmptyMedia>
                <EmptyTitle>No projects yet</EmptyTitle>
                <EmptyDescription>
                  Create an Empty project to get started.
                </EmptyDescription>
              </EmptyHeader>
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
            <ul
              className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overscroll-y-contain"
              data-testid="project-list"
            >
              {visibleProjects.map((project) => {
                const meta = listedProjectMetaParts(projects, project);
                return (
                  <li key={project.id}>
                    <ContextMenu>
                      <ContextMenuTrigger className="block">
                        <Button
                          variant="outline"
                          className="homepage-project-row h-auto min-h-[var(--touch-target,44px)] w-full justify-start gap-3 px-3 py-2"
                          data-testid={`open-listed-project-${project.name}`}
                          disabled={busy}
                          onClick={() => void run(() => onOpenProject(project))}
                        >
                          <span
                            data-testid="project-card-well"
                            className="homepage-project-well rounded-md"
                          >
                            <span
                              aria-hidden="true"
                              className="homepage-mark-diamond"
                            />
                            <BoxIcon />
                          </span>
                          <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                            <span className="font-medium">
                              {displayProjectName(project.label)}
                            </span>
                            {meta.length > 0 ? (
                              <span className="text-xs text-muted-foreground">
                                {meta.join(" · ")}
                              </span>
                            ) : null}
                          </span>
                        </Button>
                      </ContextMenuTrigger>
                      <ContextMenuContent data-testid="homepage-project-menu">
                        <ContextMenuGroup>
                          <ContextMenuItem
                            data-testid="homepage-project-open"
                            onClick={() => void run(() => onOpenProject(project))}
                          >
                            Open
                          </ContextMenuItem>
                          <ContextMenuItem
                            data-testid="homepage-project-rename"
                            onClick={() => {
                              setRenameTarget(project);
                              setRenameValue(
                                displayProjectName(project.label),
                              );
                            }}
                          >
                            Rename
                          </ContextMenuItem>
                          <ContextMenuItem
                            data-testid="homepage-project-remove"
                            onClick={() =>
                              void run(() => onRemoveFromList(project))
                            }
                          >
                            Remove from list
                          </ContextMenuItem>
                        </ContextMenuGroup>
                      </ContextMenuContent>
                    </ContextMenu>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {error ? (
          <Alert variant="destructive" data-testid="homepage-error">
            <AlertTitle>Error</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
      </main>

      <HomepageCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
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
          if (nameIssue) return;
          const folderName = normalizeProjectFolderName(createName);
          if (!folderName) return;
          const options: CreateProjectOptions = {
            pickFolder,
            renderWidth: createWidth,
            renderHeight: createHeight,
            blackBars: createBlackBars,
          };
          setCreateOpen(false);
          if (createTemplateId === "empty" || createTemplateId === "2d") {
            void run(() =>
              onCreateEmpty(folderName, {
                ...options,
                kind: createTemplateId,
              }),
            );
          } else {
            void run(() =>
              onCreateFromTemplate(createTemplateId, folderName, options),
            );
          }
        }}
      />

      <Dialog
        open={renameTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRenameTarget(null);
        }}
      >
        <DialogContent data-testid="homepage-rename-dialog">
          <DialogHeader>
            <DialogTitle>Rename project</DialogTitle>
            <DialogDescription>
              Changes the display name in recents and project metadata. The
              folder name is unchanged.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="homepage-rename-input">Name</FieldLabel>
              <Input
                id="homepage-rename-input"
                data-testid="homepage-rename-input"
                value={renameValue}
                onChange={(event) => setRenameValue(event.target.value)}
              />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setRenameTarget(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              data-testid="homepage-rename-confirm"
              disabled={busy || !renameValue.trim()}
              onClick={() => {
                const target = renameTarget;
                if (!target) return;
                void run(() => onRenameProject(target, renameValue.trim()));
                setRenameTarget(null);
              }}
            >
              Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SettingsModal
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        scope="engine"
        onEngineSaved={onSettingsChanged}
        data-testid="engine-settings-modal"
      />
    </div>
  );
}
