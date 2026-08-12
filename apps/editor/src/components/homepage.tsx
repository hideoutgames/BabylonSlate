import { useState } from "react";
import { FolderOpenIcon, LayoutTemplateIcon } from "lucide-react";
import type { ProjectFolderHandle } from "@babylonslate/core";
import { Alert, AlertDescription, AlertTitle } from "@babylonslate/ui/components/alert";
import { Button } from "@babylonslate/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@babylonslate/ui/components/card";
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
import { Field, FieldGroup, FieldLabel } from "@babylonslate/ui/components/field";
import { Input } from "@babylonslate/ui/components/input";
import { displayProjectName } from "../lib/display-project-name";
import type { ListedProject } from "../lib/listed-projects";
import { SettingsModal } from "./settings-modal";

interface HomepageProps {
  projects: ListedProject[];
  templates: Array<{ id: string; name: string }>;
  needsReconnect: boolean;
  recoveryAvailable: boolean;
  onCreateEmpty: () => Promise<void>;
  onCreateFromTemplate: (templateId: string, name: string) => Promise<void>;
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
          <h1 className="text-2xl font-semibold tracking-tight">BabylonSlate</h1>
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
            <CardDescription>
              {templates.length === 0
                ? "Template cards appear when a templates folder is set in Engine Settings (not available on web)."
                : "Creating from a template copies the project and rewrites only its name and identity."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-3">
            <Button
              data-testid="create-project-empty"
              disabled={busy}
              onClick={() => void run(onCreateEmpty)}
            >
              Empty
            </Button>
            {templates.map((template) => (
              <Button
                key={template.id}
                variant="secondary"
                data-testid={`create-project-template-${template.id}`}
                disabled={busy}
                onClick={() =>
                  void run(() =>
                    onCreateFromTemplate(
                      template.id,
                      `${template.name}-copy.babproject`,
                    ),
                  )
                }
              >
                <LayoutTemplateIcon data-icon="inline-start" />
                {template.name}
              </Button>
            ))}
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
                {projects.map((project) => (
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
                          <span className="text-xs text-muted-foreground">
                            {project.tier}
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
                              setRenameValue(displayProjectName(project.label));
                            }}
                          >
                            Rename
                          </ContextMenuItem>
                          <ContextMenuItem
                            data-testid="homepage-project-remove"
                            onClick={() => void run(() => onRemoveFromList(project))}
                          >
                            Remove from list
                          </ContextMenuItem>
                        </ContextMenuGroup>
                      </ContextMenuContent>
                    </ContextMenu>
                  </li>
                ))}
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

