import { useCallback, useEffect, useMemo, useState, type RefObject } from "react";
import { DEFAULT_SOURCE_CONTROL_PROJECT_SETTINGS, type ProjectDocument } from "@haptic/core";
import {
  createNativeHttp,
  createSecretStore,
  getHostPlatform,
  isTestModeEnabled,
  type createAppSettingsStore,
} from "@haptic/vfs";
import { editorQuiet, subscribeEditorQuiet } from "../lib/editor-quiet";
import { attachLifecyclePause } from "../services/lifecycle-pause";
import type { ProjectService } from "../services/project-service";
import {
  readGitPrefill,
  type SourceControlService,
} from "../services/source-control-service";
import type { DocumentActions, SourceControlState } from "./document-context-types";

export interface SourceControlSyncDeps {
  sourceControlRef: RefObject<SourceControlService>;
  projectService: ProjectService;
  settingsStore: ReturnType<typeof createAppSettingsStore>;
  projectDocument: ProjectDocument | null;
  /** The external-change rescan; coming back to the app runs it once lock polling resumes. */
  runForegroundRescanRef: RefObject<() => Promise<void>>;
}

/**
 * Keeps `SourceControlService` configured for the open project, mirrors
 * whether source control is on into ProjectService and Homepage recents, and
 * pauses lock polling while the app is hidden or a game covers the editor.
 */
export function useSourceControlSync({
  sourceControlRef,
  projectService,
  settingsStore,
  projectDocument,
  runForegroundRescanRef,
}: SourceControlSyncDeps) {
  const secretStore = useMemo(() => createSecretStore(), []);
  const nativeHttp = useMemo(() => createNativeHttp(), []);
  const [sourceControlTick, setSourceControlTick] = useState(0);

  useEffect(() => {
    return sourceControlRef.current.subscribe(() => {
      setSourceControlTick((tick) => tick + 1);
    });
  }, [sourceControlRef]);

  useEffect(() => {
    if (!projectDocument) {
      sourceControlRef.current.dispose();
      return;
    }
    void sourceControlRef.current.configure({
      settings:
        projectDocument.settings.sourceControl ??
        DEFAULT_SOURCE_CONTROL_PROJECT_SETTINGS,
      projectGuid: projectService.guid,
      platform: getHostPlatform(),
      testMode: isTestModeEnabled(),
      secretStore,
      nativeHttp,
    });
  }, [
    nativeHttp,
    projectDocument,
    projectService.guid,
    secretStore,
    sourceControlRef,
  ]);

  const sourceControlEnabled = projectDocument
    ? projectDocument.settings.sourceControl?.enabled === true
    : null;
  // Not via the debounced project save: turning source control on must stop
  // the texture alignment pass's queued re-encodes at once.
  useEffect(() => {
    if (sourceControlEnabled !== null) projectService.setSourceControlEnabled(sourceControlEnabled);
  }, [projectService, sourceControlEnabled]);
  useEffect(() => {
    if (sourceControlEnabled === null) return;
    const folder = projectService.storagePort.getCurrentFolder();
    if (!folder) return;
    void settingsStore.update((settings) => {
      settings.recents = settings.recents.map((recent) =>
        recent.id === folder.id && recent.sourceControl !== sourceControlEnabled
          ? { ...recent, sourceControl: sourceControlEnabled }
          : recent,
      );
    });
  }, [projectService, settingsStore, sourceControlEnabled]);

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
