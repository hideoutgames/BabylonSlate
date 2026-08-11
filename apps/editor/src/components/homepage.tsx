import { useEffect, useMemo, useState } from "react";
import { Button } from "@babylonslate/ui/components/button";
import type { ProjectFolderHandle } from "@babylonslate/core";
import {
  createAppSettingsStore,
  defaultEngineSettings,
  type EngineSettings,
} from "@babylonslate/vfs";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@babylonslate/ui/components/sheet";

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
  /** Engine Settings changes can add or remove template cards. */
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
      className="flex min-h-svh h-dvh flex-col bg-background text-foreground"
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

      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-6 py-8">
        {needsReconnect ? (
          <div
            className="flex flex-col gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4"
            data-testid="reconnect-banner"
          >
            <p className="text-sm">
              The external project folder bookmark is stale. Reconnect to continue.
            </p>
            <Button
              data-testid="reconnect-project"
              disabled={busy}
              onClick={() => void run(onReconnect)}
            >
              Reconnect project folder
            </Button>
          </div>
        ) : null}

        {recoveryAvailable ? (
          <div
            className="flex flex-col gap-3 rounded-lg border border-border p-4"
            data-testid="recovery-prompt"
          >
            <p className="text-sm">
              A recovery journal was found for this project. Replay unsaved
              edits now, or discard the journal.
            </p>
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
          </div>
        ) : null}

        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-medium">Create Project</h2>
          <div className="flex flex-wrap gap-3">
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
                {template.name}
              </Button>
            ))}
          </div>
          <p className="text-sm text-muted-foreground">
            {templates.length === 0
              ? "Template cards appear when a templates folder is set in Engine Settings (not available on web)."
              : "Creating from a template copies the project and rewrites only its name and identity."}
          </p>
        </section>

        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-medium">Projects</h2>
            <Button
              variant="secondary"
              data-testid="open-project"
              disabled={busy}
              onClick={() => void run(onOpenExternal)}
            >
              Open folder…
            </Button>
          </div>
          {projects.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="no-projects">
              No projects yet. Create an Empty project to get started.
            </p>
          ) : (
            <ul className="flex flex-col gap-2" data-testid="project-list">
              {projects.map((project) => (
                <li key={project.id}>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between rounded-lg border border-border px-4 py-3 text-left hover:bg-muted/40"
                    data-testid={`open-listed-project-${project.name}`}
                    disabled={busy}
                    onClick={() => void run(() => onOpenProject(project))}
                  >
                    <span className="font-medium">{project.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {project.tier}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {error ? (
          <p className="text-sm text-destructive" data-testid="homepage-error">
            {error}
          </p>
        ) : null}
      </main>

      <EngineSettingsSheet
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        onSaved={onSettingsChanged}
      />
    </div>
  );
}

function EngineSettingsSheet({
  open,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
}) {
  const store = useMemo(() => createAppSettingsStore(), []);
  const [settings, setSettings] = useState<EngineSettings>(defaultEngineSettings());

  useEffect(() => {
    if (!open) return;
    void store.load().then(setSettings);
  }, [open, store]);

  const save = async (patch: Partial<EngineSettings>) => {
    const next = { ...settings, ...patch };
    setSettings(next);
    await store.save(next);
    await onSaved();
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>Engine Settings</SheetTitle>
          <SheetDescription>
            Global editor preferences stored outside any project
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-4 px-4 pb-4" data-testid="engine-settings-sheet">
          <label className="flex flex-col gap-1 text-sm">
            Undo history length
            <input
              type="number"
              className="rounded-md border border-border bg-background px-3 py-2"
              data-testid="setting-undo-length"
              value={settings.undoHistoryLength}
              onChange={(e) =>
                void save({ undoHistoryLength: Number(e.target.value) || 50 })
              }
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Viewport frame cap
            <input
              type="number"
              className="rounded-md border border-border bg-background px-3 py-2"
              data-testid="setting-frame-cap"
              value={settings.viewportFrameCap}
              onChange={(e) =>
                void save({ viewportFrameCap: Number(e.target.value) || 60 })
              }
            />
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              data-testid="setting-thumbnails"
              checked={settings.thumbnailsEnabled}
              onChange={(e) => void save({ thumbnailsEnabled: e.target.checked })}
            />
            Generate thumbnails
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Templates folder
            <input
              type="text"
              className="rounded-md border border-border bg-background px-3 py-2"
              data-testid="setting-templates-folder"
              placeholder="Not available on web"
              value={settings.templatesFolder ?? ""}
              onChange={(e) =>
                void save({
                  templatesFolder: e.target.value ? e.target.value : null,
                })
              }
            />
          </label>
        </div>
      </SheetContent>
    </Sheet>
  );
}
