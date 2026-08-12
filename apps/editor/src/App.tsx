import { useState } from "react";
import {
  usePreventDocumentOverscroll,
  useSuppressIosEditingGestures,
  useSuppressNativeContextMenu,
} from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
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
import { Alert, AlertDescription, AlertTitle } from "@babylonslate/ui/components/alert";
import { TooltipProvider } from "@babylonslate/ui/components/tooltip";
import { isTestModeEnabled } from "@babylonslate/vfs";
import { ComponentGallery } from "./components/component-gallery";
import { EditorChromeBar } from "./components/editor-chrome-bar";
import { DocumentWorkspace } from "./components/document-workspace";
import { Homepage } from "./components/homepage";
import { DocumentProvider, useDocuments } from "./context/document-context";
import { EditorThemeProvider } from "./context/theme-context";
import { PlayProvider } from "./context/play-context";
import { ProjectSearchProvider } from "./context/project-search-context";
import { ValidationProvider } from "./context/validation-context";

function DirtyCloseDialog({
  dirtyNames,
  open,
  onSave,
  onDiscard,
  onCancel,
}: {
  dirtyNames: string[];
  open: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <AlertDialogContent data-testid="dirty-close-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Unsaved documents</AlertDialogTitle>
          <AlertDialogDescription>
            Save before closing? Unsaved:
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="list-disc pl-5 text-sm">
          {dirtyNames.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="dirty-cancel">Cancel</AlertDialogCancel>
          <Button
            variant="secondary"
            data-testid="dirty-discard"
            onClick={onDiscard}
          >
            Discard
          </Button>
          <AlertDialogAction data-testid="dirty-save" onClick={onSave}>
            Save All
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function MigrationPrompt({
  paths,
  open,
  onApprove,
  onCancel,
}: {
  paths: string[];
  open: boolean;
  onApprove: () => void;
  onCancel: () => void;
}) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <AlertDialogContent data-testid="migrate-on-save-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Schema migration required</AlertDialogTitle>
          <AlertDialogDescription>
            Some assets were made with an older schema. Migrate them on save?
            Files you do not save stay untouched.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="list-disc pl-5 text-sm">
          {paths.map((path) => (
            <li key={path}>{path}</li>
          ))}
        </ul>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="migrate-cancel">Cancel</AlertDialogCancel>
          <AlertDialogAction data-testid="migrate-approve" onClick={onApprove}>
            Migrate on save
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function RecoveryBanner() {
  const { recoveryAvailable, keepRecovery, dismissRecovery } = useDocuments();
  if (!recoveryAvailable) return null;
  return (
    <Alert
      className="rounded-none border-x-0 border-t-0"
      data-testid="recovery-prompt"
    >
      <AlertTitle>Recovery journal found</AlertTitle>
      <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
        <span>
          Replay unsaved graph edits, or discard the journal.
        </span>
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
      </AlertDescription>
    </Alert>
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
      <DirtyCloseDialog
        dirtyNames={dirtyPrompt ?? []}
        open={dirtyPrompt !== null}
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
      <MigrationPrompt
        paths={migrationPending.map((p) => p.path)}
        open={showMigrate}
        onCancel={() => setShowMigrate(false)}
        onApprove={() => {
          setShowMigrate(false);
          void approveMigrationsAndSave();
        }}
      />
      <span className="sr-only" data-testid="dirty-count">
        {dirtyDocuments.length}
      </span>
    </div>
  );
}

function isComponentGalleryRoute(): boolean {
  if (typeof window === "undefined") return false;
  return (
    isTestModeEnabled() &&
    new URLSearchParams(window.location.search).has("gallery")
  );
}

function AppRoutes() {
  useSuppressNativeContextMenu();
  useSuppressIosEditingGestures();
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
    renameListedProject,
    removeListedProject,
    reconnectProject,
    keepRecovery,
    dismissRecovery,
  } = useDocuments();

  if (isComponentGalleryRoute()) {
    return <ComponentGallery />;
  }

  if (route === "home") {
    return (
      <Homepage
        projects={listedProjects}
        templates={templates.map((t) => ({ id: t.id, name: t.name }))}
        needsReconnect={needsReconnect}
        recoveryAvailable={recoveryAvailable}
        onCreateEmpty={createEmptyProject}
        onCreateFromTemplate={createFromTemplate}
        onOpenExternal={openProject}
        onOpenProject={openListedProject}
        onRenameProject={renameListedProject}
        onRemoveFromList={removeListedProject}
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
    <TooltipProvider>
      <EditorThemeProvider>
        <DocumentProvider>
          <PlayProvider>
            <ValidationProvider>
              <ProjectSearchProvider>
                <AppRoutes />
              </ProjectSearchProvider>
            </ValidationProvider>
          </PlayProvider>
        </DocumentProvider>
      </EditorThemeProvider>
    </TooltipProvider>
  );
}
