import { useState } from "react";
import { FolderOpenIcon, LayoutTemplateIcon } from "lucide-react";
import {
  DEFAULT_RENDER_HEIGHT,
  DEFAULT_RENDER_WIDTH,
  type ProjectFolderHandle,
} from "@babylonslate/core";
import { NumberField } from "@babylonslate/editor-kit";
import {
  getHostPlatform,
  isTestModeEnabled,
  type HostPlatform,
} from "@babylonslate/vfs";
import { Alert, AlertDescription, AlertTitle } from "@babylonslate/ui/components/alert";
import { Button } from "@babylonslate/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@babylonslate/ui/components/card";
import { Checkbox } from "@babylonslate/ui/components/checkbox";
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
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@babylonslate/ui/components/field";
import { Input } from "@babylonslate/ui/components/input";
import { cn } from "@babylonslate/ui/lib/utils";
import { displayProjectName } from "../lib/display-project-name";
import {
  listedProjectLocationLabel,
  type ListedProject,
} from "../lib/listed-projects";
import {
  createProjectNameIssue,
  defaultCreateProjectDisplayName,
  normalizeProjectFolderName,
  type CreateProjectOptions,
} from "../lib/create-project";
import { BrandLogo } from "./brand-logo";
import { SettingsModal } from "./settings-modal";

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
  const hostPlatform = getHostPlatform();
  const nameIssue = createProjectNameIssue(
    createName,
    projects.map((project) => project.name),
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

  return (
    <div
      className="flex min-h-svh h-dvh flex-col overflow-hidden bg-background text-foreground"
      data-testid="homepage"
    >
      <header className="flex items-center justify-between gap-3 border-b border-border px-6 py-4">
        <div className="flex flex-col gap-1">
          <h1 className="m-0">
            <BrandLogo />
          </h1>
          <p className="text-sm text-muted-foreground">
            Create or open a project to start editing
          </p>
        </div>
        <Button
          variant="outline"
          size="touch"
          data-testid="engine-settings"
          onClick={() => setSettingsOpen(true)}
        >
          Engine Settings
        </Button>
      </header>

      <main className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col gap-8 overflow-y-auto overscroll-y-contain px-6 py-8">
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

        <Card>
          <CardHeader>
            <CardTitle>Create Project</CardTitle>
            <CardDescription data-testid="create-project-description">
              {createProjectCardDescription(templates.length, hostPlatform)}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              data-testid="create-project"
              disabled={busy}
              onClick={() => {
                setCreateName(
                  defaultCreateProjectDisplayName(isTestModeEnabled()),
                );
                setCreateTemplateId("empty");
                setPickFolder(false);
                setCreateOpen(true);
              }}
            >
              Create Project
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-3">
            <div className="flex flex-col gap-1">
              <CardTitle>Projects</CardTitle>
              <CardDescription>Recently opened projects on this device.</CardDescription>
            </div>
            <Button
              variant="secondary"
              data-testid="open-project"
              disabled={busy}
              onClick={() => void run(onOpenExternal)}
            >
              <FolderOpenIcon data-icon="inline-start" />
              Open folder…
            </Button>
          </CardHeader>
          <CardContent>
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
            ) : (
              <ul className="flex flex-col gap-2" data-testid="project-list">
                {projects.map((project) => {
                  const location = listedProjectLocationLabel(
                    projects,
                    project,
                  );
                  return (
                    <li key={project.id}>
                      <ContextMenu>
                        <ContextMenuTrigger className="block">
                          <Button
                            variant="outline"
                            className="h-auto min-h-[var(--touch-target,44px)] w-full justify-between px-4 py-3"
                            data-testid={`open-listed-project-${project.name}`}
                            disabled={busy}
                            onClick={() => void run(() => onOpenProject(project))}
                          >
                            <span className="font-medium">
                              {displayProjectName(project.label)}
                            </span>
                            {location ? (
                              <span className="text-xs text-muted-foreground">
                                {location}
                              </span>
                            ) : null}
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
                                setRenameValue(displayProjectName(project.label));
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
          </CardContent>
        </Card>

        {error ? (
          <Alert variant="destructive" data-testid="homepage-error">
            <AlertTitle>Error</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
      </main>

      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          if (!open) setCreateOpen(false);
        }}
      >
        <DialogContent
          className="sm:max-w-lg"
          data-testid="create-project-dialog"
        >
          <DialogHeader>
            <DialogTitle>Create Project</DialogTitle>
            <DialogDescription>
              Name the project, pick Empty or 2D, then create.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={Boolean(nameIssue) || undefined}>
              <FieldLabel htmlFor="create-project-name">Name</FieldLabel>
              <Input
                id="create-project-name"
                data-testid="create-project-name"
                autoFocus
                aria-invalid={Boolean(nameIssue) || undefined}
                value={createName}
                onChange={(event) => setCreateName(event.target.value)}
              />
              {nameIssue ? (
                <FieldError data-testid="create-project-name-issue">
                  {nameIssue}
                </FieldError>
              ) : null}
            </Field>
            <Field>
              <FieldLabel>Template</FieldLabel>
              <div
                className="flex flex-wrap gap-2"
                data-testid="create-project-templates"
              >
                <Card
                  size="sm"
                  role="button"
                  tabIndex={0}
                  data-testid="create-project-empty"
                  data-selected={createTemplateId === "empty" ? "true" : "false"}
                  className={cn(
                    "min-w-28 cursor-pointer",
                    createTemplateId === "empty" ? "ring-2 ring-primary" : "",
                  )}
                  onClick={() => setCreateTemplateId("empty")}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setCreateTemplateId("empty");
                    }
                  }}
                >
                  <CardHeader>
                    <CardTitle>Empty</CardTitle>
                    <CardDescription>Blank 3D project</CardDescription>
                  </CardHeader>
                </Card>
                <Card
                  size="sm"
                  role="button"
                  tabIndex={0}
                  data-testid="create-project-2d"
                  data-selected={createTemplateId === "2d" ? "true" : "false"}
                  className={cn(
                    "min-w-28 cursor-pointer",
                    createTemplateId === "2d" ? "ring-2 ring-primary" : "",
                  )}
                  onClick={() => setCreateTemplateId("2d")}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setCreateTemplateId("2d");
                    }
                  }}
                >
                  <CardHeader>
                    <CardTitle>2D</CardTitle>
                    <CardDescription>Pixel-perfect Rapier</CardDescription>
                  </CardHeader>
                </Card>
                {templates.map((template) => (
                  <Card
                    key={template.id}
                    size="sm"
                    role="button"
                    tabIndex={0}
                    data-testid={`create-project-template-${template.id}`}
                    data-selected={
                      createTemplateId === template.id ? "true" : "false"
                    }
                    className={cn(
                      "min-w-28 cursor-pointer",
                      createTemplateId === template.id
                        ? "ring-2 ring-primary"
                        : "",
                    )}
                    onClick={() => setCreateTemplateId(template.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setCreateTemplateId(template.id);
                      }
                    }}
                  >
                    <CardHeader>
                      <CardTitle className="flex items-center gap-1">
                        <LayoutTemplateIcon data-icon="inline-start" />
                        {template.name}
                      </CardTitle>
                    </CardHeader>
                  </Card>
                ))}
              </div>
            </Field>
            <Field>
              <FieldLabel>Location</FieldLabel>
              <p
                className="text-sm text-muted-foreground"
                data-testid="create-project-location"
              >
                {hostPlatform === "web"
                  ? "On this device."
                  : pickFolder
                    ? "Choose a folder when you create"
                    : "App Documents"}
              </p>
              {hostPlatform !== "web" ? (
                <Button
                  type="button"
                  variant="outline"
                  data-testid="create-project-choose-folder"
                  onClick={() => setPickFolder((current) => !current)}
                >
                  {pickFolder ? "Use App Documents" : "Choose folder…"}
                </Button>
              ) : null}
            </Field>
            <Field>
              <FieldLabel htmlFor="create-project-width">
                Render Size
              </FieldLabel>
              <div className="flex items-center gap-2">
                <NumberField
                  id="create-project-width"
                  min={1}
                  step={1}
                  className="min-h-[var(--touch-target,44px)]"
                  value={createWidth}
                  onChange={setCreateWidth}
                  data-testid="create-project-width"
                  aria-label="Render Width"
                />
                <span aria-hidden="true">×</span>
                <NumberField
                  id="create-project-height"
                  min={1}
                  step={1}
                  className="min-h-[var(--touch-target,44px)]"
                  value={createHeight}
                  onChange={setCreateHeight}
                  data-testid="create-project-height"
                  aria-label="Render Height"
                />
              </div>
              <FieldDescription>
                Play and packaged builds use this framebuffer. Default 1920×1080.
              </FieldDescription>
            </Field>
            <Field orientation="horizontal">
              <Checkbox
                id="create-project-black-bars"
                checked={createBlackBars}
                onCheckedChange={(checked) =>
                  setCreateBlackBars(checked === true)
                }
                data-testid="create-project-black-bars"
              />
              <FieldLabel htmlFor="create-project-black-bars">
                Black Bars
              </FieldLabel>
            </Field>
            <FieldDescription>
              Off stretches the framebuffer to fill Play. On letterboxes with
              unused overlay space black.
            </FieldDescription>
          </FieldGroup>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setCreateOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              data-testid="create-project-submit"
              disabled={busy || Boolean(nameIssue)}
              onClick={() => {
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
                    onCreateFromTemplate(
                      createTemplateId,
                      folderName,
                      options,
                    ),
                  );
                }
              }}
            >
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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

