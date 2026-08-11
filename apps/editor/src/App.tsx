import { useState } from "react";
import { useSuppressNativeContextMenu } from "@babylonslate/editor-kit";
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

function EditorLayout() {
  useSuppressNativeContextMenu();
  const {
    closeProject,
    forceCloseProject,
    saveAll,
    dirtyDocuments,
  } = useDocuments();
  const [dirtyPrompt, setDirtyPrompt] = useState<string[] | null>(null);

  const requestClose = async () => {
    const result = await closeProject();
    if (result.blocked) {
      setDirtyPrompt(result.dirty.map((d) => d.ref.label));
    }
  };

  return (
    <div className="flex min-h-svh h-dvh flex-col bg-background text-foreground">
      <EditorChromeBar onCloseProject={() => void requestClose()} />
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
              await saveAll();
              setDirtyPrompt(null);
              await forceCloseProject();
            })();
          }}
        />
      ) : null}
      {/* expose dirty count for tests */}
      <span className="sr-only" data-testid="dirty-count">
        {dirtyDocuments.length}
      </span>
    </div>
  );
}

function AppRoutes() {
  const {
    route,
    listedProjects,
    needsReconnect,
    recoveryAvailable,
    createEmptyProject,
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
        needsReconnect={needsReconnect}
        recoveryAvailable={recoveryAvailable}
        onCreateEmpty={createEmptyProject}
        onOpenExternal={openProject}
        onOpenProject={openListedProject}
        onReconnect={reconnectProject}
        onRecover={keepRecovery}
        onDismissRecovery={() => void dismissRecovery()}
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
