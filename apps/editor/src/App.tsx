import { useState } from "react";
import {
  usePreventDocumentOverscroll,
  useSuppressNativeContextMenu,
} from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import { EditorChromeBar } from "./components/editor-chrome-bar";
import { DocumentWorkspace } from "./components/document-workspace";
import { Homepage } from "./components/homepage";
import { DocumentProvider, useDocuments } from "./context/document-context";

function DirtyCloseDialog({
  dirtyNames,
  onSave,
  onDiscard,
  onCancel,
}: {
  dirtyNames: string[];
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      data-testid="dirty-close-dialog"
    >
      <div className="flex w-full max-w-md flex-col gap-4 rounded-lg border border-border bg-background p-6 shadow-lg">
        <h2 className="text-lg font-medium">Unsaved documents</h2>
        <p className="text-sm text-muted-foreground">
          Save before closing? Unsaved:
        </p>
        <ul className="list-disc pl-5 text-sm">
          {dirtyNames.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" data-testid="dirty-cancel" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="secondary"
            data-testid="dirty-discard"
            onClick={onDiscard}
          >
            Discard
          </Button>
          <Button data-testid="dirty-save" onClick={onSave}>
            Save All
          </Button>
        </div>
      </div>
    </div>
  );
}

function MigrationPrompt({
  paths,
  onApprove,
  onCancel,
}: {
  paths: string[];
  onApprove: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      data-testid="migrate-on-save-dialog"
    >
      <div className="flex w-full max-w-md flex-col gap-4 rounded-lg border border-border bg-background p-6 shadow-lg">
        <h2 className="text-lg font-medium">Schema migration required</h2>
        <p className="text-sm text-muted-foreground">
          Some assets were made with an older schema. Migrate them on save? Files
          you do not save stay untouched.
        </p>
        <ul className="list-disc pl-5 text-sm">
          {paths.map((path) => (
            <li key={path}>{path}</li>
          ))}
        </ul>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" data-testid="migrate-cancel" onClick={onCancel}>
            Cancel
          </Button>
          <Button data-testid="migrate-approve" onClick={onApprove}>
            Migrate on save
          </Button>
        </div>
      </div>
    </div>
  );
}

function RecoveryBanner() {
  const { recoveryAvailable, keepRecovery, dismissRecovery } = useDocuments();
  if (!recoveryAvailable) return null;
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/40 px-4 py-3"
      data-testid="recovery-prompt"
    >
      <p className="text-sm">
        A recovery journal was found. Replay unsaved graph edits, or discard the
        journal.
      </p>
      <div className="flex gap-2">
        <Button data-testid="recover-journal" onClick={() => void keepRecovery()}>
          Recover edits
        </Button>
        <Button
          variant="outline"
          data-testid="dismiss-journal"
          onClick={() => void dismissRecovery()}
        >
          Discard journal
        </Button>
      </div>
    </div>
  );
}

function EditorLayout() {
  const {
    closeProject,
    forceCloseProject,
    saveAll,
    dirtyDocuments,
    migrationPending,
    approveMigrationsAndSave,
  } = useDocuments();
  const [dirtyPrompt, setDirtyPrompt] = useState<string[] | null>(null);
  const [showMigrate, setShowMigrate] = useState(false);

  const requestClose = async () => {
    const result = await closeProject();
    if (result.blocked) {
      setDirtyPrompt(result.dirty.map((d) => d.ref.label));
    }
  };

  const requestSave = async () => {
    if (migrationPending.length > 0) {
      setShowMigrate(true);
      return;
    }
    await saveAll();
  };

  return (
    <div className="flex min-h-svh h-dvh flex-col overflow-hidden bg-background text-foreground">
      <EditorChromeBar
        onCloseProject={() => void requestClose()}
        onSaveProject={() => void requestSave()}
      />
      <RecoveryBanner />
      <main className="flex min-h-0 flex-1 flex-col">
        <DocumentWorkspace />
      </main>
      {dirtyPrompt ? (
        <DirtyCloseDialog
          dirtyNames={dirtyPrompt}
          onCancel={() => setDirtyPrompt(null)}
          onDiscard={() => {
            setDirtyPrompt(null);
            void forceCloseProject();
          }}
          onSave={() => {
            void (async () => {
              await requestSave();
              setDirtyPrompt(null);
              await forceCloseProject();
            })();
          }}
        />
      ) : null}
      {showMigrate ? (
        <MigrationPrompt
          paths={migrationPending.map((p) => p.path)}
          onCancel={() => setShowMigrate(false)}
          onApprove={() => {
            setShowMigrate(false);
            void approveMigrationsAndSave();
          }}
        />
      ) : null}
      <span className="sr-only" data-testid="dirty-count">
        {dirtyDocuments.length}
      </span>
    </div>
  );
}

function AppRoutes() {
  useSuppressNativeContextMenu();
  usePreventDocumentOverscroll();
  const {
    route,
    listedProjects,
    needsReconnect,
    recoveryAvailable,
    templates,
    refreshTemplates,
    createEmptyProject,
    createFromTemplate,
    openProject,
    openListedProject,
    reconnectProject,
    keepRecovery,
    dismissRecovery,
  } = useDocuments();

  if (route === "home") {
    return (
      <Homepage
        projects={listedProjects}
        templates={templates.map((t) => ({ id: t.id, name: t.name }))}
        needsReconnect={needsReconnect}
        recoveryAvailable={recoveryAvailable}
        onCreateEmpty={createEmptyProject}
        onCreateFromTemplate={(id, name) => createFromTemplate(id, name)}
        onOpenExternal={openProject}
        onOpenProject={openListedProject}
        onReconnect={reconnectProject}
        onRecover={() => void keepRecovery()}
        onDismissRecovery={() => void dismissRecovery()}
        onSettingsChanged={refreshTemplates}
      />
    );
  }

  return <EditorLayout />;
}

export default function App() {
  return (
    <DocumentProvider>
      <AppRoutes />
    </DocumentProvider>
  );
}
