import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";
import type { ProjectDocument, SourceControlProjectSettings } from "@haptic/core";
import {
  getHostPlatform,
  isTestModeEnabled,
  type createAppSettingsStore,
} from "@haptic/vfs";
import { editorQuiet, subscribeEditorQuiet } from "../lib/editor-quiet";
import { attachLifecyclePause } from "@haptic/render/lifecycle-pause";
import { registryChangeLookup, type ChangeLookup } from "../lib/source-control-changes";
import type { DocumentService } from "../services/document-service";
import type { ProjectService } from "../services/project-service";
import {
  readGitPrefill,
  type SourceControlService,
} from "../services/source-control-service";
import type { SourceControlSyncService, SyncConfigureInput, SyncLocks } from "../services/source-control-sync";
import type { DocumentActions, SourceControlState } from "./document-context-types";

export interface SourceControlSyncDeps {
  sourceControlRef: RefObject<SourceControlService>;
  /** Integrated mode's Git sync. */
  sourceControlSync: SourceControlSyncService;
  projectService: ProjectService;
  documentService: DocumentService;
  settingsStore: ReturnType<typeof createAppSettingsStore>;
  projectDocument: ProjectDocument | null;
  /** Re-renders the document tabs after the Source Control tab appears or goes. */
  bump: () => void;
  /** The external-change rescan; coming back to the app runs it once lock polling resumes. */
  runForegroundRescanRef: RefObject<() => Promise<void>>;
}

/** The lock checks around an Integrated push: the push names the branch it sends. */
export function syncLocksFor(sourceControl: SourceControlService): SyncLocks {
  return {
    theirs: (paths, branch) => sourceControl.locksBlockingPush(paths, branch),
    releaseOwn: (paths) => sourceControl.releaseOwnLocks(paths),
  };
}

/**
 * Keeps the lock service's requests on the working copy's checked-out branch
 * (the sync snapshot's: `""` while it is not known, so lock changes wait;
 * null for a blocked folder, which Haptic runs no Git client in), from now
 * until the returned stop.
 */
export function followCheckedOutBranch(
  sync: Pick<SourceControlSyncService, "subscribe" | "getSnapshot">,
  sourceControl: Pick<SourceControlService, "setCheckedOutBranch">,
): () => void {
  const follow = () => {
    const { blocked, branch } = sync.getSnapshot();
    sourceControl.setCheckedOutBranch(blocked ? null : branch);
  };
  follow();
  return sync.subscribe(follow);
}

/** The registry as it is when a status runs: it remounts after a pull or rescan. */
function registryLookup(projectService: ProjectService): ChangeLookup {
  return (path) => registryChangeLookup(projectService.registry)(path);
}

/**
 * Keeps `SourceControlService` (locks) and, in Integrated mode,
 * `SourceControlSyncService` (Git) configured for the open project, mirrors
 * whether source control is on into ProjectService, Homepage recents and the
 * pinned Source Control tab, and pauses lock polling while the app is hidden
 * or a game covers the editor. Coming back to the app recomputes the Git
 * status and fetches.
 */
export function useSourceControlSync({
  sourceControlRef,
  sourceControlSync,
  projectService,
  documentService,
  settingsStore,
  projectDocument,
  bump,
  runForegroundRescanRef,
}: SourceControlSyncDeps) {
  const [sourceControlTick, setSourceControlTick] = useState(0);

  useEffect(() => {
    return sourceControlRef.current.subscribe(() => {
      setSourceControlTick((tick) => tick + 1);
    });
  }, [sourceControlRef]);

  const settings = projectDocument?.settings.sourceControl ?? null;
  useEffect(() => {
    if (!projectDocument) {
      sourceControlRef.current.dispose();
      return;
    }
    // Mode Off returns before loading credentials, HTTP or timers.
    void sourceControlRef.current.configure({
      settings: projectDocument.settings.sourceControl,
      projectKey: projectService.guid,
      platform: getHostPlatform(),
      testMode: isTestModeEnabled(),
      storage: projectService.storagePort,
      isPathDirty: (path) => documentService.getOpenDocumentsOrdered().some((doc) => doc.dirty && doc.ref.path === path),
    });
  }, [documentService, projectDocument, projectService, projectService.guid, settings, sourceControlRef]);

  // Integrated mode's Git client: keyed on the settings object, which keeps its
  // identity until a source control setting changes. Off and Manual load nothing.
  const syncInputFor = useCallback((next: SourceControlProjectSettings): SyncConfigureInput => ({
    settings: next,
    folder: projectService.storagePort.getCurrentFolder(),
    storage: projectService.storagePort,
    platform: getHostPlatform(),
    testMode: isTestModeEnabled(),
    lookup: registryLookup(projectService),
    locks: syncLocksFor(sourceControlRef.current),
    exclusiveWrites: (reason, work, signal) => projectService.withExclusiveWrites(reason, work, signal),
    backgroundWritesIdle: (signal) => projectService.textureEncodesIdle(signal),
  }), [projectService, sourceControlRef]);
  // Integrated mode's lock requests name the branch checked out in the working copy.
  useEffect(() => followCheckedOutBranch(sourceControlSync, sourceControlRef.current), [sourceControlRef, sourceControlSync]);
  const projectOpen = projectDocument !== null;
  useEffect(() => {
    if (!projectOpen || !settings) {
      sourceControlSync.dispose();
      return;
    }
    void sourceControlSync.configure(syncInputFor(settings));
  }, [projectOpen, projectService.guid, settings, sourceControlSync, syncInputFor]);
  useEffect(() => () => sourceControlSync.dispose(), [sourceControlSync]);

  // The pinned tab follows the service, which is active only on a host with source control.
  const tabShown = projectDocument !== null && sourceControlRef.current.active;
  const integrated = settings?.mode === "integrated";
  useEffect(() => {
    if (documentService.setSourceControlTab(tabShown, integrated)) bump();
  }, [bump, documentService, integrated, tabShown]);

  const sourceControlActive = settings ? settings.mode !== "off" : null;
  // Not via the debounced project save: turning source control on must stop
  // the texture alignment pass's queued re-encodes at once.
  useEffect(() => {
    if (sourceControlActive !== null) projectService.setSourceControlEnabled(sourceControlActive);
  }, [projectService, sourceControlActive]);
  useEffect(() => {
    if (sourceControlActive === null) return;
    const folder = projectService.storagePort.getCurrentFolder();
    if (!folder) return;
    void settingsStore.update((settings) => {
      settings.recents = settings.recents.map((recent) =>
        recent.id === folder.id && recent.sourceControl !== sourceControlActive
          ? { ...recent, sourceControl: sourceControlActive }
          : recent,
      );
    });
  }, [projectService, settingsStore, sourceControlActive]);

  // Lock polling and the foreground rescan wait while the app is hidden or a game covers the editor.
  useEffect(() => {
    let hidden = false;
    let rescanPending = false;
    const apply = () => {
      if (hidden || editorQuiet()) {
        sourceControlRef.current.pausePolling();
        return;
      }
      sourceControlRef.current.resumePolling();
      if (!rescanPending) return;
      rescanPending = false;
      void runForegroundRescanRef.current();
      // Integrated: what changed while away, here and on the remote.
      void sourceControlSync.refresh();
    };
    const detachQuiet = subscribeEditorQuiet(apply);
    const detachLifecycle = attachLifecyclePause((paused) => {
      hidden = paused;
      // A status due while hidden waits; the foreground refresh below reads it anyway.
      sourceControlSync.setHidden(paused);
      // Coming back to the app rescans the project, once the editor is back too.
      if (!paused) rescanPending = true;
      apply();
    });
    return () => {
      detachQuiet();
      detachLifecycle();
    };
  }, [runForegroundRescanRef, sourceControlRef, sourceControlSync]);

  const prefillSourceControlFromGit = useCallback(async () => {
    return readGitPrefill(projectService.storagePort);
  }, [projectService]);

  const readSourceControlFolder = useCallback(async () => {
    const storage = projectService.storagePort;
    const tier = storage.getCurrentFolder()?.tier ?? null;
    return { tier, hasGit: tier !== null && (await storage.exists(".git/HEAD").catch(() => false)) };
  }, [projectService]);

  const sourceControlState = useMemo<SourceControlState>(() => {
    void sourceControlTick;
    return { sourceControl: sourceControlRef.current };
  }, [sourceControlTick, sourceControlRef]);

  const actions = useMemo(
    (): Pick<DocumentActions, "prefillSourceControlFromGit" | "readSourceControlFolder"> => ({
      prefillSourceControlFromGit,
      readSourceControlFolder,
    }),
    [prefillSourceControlFromGit, readSourceControlFolder],
  );

  return { sourceControlState, syncInputFor, actions };
}
