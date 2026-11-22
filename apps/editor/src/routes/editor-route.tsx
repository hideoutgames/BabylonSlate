import { lazy, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { isChromeDocumentId } from "@haptic/core";
import { Button } from "@haptic/ui/components/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@haptic/ui/components/alert-dialog";
import { EditorChromeBar } from "../components/editor-chrome-bar";
import { EditorStatusBar } from "../components/editor-status-bar";
import { DocumentWorkspace } from "../components/document-workspace";
import { ExternalChangeDialogs } from "../components/external-change-dialogs";
import { SaveFailedDialog } from "../components/save-failed-dialog";
import { SourceControlActionsProvider } from "../components/source-control-actions";
import {
  useDocumentActions,
  useActiveDocumentId,
  useOpenDocumentTabs,
  useEditorShellState,
  useSaveState,
} from "../context/document-context";
import { AssetOpenDocumentsProvider } from "../context/asset-open-provider";
import { AssetThumbnailDocumentsProvider } from "../context/asset-thumbnail-provider";
import { AssetCreateDocumentsProvider } from "../context/asset-create-provider";
import { TagDocumentsProvider } from "../context/tag-documents-provider";
import { GraphPinDefaultsProvider } from "../context/graph-pin-defaults-provider";
import { BreakpointsProvider } from "../context/breakpoints-context";
import { WatchesProvider } from "../context/watches-context";
import { EditorSessionStateProvider } from "../context/editor-session-state-context";
import { PlayProvider, usePlay } from "../context/play-context";
import { KeybindProvider } from "../context/keybind-context";
import { ProjectSearchProvider } from "../context/project-search-context";
import { ValidationProvider } from "../context/validation-context";
import { MaterialRenderControlProvider } from "../context/material-render-control-context";
import { EditorUtilityRuntime } from "../components/editor-utility-runtime";
import { EditorExtensionsRuntime } from "../components/editor-extensions-runtime";
import { ExtensionCommandHost } from "../components/extension-commands";
import { ModelThumbnailCaptureHost } from "../components/model-thumbnail-capture-host";
import { TestAudioHostStats } from "../lib/test-audio-host-stats";
import { TestParticleHostStats } from "../lib/test-particle-host-stats";
import { profileRegion } from "../lib/render-profile";
import { useRetainedValue } from "../lib/use-retained-value";
import {
  shouldPromptBeforeUnload,
  tabCloseDecision,
} from "../lib/dirty-document-prompts";

// Test builds only (`?gallery` needs test mode), so production editor builds
// never load the gallery's chunk; the app route's Suspense covers the load.
const ComponentGallery = lazy(() =>
  import("../components/component-gallery").then((module) => ({ default: module.ComponentGallery })),
);

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

type CloseError = { title: string; message: string };

function CloseErrorDialog({
  error,
  onDismiss,
}: {
  error: CloseError | null;
  onDismiss: () => void;
}) {
  // Kept while the dialog fades out.
  const shown = useRetainedValue<CloseError | null>(error, null);
  return (
    <AlertDialog
      open={error !== null}
      onOpenChange={(next) => {
        if (!next) onDismiss();
      }}
    >
      <AlertDialogContent data-testid="close-error-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>{shown?.title}</AlertDialogTitle>
          <AlertDialogDescription>{shown?.message}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogAction data-testid="close-error-ok" onClick={onDismiss}>
            OK
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const projectCloseError = (message: string): CloseError => ({ title: "Could Not Close Project", message });

const SESSION_KEPT_PROJECT_OPEN =
  "The running Play or Simulate session did not stop, so the project stays open.";

/**
 * The recovery choice, asked before editing starts: a modal, so no edit or
 * save lands on a document before its unsaved edits from the last session are
 * recovered or discarded (recovered edits replay onto the saved files). When
 * Recover still finds documents changed since the project opened (an
 * open-time update, or a save), it asks before replacing them; and it says so
 * when the last session's records could not be read.
 */
function RecoveryDialog() {
  const { keepRecovery, dismissRecovery, dismissRecoveryNotice } = useDocumentActions();
  const { recoveryAvailable, recoveryNotice } = useEditorShellState();
  const [discarding, setDiscarding] = useState(false);
  if (recoveryNotice?.kind === "unreadable") {
    return (
      <AlertDialog open>
        <AlertDialogContent data-testid="recovery-unreadable">
          <AlertDialogHeader>
            <AlertDialogTitle>Unsaved Edits Could Not Be Read</AlertDialogTitle>
            <AlertDialogDescription>
              The last session closed before saving, and the edits it recorded could not be read, so they were discarded. Your saved files are unchanged.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction data-testid="recovery-unreadable-ok" onClick={dismissRecoveryNotice}>OK</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }
  if (!recoveryAvailable) return null;
  if (recoveryNotice?.kind === "changed") {
    return (
      <AlertDialog open>
        <AlertDialogContent data-testid="recovery-changed">
          <AlertDialogHeader>
            <AlertDialogTitle>Replace Changes Since Opening?</AlertDialogTitle>
            <AlertDialogDescription>
              These documents changed after the project opened. Recovering replaces their unsaved changes with the recovered edits; a document saved since then can't be recovered, and its edits from the last session are discarded.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="max-h-48 divide-y overflow-y-auto overscroll-y-contain rounded-md border bg-muted/30 text-sm" data-testid="recovery-changed-documents">
            {recoveryNotice.documents.map((label) => (
              <li key={label} className="truncate px-3 py-1.5">{label}</li>
            ))}
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="recovery-cancel" onClick={dismissRecoveryNotice}>Cancel</AlertDialogCancel>
            <AlertDialogAction data-testid="recovery-replace-changed" onClick={() => keepRecovery({ replaceChanged: true })}>
              Recover Edits
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }
  return (
    <AlertDialog open>
      <AlertDialogContent data-testid="recovery-prompt">
        <AlertDialogHeader>
          <AlertDialogTitle>Recover Unsaved Edits?</AlertDialogTitle>
          <AlertDialogDescription>The last session closed before these edits were saved.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button
            variant="secondary"
            data-testid="dismiss-journal"
            disabled={discarding}
            onClick={() => {
              setDiscarding(true);
              // A failed clear keeps the journal, so the prompt stays for a retry.
              dismissRecovery()
                .catch((error: unknown) => console.error("[editor] could not discard the recovery journal", error))
                .finally(() => setDiscarding(false));
            }}
          >
            Discard
          </Button>
          <Button data-testid="recover-journal" disabled={discarding} onClick={() => keepRecovery()}>
            Recover Edits
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * The chrome bar and the prompts its requests open: unsaved documents and
 * external changes. It subscribes to the dirty lists
 * those prompts show, so EditorLayout and the workspace beside it do not
 * re-render on every edit. Request handlers read open documents when they run.
 */
function EditorChromeAndPrompts() {
  const { dirtyDocuments, projectDirty } = useSaveState();
  const { pendingExclusiveScene, externalChangePrompt } = useEditorShellState();
  const {
    setAutoSavePaused,
    closeProject,
    releaseSessionsForProjectClose,
    forceCloseProject,
    saveAll,
    confirmExclusiveSceneOpen,
    cancelExclusiveSceneOpen,
    openDocument,
    closeDocument,
    getOpenDocuments,
    confirmExternalChangeReloadProject,
    confirmExternalChangeReloadDocs,
    dismissExternalChange,
  } = useDocumentActions();
  /** Close Project found unsaved work; the prompt lists it live. */
  const [projectClosePrompt, setProjectClosePrompt] = useState(false);
  const closeRequest = useRef(0);
  const [closeError, setCloseError] = useState<CloseError | null>(null);
  const [savingBeforeClose, setSavingBeforeClose] = useState(false);
  /** The tabs a close request will close, listed by whichever of them are unsaved. */
  const [pendingTabClose, setPendingTabClose] = useState<string[] | null>(null);


  /** A failed close keeps the project open; Close Project can be asked again. */
  const reportCloseFailure = (error: unknown) => {
    console.error("[editor] Close Project failed", error);
    setProjectClosePrompt(false);
    setCloseError(projectCloseError(errorMessage(error)));
  };

  const requestClose = async () => {
    const result = await closeProject();
    if (result.outcome === "unsaved") {
      setProjectClosePrompt(true);
      return;
    }
    setProjectClosePrompt(false);
    if (result.outcome === "refused") setCloseError(projectCloseError(SESSION_KEPT_PROJECT_OPEN));
  };

  /**
   * An authoring lock (a Simulation, or Play stopped in the editor) refuses to
   * close unsaved documents and Scenes; the other tabs still close.
   */
  const closeTabs = (ids: readonly string[]) => {
    let refusal: string | null = null;
    for (const id of ids) {
      try {
        closeDocument(id);
      } catch (error) {
        console.error("[editor] document close was refused", error);
        refusal ??= errorMessage(error);
      }
    }
    if (refusal !== null) setCloseError({ title: "Could Not Close Documents", message: refusal });
  };

  const exclusiveDirtyNames = pendingExclusiveScene
    ? dirtyDocuments
        .filter((doc) => doc.ref.kind === "scene")
        .map((doc) => doc.ref.label)
    : [];
  // Listed from the live dirty state, so a save that lands while the prompt is
  // open (an auto-save already running) shortens the list instead of leaving
  // names that Discard no longer discards.
  const promptNames = pendingTabClose
    ? dirtyDocuments.filter((doc) => pendingTabClose.includes(doc.id)).map((doc) => doc.ref.label)
    : projectClosePrompt
      ? [
          ...dirtyDocuments.map((doc) => doc.ref.label),
          ...(projectDirty ? ["Project Settings"] : []),
        ]
      : exclusiveDirtyNames;

  const requestCloseDocument = (id: string) => {
    closeRequest.current += 1;
    const doc = getOpenDocuments().find((entry) => entry.id === id);
    if (!doc) return;
    if (tabCloseDecision(doc.dirty) === "prompt") {
      setPendingTabClose([doc.id]);
      return;
    }
    closeTabs([id]);
  };

  const requestCloseAllDocuments = () => {
    closeRequest.current += 1;
    const tabs = getOpenDocuments().filter((doc) => !isChromeDocumentId(doc.id));
    if (tabs.some((doc) => doc.dirty)) {
      setPendingTabClose(tabs.map((doc) => doc.id));
      return;
    }
    closeTabs(tabs.map((doc) => doc.id));
  };

  const closePromptOpen =
    projectClosePrompt ||
    pendingExclusiveScene !== null ||
    pendingTabClose !== null;

  // An auto-save under the prompt would save what Discard is about to drop.
  // Cancel resumes it with a new interval; closing the project ends it anyway.
  useEffect(() => {
    setAutoSavePaused(closePromptOpen);
    return () => setAutoSavePaused(false);
  }, [closePromptOpen, setAutoSavePaused]);

  // Everything listed was saved anyway (an auto-save that began before the
  // prompt opened): close, or open the Scene, as if nothing had been unsaved.
  const nothingListed = promptNames.length === 0;
  useEffect(() => {
    if (!nothingListed || savingBeforeClose) return;
    if (pendingTabClose) {
      const tabs = getOpenDocuments().filter((doc) => pendingTabClose.includes(doc.id));
      if (tabs.some((doc) => doc.dirty)) return;
      setPendingTabClose(null);
      closeTabs(tabs.map((doc) => doc.id));
    } else if (projectClosePrompt) {
      setProjectClosePrompt(false);
      void requestClose().catch(reportCloseFailure);
    } else if (pendingExclusiveScene) {
      // The normal open, not Discard: a Scene the replace gate's stop leaves
      // dirty asks again instead of being dropped.
      const ref = pendingExclusiveScene;
      cancelExclusiveSceneOpen();
      void openDocument(ref).catch((error: unknown) => console.error("[editor] could not open the Scene", error));
    }
    // The handlers only read refs and live state, so they need not retrigger it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nothingListed, savingBeforeClose, pendingTabClose, projectClosePrompt, pendingExclusiveScene]);

  const saveBeforeClose = () => {
    const request = ++closeRequest.current;
    setSavingBeforeClose(true);
    void (async () => {
      try {
        if (pendingExclusiveScene && !pendingTabClose) {
          await confirmExclusiveSceneOpen("save");
          return;
        }
        // A running session's authoring lock refuses Save All, so it stops
        // only now that the user chose to save, not when the prompt opened.
        if (projectClosePrompt && !await releaseSessionsForProjectClose()) {
          if (request !== closeRequest.current) return;
          setProjectClosePrompt(false);
          setCloseError(projectCloseError(SESSION_KEPT_PROJECT_OPEN));
          return;
        }
        if (request !== closeRequest.current) return;
        const outcome = await saveAll();
        if (request !== closeRequest.current) return;
        // Documents someone else has locked stay listed here under Save Failed:
        // Discard Changes there lets the close finish.
        if (outcome !== "saved") return;
        if (pendingTabClose) {
          const tabs = getOpenDocuments().filter((doc) => pendingTabClose.includes(doc.id));
          // A successful write can leave newer edits dirty. Keep the
          // request open until those edits are saved or discarded.
          if (tabs.some((doc) => doc.dirty)) {
            setPendingTabClose(tabs.map((doc) => doc.id));
            return;
          }
          setPendingTabClose(null);
          closeTabs(tabs.map((doc) => doc.id));
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
          onSaveProject={() => saveAll()}
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
          setSavingBeforeClose(false);
          setProjectClosePrompt(false);
          setPendingTabClose(null);
          cancelExclusiveSceneOpen();
        }}
        onDiscard={() => {
          closeRequest.current += 1;
          if (pendingTabClose) {
            setPendingTabClose(null);
            closeTabs(pendingTabClose);
            return;
          }
          if (pendingExclusiveScene) {
            void confirmExclusiveSceneOpen("discard");
            return;
          }
          setProjectClosePrompt(false);
          void forceCloseProject().then((closed) => {
            if (!closed) setCloseError(projectCloseError(SESSION_KEPT_PROJECT_OPEN));
          }, reportCloseFailure);
        }}
        onSave={saveBeforeClose}
      />
      <CloseErrorDialog error={closeError} onDismiss={() => setCloseError(null)} />
      <SaveFailedDialog />
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
      <SourceControlActionsProvider>
        <EditorChromeAndPrompts />
        <RecoveryDialog />
        <main className="flex min-h-0 flex-1 flex-col">
          {profileRegion("document-workspace", <DocumentWorkspace />)}
        </main>
        {profileRegion("editor-status-bar", <EditorStatusBar />)}
      </SourceControlActionsProvider>
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
  // Each open document keeps its Compiler Results; a closed one's are dropped.
  const openDocuments = useOpenDocumentTabs();
  const openDocumentIds = useMemo(() => openDocuments.map((doc) => doc.id), [openDocuments]);
  return (
    <ValidationProvider scopeKey={activeDocumentId ?? undefined} retainScopeKeys={openDocumentIds}>
      {children}
    </ValidationProvider>
  );
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
        <AssetThumbnailDocumentsProvider>
          <AssetCreateDocumentsProvider>
            <TagDocumentsProvider>
              <GraphPinDefaultsProvider>
                <DocumentValidationProvider>
                  <BreakpointsProvider>
                    <WatchesProvider>
                      <PlayProvider>
                        <MaterialRenderControlProvider>
                          <EditorUtilityRuntime />
                          <EditorExtensionsRuntime />
                          <TestAudioHostStats />
                          <TestParticleHostStats />
                          <ModelThumbnailCaptureHost />
                          <ProjectSearchProvider>
                            <ExtensionCommandHost>
                              <PlayAwareKeybinds>
                                {gallery
                                  ? <ComponentGallery />
                                  : profileRegion("editor-layout", <EditorLayout />)}
                              </PlayAwareKeybinds>
                            </ExtensionCommandHost>
                          </ProjectSearchProvider>
                        </MaterialRenderControlProvider>
                      </PlayProvider>
                    </WatchesProvider>
                  </BreakpointsProvider>
                </DocumentValidationProvider>
              </GraphPinDefaultsProvider>
            </TagDocumentsProvider>
          </AssetCreateDocumentsProvider>
        </AssetThumbnailDocumentsProvider>
      </AssetOpenDocumentsProvider>
    </EditorSessionStateProvider>,
  );
}
