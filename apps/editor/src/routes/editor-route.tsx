import { useEffect, useRef, useState, type ReactNode } from "react";
import { CONTENT_BROWSER_ID } from "@babylonslate/core";
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
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@babylonslate/ui/components/alert";
import { ComponentGallery } from "../components/component-gallery";
import { EditorChromeBar } from "../components/editor-chrome-bar";
import { EditorStatusBar } from "../components/editor-status-bar";
import { DocumentWorkspace } from "../components/document-workspace";
import { ExternalChangeDialogs } from "../components/external-change-dialogs";
import {
  useDocumentActions,
  useActiveDocumentId,
  useEditorShellState,
  useSaveState,
} from "../context/document-context";
import { AssetOpenDocumentsProvider } from "../context/asset-open-provider";
import { AssetCreateDocumentsProvider } from "../context/asset-create-provider";
import { TagDocumentsProvider } from "../context/tag-documents-provider";
import { GraphPinDefaultsProvider } from "../context/graph-pin-defaults-provider";
import { EditorSessionStateProvider } from "../context/editor-session-state-context";
import { PlayProvider, usePlay } from "../context/play-context";
import { KeybindProvider } from "../context/keybind-context";
import { ProjectSearchProvider } from "../context/project-search-context";
import { ValidationProvider } from "../context/validation-context";
import { MaterialRenderControlProvider } from "../context/material-render-control-context";
import { EditorUtilityRuntime } from "../components/editor-utility-runtime";
import { EditorExtensionsRuntime } from "../components/editor-extensions-runtime";
import { ModelThumbnailCaptureHost } from "../components/model-thumbnail-capture-host";
import { TestAudioHostStats } from "../lib/test-audio-host-stats";
import { TestParticleHostStats } from "../lib/test-particle-host-stats";
import { profileRegion } from "../lib/render-profile";
import {
  shouldPromptBeforeUnload,
  tabCloseDecision,
} from "../lib/dirty-document-prompts";

function PromptList({ items }: { items: string[] }) {
  return (
    <ul className="max-h-48 divide-y overflow-y-auto overscroll-y-contain rounded-md border bg-muted/30 text-sm">
      {items.map((item) => (
        <li key={item} className="min-w-0 truncate px-3 py-1.5" title={item}>
          {item}
        </li>
      ))}
    </ul>
  );
}

function DirtyCloseDialog({
  dirtyNames,
  open,
  onSave,
  onDiscard,
  onCancel,
  saving,
}: {
  dirtyNames: string[];
  open: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
  saving: boolean;
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
          <AlertDialogTitle>Unsaved Documents</AlertDialogTitle>
          <AlertDialogDescription>
            Save changes to these documents before closing?
          </AlertDialogDescription>
        </AlertDialogHeader>
        <PromptList items={dirtyNames} />
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="dirty-cancel">
            Cancel
          </AlertDialogCancel>
          <Button
            variant="secondary"
            data-testid="dirty-discard"
            onClick={onDiscard}
            disabled={saving}
          >
            Discard
          </Button>
          <AlertDialogAction data-testid="dirty-save" onClick={onSave} disabled={saving}>
            {saving ? "Saving…" : "Save All"}
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
          <AlertDialogTitle>Schema Migration Required</AlertDialogTitle>
          <AlertDialogDescription>
            Some assets were made with an older schema. Migrate them on save?
            Files you do not save stay untouched.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <PromptList items={paths} />
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="migrate-cancel">
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction data-testid="migrate-approve" onClick={onApprove}>
            Migrate On Save
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function CloseProjectErrorDialog({
  message,
  onDismiss,
}: {
  message: string | null;
  onDismiss: () => void;
}) {
  return (
    <AlertDialog
      open={message !== null}
      onOpenChange={(next) => {
        if (!next) onDismiss();
      }}
    >
      <AlertDialogContent data-testid="close-project-error-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Could Not Close Project</AlertDialogTitle>
          <AlertDialogDescription>{message}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction data-testid="close-project-error-ok" onClick={onDismiss}>
            OK
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

const SESSION_KEPT_PROJECT_OPEN =
  "The running Play or Simulate session did not stop, so the project stays open.";

function RecoveryBanner() {
  const { keepRecovery, dismissRecovery } = useDocumentActions();
  const { recoveryAvailable } = useEditorShellState();
  if (!recoveryAvailable) return null;
  return (
    <Alert
      className="rounded-none border-x-0 border-t-0"
      data-testid="recovery-prompt"
    >
      <AlertTitle>Recovery journal found</AlertTitle>
      <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
        <span>Replay unsaved document edits, or discard the journal.</span>
        <div className="flex gap-2">
          <Button
            data-testid="recover-journal"
            onClick={() => void keepRecovery()}
          >
            Recover edits
          </Button>
          <Button
            variant="outline"
            data-testid="dismiss-journal"
            onClick={() => {
              // A failed clear keeps the journal, so the banner stays for a retry.
              dismissRecovery().catch((error: unknown) => console.error("[editor] could not discard the recovery journal", error));
            }}
          >
            Discard journal
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

/**
 * The chrome bar and the prompts its requests open: unsaved documents,
 * migrate-on-save and external changes. It subscribes to the dirty lists
 * those prompts show, so EditorLayout and the workspace beside it do not
 * re-render on every edit. Request handlers read open documents when they run.
 */
function EditorChromeAndPrompts() {
  const { dirtyDocuments } = useSaveState();
  const { migrationPending, migrationPromptRequest, pendingExclusiveScene, externalChangePrompt } = useEditorShellState();
  const {
    closeProject,
    releaseSessionsForProjectClose,
    forceCloseProject,
    saveAll,
    confirmExclusiveSceneOpen,
    cancelExclusiveSceneOpen,
    approveMigrationsAndSave,
    closeDocument,
    getOpenDocuments,
    confirmExternalChangeReloadProject,
    confirmExternalChangeReloadDocs,
    dismissExternalChange,
  } = useDocumentActions();
  const {
    playAwaitingMigration,
    resumePlayAfterMigration,
    cancelPlayMigration,
  } = usePlay();
  const [dirtyPrompt, setDirtyPrompt] = useState<string[] | null>(null);
  const closeRequest = useRef(0);
  /** The close request whose Save All pending migrations refused; Migrate On Save resumes it. */
  const closeAwaitingMigration = useRef<number | null>(null);
  const [closeError, setCloseError] = useState<string | null>(null);
  const [savingBeforeClose, setSavingBeforeClose] = useState(false);
  const [showMigrate, setShowMigrate] = useState(false);
  const [pendingTabClose, setPendingTabClose] = useState<
    | {
        id: string;
        name: string;
        dirty: boolean;
      }[]
    | null
  >(null);

  useEffect(() => {
    if (playAwaitingMigration) setShowMigrate(true);
  }, [playAwaitingMigration]);
  // Save All, the close prompt's Save All and the exclusive Scene's Save all
  // reach the migration prompt when pending migrations refuse their save.
  useEffect(() => {
    if (migrationPromptRequest > 0) setShowMigrate(true);
  }, [migrationPromptRequest]);

  /** A failed close keeps the project open; Close Project can be asked again. */
  const reportCloseFailure = (error: unknown) => {
    console.error("[editor] Close Project failed", error);
    setDirtyPrompt(null);
    setCloseError(error instanceof Error ? error.message : String(error));
  };

  const requestClose = async () => {
    const result = await closeProject();
    if (result.outcome === "unsaved") {
      setDirtyPrompt([
        ...result.dirty.map((d) => d.ref.label),
        ...(result.projectDirty ? ["Project Settings"] : []),
      ]);
      return;
    }
    setDirtyPrompt(null);
    if (result.outcome === "refused") setCloseError(SESSION_KEPT_PROJECT_OPEN);
  };

  const exclusiveDirtyNames = pendingExclusiveScene
    ? dirtyDocuments
        .filter((doc) => doc.ref.kind === "scene")
        .map((doc) => doc.ref.label)
    : [];
  const promptNames = pendingTabClose
    ? pendingTabClose.filter((doc) => doc.dirty).map((doc) => doc.name)
    : (dirtyPrompt ?? exclusiveDirtyNames);

  const requestCloseDocument = (id: string) => {
    closeRequest.current += 1;
    const doc = getOpenDocuments().find((entry) => entry.id === id);
    if (!doc) return;
    if (tabCloseDecision(doc.dirty) === "prompt") {
      setPendingTabClose([
        { id: doc.id, name: doc.ref.label, dirty: doc.dirty },
      ]);
      return;
    }
    closeDocument(id);
  };

  const requestCloseAllDocuments = () => {
    closeRequest.current += 1;
    const tabs = getOpenDocuments().filter((doc) => doc.id !== CONTENT_BROWSER_ID);
    if (tabs.some((doc) => doc.dirty)) {
      setPendingTabClose(
        tabs.map((doc) => ({
          id: doc.id,
          name: doc.ref.label,
          dirty: doc.dirty,
        })),
      );
      return;
    }
    for (const doc of tabs) closeDocument(doc.id);
  };

  const closePromptOpen =
    dirtyPrompt !== null ||
    pendingExclusiveScene !== null ||
    pendingTabClose !== null;

  const saveBeforeClose = () => {
    const request = ++closeRequest.current;
    closeAwaitingMigration.current = null;
    setSavingBeforeClose(true);
    void (async () => {
      try {
        if (pendingExclusiveScene && !pendingTabClose) {
          // A Save All that migrations refuse leaves the Scene request pending.
          closeAwaitingMigration.current = request;
          await confirmExclusiveSceneOpen("save");
          return;
        }
        // A running session's authoring lock refuses Save All, so it stops
        // only now that the user chose to save, not when the prompt opened.
        if (dirtyPrompt !== null && !await releaseSessionsForProjectClose()) {
          if (request !== closeRequest.current) return;
          setDirtyPrompt(null);
          setCloseError(SESSION_KEPT_PROJECT_OPEN);
          return;
        }
        if (request !== closeRequest.current) return;
        const saved = await saveAll();
        if (request !== closeRequest.current) return;
        if (!saved) {
          // Pending migrations refused it and opened their prompt.
          closeAwaitingMigration.current = request;
          return;
        }
        if (pendingTabClose) {
          const tabs = getOpenDocuments().filter((doc) => pendingTabClose.some((tab) => tab.id === doc.id));
          // A successful write can leave newer edits dirty. Keep the
          // request open until those edits are saved or discarded.
          if (tabs.some((doc) => doc.dirty)) {
            setPendingTabClose(tabs.map((doc) => ({ id: doc.id, name: doc.ref.label, dirty: doc.dirty })));
            return;
          }
          setPendingTabClose(null);
          for (const doc of tabs) closeDocument(doc.id);
        } else await requestClose().catch(reportCloseFailure);
      } catch (error) {
        // The documents stay dirty and the prompt stays open to retry or discard.
        console.error("[editor] Save All before closing failed", error);
      } finally {
        if (request === closeRequest.current) setSavingBeforeClose(false);
      }
    })();
  };

  return (
    <>
      {profileRegion(
        "editor-chrome-bar",
        <EditorChromeBar
          onCloseProject={() => void requestClose().catch(reportCloseFailure)}
          onSaveProject={saveAll}
          onCloseDocument={requestCloseDocument}
          onCloseAllDocuments={requestCloseAllDocuments}
        />,
      )}
      <DirtyCloseDialog
        saving={savingBeforeClose}
        dirtyNames={promptNames}
        open={closePromptOpen}
        onCancel={() => {
          closeRequest.current += 1;
          closeAwaitingMigration.current = null;
          setSavingBeforeClose(false);
          setDirtyPrompt(null);
          setPendingTabClose(null);
          cancelExclusiveSceneOpen();
        }}
        onDiscard={() => {
          closeRequest.current += 1;
          closeAwaitingMigration.current = null;
          if (pendingTabClose) {
            for (const doc of pendingTabClose) closeDocument(doc.id);
            setPendingTabClose(null);
            return;
          }
          if (pendingExclusiveScene) {
            void confirmExclusiveSceneOpen("discard");
            return;
          }
          setDirtyPrompt(null);
          void forceCloseProject().then((closed) => {
            if (!closed) setCloseError(SESSION_KEPT_PROJECT_OPEN);
          }, reportCloseFailure);
        }}
        onSave={saveBeforeClose}
      />
      <CloseProjectErrorDialog message={closeError} onDismiss={() => setCloseError(null)} />
      <MigrationPrompt
        paths={migrationPending.map((p) => p.path)}
        open={showMigrate}
        onCancel={() => {
          closeAwaitingMigration.current = null;
          setShowMigrate(false);
          cancelPlayMigration();
        }}
        onApprove={() => {
          setShowMigrate(false);
          // The close prompt's Save All that the migrations refused continues
          // once they are approved and saved, unless that prompt has ended.
          const closeRequestToResume = closePromptOpen && closeAwaitingMigration.current === closeRequest.current
            ? closeRequest.current
            : null;
          closeAwaitingMigration.current = null;
          void (async () => {
            const saved = await approveMigrationsAndSave().catch((error: unknown) => {
              console.error("[editor] Migrate On Save failed", error);
              return false;
            });
            if (saved && closeRequestToResume !== null && closeRequestToResume === closeRequest.current) saveBeforeClose();
            if (!playAwaitingMigration) return;
            // Play continues only from a completed save; a refused or failed one ends the request.
            if (saved) await resumePlayAfterMigration();
            else cancelPlayMigration();
          })();
        }}
      />
      <ExternalChangeDialogs
        prompt={externalChangePrompt}
        onReloadProject={() => {
          void confirmExternalChangeReloadProject();
        }}
        onReloadDocs={(paths) => {
          void confirmExternalChangeReloadDocs(paths);
        }}
        onKeepEdits={dismissExternalChange}
        onDismiss={dismissExternalChange}
      />
    </>
  );
}

/** Browser leave protection and the dirty count while anything is unsaved. */
function UnsavedChangesGuard() {
  const { dirtyDocuments, projectDirty } = useSaveState();
  const unsaved = dirtyDocuments.length + Number(Boolean(projectDirty));

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!shouldPromptBeforeUnload(unsaved)) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [unsaved]);

  return (
    <span className="sr-only" data-testid="dirty-count">
      {unsaved}
    </span>
  );
}

/**
 * Subscribes to no document state: edits re-render only the children that
 * read documents themselves, not this frame or the workspace mount.
 */
function EditorLayout() {
  return (
    <div className="safe-frame flex h-full min-h-0 flex-col overflow-clip bg-background text-foreground">
      <EditorChromeAndPrompts />
      <RecoveryBanner />
      <main className="flex min-h-0 flex-1 flex-col">
        {profileRegion("document-workspace", <DocumentWorkspace />)}
      </main>
      {profileRegion("editor-status-bar", <EditorStatusBar />)}
      <UnsavedChangesGuard />
    </div>
  );
}

function PlayAwareKeybinds({ children }: { children: ReactNode }) {
  const { playing } = usePlay();
  return <KeybindProvider suspended={playing}>{children}</KeybindProvider>;
}

function DocumentValidationProvider({ children }: { children: ReactNode }) {
  const activeDocumentId = useActiveDocumentId();
  return <ValidationProvider scopeKey={activeDocumentId ?? undefined}>{children}</ValidationProvider>;
}

export default function EditorRoute({
  gallery = false,
}: {
  gallery?: boolean;
}) {
  // A stable action: document edits do not re-render this route.
  const { subscribeDocumentIdentity } = useDocumentActions();
  // Homepage is the only way into a project and closing one returns there,
  // so this route (and the session view state it owns) mounts once per project.
  return profileRegion(
    "editor-route",
    <EditorSessionStateProvider
      subscribeDocumentIdentity={subscribeDocumentIdentity}
    >
      <AssetOpenDocumentsProvider>
        <AssetCreateDocumentsProvider>
          <TagDocumentsProvider>
            <GraphPinDefaultsProvider>
              <DocumentValidationProvider>
                <PlayProvider>
                  <MaterialRenderControlProvider>
                    <EditorUtilityRuntime />
                    <EditorExtensionsRuntime />
                    <TestAudioHostStats />
                    <TestParticleHostStats />
                    <ModelThumbnailCaptureHost />
                    <ProjectSearchProvider>
                      <PlayAwareKeybinds>
                        {gallery
                          ? <ComponentGallery />
                          : profileRegion("editor-layout", <EditorLayout />)}
                      </PlayAwareKeybinds>
                    </ProjectSearchProvider>
                  </MaterialRenderControlProvider>
                </PlayProvider>
              </DocumentValidationProvider>
            </GraphPinDefaultsProvider>
          </TagDocumentsProvider>
        </AssetCreateDocumentsProvider>
      </AssetOpenDocumentsProvider>
    </EditorSessionStateProvider>,
  );
}
