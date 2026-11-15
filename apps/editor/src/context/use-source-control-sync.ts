import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";
import type { ProjectDocument } from "@haptic/core";
import {
  getHostPlatform,
  isTestModeEnabled,
  type createAppSettingsStore,
} from "@haptic/vfs";
import { editorQuiet, subscribeEditorQuiet } from "../lib/editor-quiet";
import { attachLifecyclePause } from "@haptic/render/lifecycle-pause";
import type { DocumentService } from "../services/document-service";
import type { ProjectService } from "../services/project-service";
import {
  readGitPrefill,
  type SourceControlService,
} from "../services/source-control-service";
import type { DocumentActions, SourceControlState } from "./document-context-types";

export interface SourceControlSyncDeps {
  sourceControlRef: RefObject<SourceControlService>;
  projectService: ProjectService;
  documentService: DocumentService;
  settingsStore: ReturnType<typeof createAppSettingsStore>;
  projectDocument: ProjectDocument | null;
  /** Re-renders the document tabs after the Source Control tab appears or goes. */
  bump: () => void;
  /** The external-change rescan; coming back to the app runs it once lock polling resumes. */
  runForegroundRescanRef: RefObject<() => Promise<void>>;
}

/**
 * Keeps `SourceControlService` configured for the open project, mirrors
 * whether source control is on into ProjectService, Homepage recents and the
 * pinned Source Control tab, and pauses lock polling while the app is hidden
 * or a game covers the editor.
 */
export function useSourceControlSync({
  sourceControlRef,
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

  // The pinned tab follows the service, which is active only on a host with source control.
  const tabShown = projectDocument !== null && sourceControlRef.current.active;
  useEffect(() => {
    if (documentService.setSourceControlTab(tabShown)) bump();
  }, [bump, documentService, tabShown]);

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
    };
    const detachQuiet = subscribeEditorQuiet(apply);
    const detachLifecycle = attachLifecyclePause((paused) => {
      hidden = paused;
      // Coming back to the app rescans the project, once the editor is back too.
      if (!paused) rescanPending = true;
      apply();
    });
    return () => {
      detachQuiet();
      detachLifecycle();
    };
  }, [runForegroundRescanRef, sourceControlRef]);

  const prefillSourceControlFromGit = useCallback(async () => {
    return readGitPrefill(projectService.storagePort);
  }, [projectService]);

  const sourceControlState = useMemo<SourceControlState>(() => {
    void sourceControlTick;
    return { sourceControl: sourceControlRef.current };
  }, [sourceControlTick, sourceControlRef]);

  const actions = useMemo(
    (): Pick<DocumentActions, "prefillSourceControlFromGit"> => ({
      prefillSourceControlFromGit,
    }),
    [prefillSourceControlFromGit],
  );

  return { sourceControlState, actions };
}
