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
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@babylonslate/ui/components/empty";
import { SettingsModal } from "./settings-modal";

interface HomepageProps {
  projects: ProjectFolderHandle[];
  templates: Array<{ id: string; name: string }>;
  needsReconnect: boolean;
  recoveryAvailable: boolean;
  onCreateEmpty: () => Promise<void>;
  onCreateFromTemplate: (templateId: string, name: string) => Promise<void>;
  onOpenExternal: () => Promise<void>;
  onOpenProject: (handle: ProjectFolderHandle) => Promise<void>;
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
  onReconnect,
  onRecover,
  onDismissRecovery,
  onSettingsChanged,
}: HomepageProps) {
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState(false);

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
                    <Button
                      variant="outline"
                      className="h-auto min-h-[var(--touch-target,44px)] w-full justify-between px-4 py-3"
                      data-testid={`open-listed-project-${project.name}`}
                      disabled={busy}
                      onClick={() => void run(() => onOpenProject(project))}
                    >
                      <span className="font-medium">{project.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {project.tier}
                      </span>
                    </Button>
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

      <SettingsModal
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        initialScope="engine"
        allowEngine
        onEngineSaved={onSettingsChanged}
        data-testid="engine-settings-modal"
      />
    </div>
  );
}

