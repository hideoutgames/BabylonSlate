import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { isErr } from "@haptic/core";
import {
  MISSING_STARTUP_SCENE_MESSAGE,
  isPreviewDiagnosticsMessage,
  isPreviewErrorMessage,
  isPreviewRequestPackMessage,
  previewPackFromFiles,
  PREVIEW_STOP_MESSAGE,
  PREVIEW_READY_MESSAGE,
  createPreviewSaveStorageHost,
  createPreviewAssetServer,
} from "@haptic/exporter";
import { shouldPackKtx2ForPreviewBuild } from "@haptic/render";
import type { SessionReportEntry } from "@haptic/runtime";
import { createSaveGameStorage } from "@haptic/vfs";
import type { PreviewPreparePhase } from "../components/preparing-preview-dialog";
import { playerPreviewSrc } from "../lib/player-host-url";
import { canSendPreviewPack, isExpectedPreviewMessage, previewTargetFromSrc } from "../lib/preview-build-handoff";
import {
  sessionEntriesFromPreviewDiagnostics,
  shouldClosePreviewOnDiagnostics,
} from "../lib/preview-diagnostics";
import { attachPreviewLifecycle } from "../lib/preview-lifecycle";
import { setEncodeQueuePauseReason } from "../services/encode-queue-pause";
import type { GameSessionOwner, GameSessionTicket } from "../services/game-session-owner";
import { loadPlayerDistFiles } from "../services/load-player-files";
import { resolvePreviewStartupGuid, type PlaySceneLoad } from "../services/play-physics";
import type { PlaySessionResult } from "../services/play-session";
import { prepareSaveGameConfiguration } from "../services/save-game-configuration";
import { dirtyDocumentLabels, type PlayRequestInputs, type PlayUnsavedPrompt } from "./play-context-hooks";

/**
 * The Play session state Preview Build shares with `PlayProvider`. Every
 * member is a ref, a state setter or a stable callback, except the three
 * values at the end, so the callbacks below keep their identity across renders.
 */
export interface PreviewBuildHost {
  sessionOwner: GameSessionOwner<PlaySessionResult>;
  sessionTicketRef: RefObject<GameSessionTicket | null>;
  sessionSourceDocumentRef: RefObject<string | null>;
  preparingRef: RefObject<boolean>;
  playRequestInputsRef: RefObject<PlayRequestInputs>;
  setPreparing: Dispatch<SetStateAction<boolean>>;
  setPlayOpen: Dispatch<SetStateAction<boolean>>;
  setSessionPlayScene: Dispatch<SetStateAction<PlaySceneLoad | null>>;
  setStartupAlertOpen: Dispatch<SetStateAction<boolean>>;
  setUnsavedPrompt: Dispatch<SetStateAction<PlayUnsavedPrompt | null>>;
  setPlayAwaitingMigration: Dispatch<SetStateAction<boolean>>;
  appendLog: (line: string) => void;
  /** Opens the session report with a closed Preview Build's diagnostics. */
  showPreviewReport: (entries: SessionReportEntry[]) => void;
  loadSaveGameDefinition: (guid: string) => Promise<unknown>;
  playFromScene: boolean;
  traceByteBudget: number | undefined;
  projectOpen: boolean;
  /** Releases the open Scene viewports' authoring Scenes until the session ends; false when it could not. */
  releaseSceneViewports: (ticket: GameSessionTicket) => Promise<boolean>;
}

/**
 * Preview Build: prepares the packed game, presents it in the player iframe
 * and hands it the files, then reports its diagnostics once it closes.
 */
export function usePreviewBuild({
  sessionOwner,
  sessionTicketRef,
  sessionSourceDocumentRef,
  preparingRef,
  playRequestInputsRef,
  setPreparing,
  setPlayOpen,
  setSessionPlayScene,
  setStartupAlertOpen,
  setUnsavedPrompt,
  setPlayAwaitingMigration,
  appendLog,
  showPreviewReport,
  loadSaveGameDefinition,
  playFromScene,
  traceByteBudget,
  projectOpen,
  releaseSceneViewports,
}: PreviewBuildHost) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const initialPreviewTarget = useMemo(
    () => previewTargetFromSrc(playerPreviewSrc(0), window.location.href),
    [],
  );
  const [previewSrc, setPreviewSrc] = useState(initialPreviewTarget.src);
  const previewOriginRef = useRef(initialPreviewTarget.origin);
  const [previewPhase, setPreviewPhase] = useState<PreviewPreparePhase | null>(
    null,
  );
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewPreparationError, setPreviewPreparationError] = useState<string | null>(null);
  const [previewCanCancel, setPreviewCanCancel] = useState(true);
  const previewIframeRef = useRef<HTMLIFrameElement | null>(null);
  const previewReleaseRef = useRef<(() => void) | null>(null);
  const previewSaveHostRef = useRef<ReturnType<typeof createPreviewSaveStorageHost> | null>(null);
  const previewAssetHostRef = useRef<ReturnType<typeof createPreviewAssetServer> | null>(null);
  const previewFilesRef = useRef<Map<string, Uint8Array> | null>(null);
  const previewTraceByteBudgetRef = useRef<number | undefined>(undefined);
  const previewRequestRef = useRef(0);
  const previewClosingRef = useRef(false);
  const previewDiagnosticsRef = useRef<SessionReportEntry[]>([]);

  const finishPreviewPresentation = useCallback(() => {
    previewClosingRef.current = true;
    previewAssetHostRef.current?.dispose();
    previewAssetHostRef.current = null;
    previewSaveHostRef.current?.dispose();
    previewSaveHostRef.current = null;
    const frame = previewIframeRef.current;
    if (frame?.contentWindow) {
      frame.contentWindow.postMessage({ type: PREVIEW_STOP_MESSAGE }, previewOriginRef.current);
    }
    previewFilesRef.current = null;
    previewTraceByteBudgetRef.current = undefined;
    setPreviewOpen(false);
    setPreviewPhase(null);
    setPreviewError(null);
    setPreviewCanCancel(true);
    setPlayOpen(false);
    setSessionPlayScene(null);
    window.setTimeout(() => {
      previewClosingRef.current = false;
      const diagnostics = previewDiagnosticsRef.current;
      previewDiagnosticsRef.current = [];
      if (diagnostics.length > 0) {
        showPreviewReport(diagnostics);
      }
    }, 100);
  }, [setPlayOpen, setSessionPlayScene, showPreviewReport]);

  const closePreview = useCallback(() => {
    if (sessionTicketRef.current?.mode === "preview") void sessionOwner.stop(sessionTicketRef.current);
  }, [sessionOwner, sessionTicketRef]);

  const registerPreviewBeforeStop = useCallback((beforeStop: () => Promise<void>) => {
    const ticket = sessionTicketRef.current;
    if (!ticket || ticket.mode !== "preview") return () => {};
    const attached = sessionOwner.setBeforeStop(ticket, async () => { await beforeStop(); return true; });
    return () => { if (attached) sessionOwner.setBeforeStop(ticket, async () => true); };
  }, [sessionOwner, sessionTicketRef]);

  const sendPreviewPack = useCallback(() => {
    const files = previewFilesRef.current;
    const frame = previewIframeRef.current?.contentWindow;
    const traceByteBudget = previewTraceByteBudgetRef.current;
    const handoff = { files, closing: previewClosingRef.current };
    if (!canSendPreviewPack(handoff) || !frame || traceByteBudget === undefined) {
      return;
    }
    try {
      previewAssetHostRef.current?.dispose();
      previewAssetHostRef.current = createPreviewAssetServer({
        files: handoff.files,
        send: (message, transfer) => frame.postMessage(message, previewOriginRef.current, transfer),
      });
      frame.postMessage(previewPackFromFiles(handoff.files, traceByteBudget), previewOriginRef.current);
    } catch (error) {
      setPreviewError(
        `Preview Build could not send the game data: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }, []);

  // Closing the project ends a Preview Build preparation: the request it holds is no longer current.
  useEffect(() => {
    if (projectOpen) return;
    previewRequestRef.current += 1;
    setPreviewOpen(false);
    setPreviewPhase(null);
  }, [projectOpen]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (!isExpectedPreviewMessage(
        event,
        previewIframeRef.current?.contentWindow,
        previewOriginRef.current,
      )) return;
      if (previewAssetHostRef.current?.receive(event.data)) return;
      previewSaveHostRef.current?.receive(event);
      if (event.data?.type === PREVIEW_READY_MESSAGE) {
        lifecycle.sync();
        return;
      }
      // The player asks once its listener exists, which removes the race
      // between iframe `load` and the player module evaluating.
      if (isPreviewRequestPackMessage(event.data)) {
        sendPreviewPack();
        return;
      }
      if (isPreviewErrorMessage(event.data)) {
        setPreviewError(event.data.message);
        appendLog(`Preview Build failed: ${event.data.message}`);
        return;
      }
      if (!isPreviewDiagnosticsMessage(event.data)) return;
      const entries = sessionEntriesFromPreviewDiagnostics(
        event.data.diagnostics,
      );
      previewDiagnosticsRef.current = entries;
      if (shouldClosePreviewOnDiagnostics(entries) && !previewClosingRef.current) {
        closePreview();
      }
    };
    const lifecycle = attachPreviewLifecycle(() => {
      if (previewClosingRef.current || previewOriginRef.current !== window.location.origin) return null;
      const frame = previewIframeRef.current?.contentWindow;
      try {
        return frame && frame.location.origin === window.location.origin ? frame : null;
      } catch {
        return null;
      }
    });
    window.addEventListener("message", onMessage);
    return () => {
      previewAssetHostRef.current?.dispose();
      previewAssetHostRef.current = null;
      previewSaveHostRef.current?.dispose();
      previewSaveHostRef.current = null;
      lifecycle.dispose();
      window.removeEventListener("message", onMessage);
    };
  }, [appendLog, closePreview, sendPreviewPack]);

  const requestPreviewBuild = useCallback(async (saveConfirmed = false) => {
    if (!sessionOwner.canStart() || preparingRef.current) return;
    // Read at call time (see playRequestInputsRef); shadows the render values.
    const {
      documents: {
        assetRegistry,
        dirtyDocuments,
        exportGameArtifact,
        migrationPending,
        projectDirty,
        projectDocument,
        saveAll,
      },
      openPlaySceneGuid,
      openPlaySceneDocumentId,
    } = playRequestInputsRef.current;
    const effectiveStartup = resolvePreviewStartupGuid({
      playFromScene,
      openSceneGuid: openPlaySceneGuid,
      startupSceneGuid: projectDocument?.settings.startupSceneGuid ?? null,
    });
    const asset = effectiveStartup
      ? assetRegistry?.getByGuid(effectiveStartup)
      : undefined;
    if (!effectiveStartup || asset?.header.type !== "Scene") {
      setStartupAlertOpen(true);
      return;
    }
    setPreviewPreparationError(null);
    const needsSave = dirtyDocuments.length > 0 || projectDirty;
    if (needsSave && !saveConfirmed) {
      setUnsavedPrompt({
        dirtyNames: dirtyDocumentLabels(dirtyDocuments, projectDirty),
        previewBuild: true,
      });
      return;
    }
    if (needsSave && migrationPending.length > 0) {
      setPlayAwaitingMigration(true);
      return;
    }
    const ticket = sessionOwner.begin("preview");
    if (!ticket) return;
    sessionTicketRef.current = ticket;
    sessionSourceDocumentRef.current = playFromScene ? openPlaySceneDocumentId : null;
    const requestId = ++previewRequestRef.current;
    const isCurrentRequest = () => previewRequestRef.current === requestId && sessionOwner.isCurrent(ticket);
    const fail = (message: string) => {
      const reason = message || "Preview Build could not prepare the game.";
      setPreviewPreparationError(reason);
      appendLog(`Preview Build failed: ${reason}`);
    };
    previewClosingRef.current = false;
    preparingRef.current = true;
    setPreparing(true);
    setPreviewCanCancel(true);
    setPreviewPhase("Saving");
    try {
      if (needsSave) {
        const saved = await saveAll();
        if (!isCurrentRequest()) return;
        if (!saved) {
          setPlayAwaitingMigration(true);
          return;
        }
      }
      if (!isCurrentRequest()) return;
      await prepareSaveGameConfiguration({
        projectId: playRequestInputsRef.current.documents.projectGuid,
        settings: projectDocument?.settings.saveGame,
        loadDefinition: loadSaveGameDefinition,
      });
      if (!isCurrentRequest()) return;
      setPreviewPhase("Collecting Assets");
      const playerFiles = await loadPlayerDistFiles();
      if (!isCurrentRequest()) return;
      const packed = await exportGameArtifact({
        previewBuild: true,
        playerFiles,
        startupSceneGuid: effectiveStartup,
        transcoderAvailable: shouldPackKtx2ForPreviewBuild(),
        onPhase: (phase) => {
          if (isCurrentRequest()) setPreviewPhase(phase);
        },
      });
      if (!isCurrentRequest()) return;
      if (isErr(packed)) {
        if (packed.error === MISSING_STARTUP_SCENE_MESSAGE) {
          setStartupAlertOpen(true);
        } else {
          fail(packed.error);
        }
        return;
      }
      for (const warning of packed.value.warnings) {
        appendLog(`Preview Build warning: ${warning}`);
      }
      const previewTarget = previewTargetFromSrc(playerPreviewSrc(Date.now()), window.location.href);
      previewFilesRef.current = packed.value.files;
      previewTraceByteBudgetRef.current = traceByteBudget;
      setPreviewCanCancel(false);
      setPreviewPhase("Launching");
      if (!await releaseSceneViewports(ticket) || !isCurrentRequest()) return;
      setEncodeQueuePauseReason("play", true);
      setPlayOpen(true);
      setPreviewError(null);
      previewOriginRef.current = previewTarget.origin;
      previewSaveHostRef.current?.dispose();
      const previewProjectId = playRequestInputsRef.current.documents.projectGuid;
      previewSaveHostRef.current = previewProjectId ? createPreviewSaveStorageHost(createSaveGameStorage(), previewProjectId, {
        source: () => previewIframeRef.current?.contentWindow,
        origin: () => previewOriginRef.current,
        send: (message) => previewIframeRef.current?.contentWindow?.postMessage(message, previewOriginRef.current),
      }) : null;
      setPreviewSrc(previewTarget.src);
      sessionOwner.attach(ticket, () => {
        // The iframe owns a separate Engine. Its passive unmount callback
        // confirms browsing-context destruction; a timer does not.
        const frame = previewIframeRef.current;
        const released = new Promise<{ textureCountAfter: number; textureLeak: boolean; quarantined: boolean }>((resolve) => {
          const detached = () => resolve({ textureCountAfter: 0, textureLeak: false, quarantined: false });
          if (!frame?.isConnected) detached();
          else previewReleaseRef.current = detached;
        });
        finishPreviewPresentation();
        return {
          diagnostics: [], droppedDiagnostics: 0, textureCountBefore: 0,
          released,
          runtimeMode: "in-process", lastTrace: null,
        };
      });
      setPreviewOpen(true);
    } catch (error) {
      if (isCurrentRequest()) {
        previewFilesRef.current = null;
        fail(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (isCurrentRequest()) {
        preparingRef.current = false;
        setPreparing(false);
        setPreviewPhase(null);
        if (sessionOwner.getSnapshot().lifecycle === "preparing") void sessionOwner.stop(ticket);
      }
    }
  }, [
    appendLog,
    traceByteBudget,
    playFromScene,
    sessionOwner,
    finishPreviewPresentation,
    loadSaveGameDefinition,
    playRequestInputsRef,
    preparingRef,
    sessionSourceDocumentRef,
    sessionTicketRef,
    setPlayAwaitingMigration,
    setPlayOpen,
    setPreparing,
    setStartupAlertOpen,
    setUnsavedPrompt,
    releaseSceneViewports,
  ]);

  const cancelPreviewPreparation = useCallback(() => {
    previewRequestRef.current += 1;
    void sessionOwner.stop(sessionTicketRef.current ?? undefined);
    setPreviewPhase(null);
    setPreviewPreparationError(null);
    preparingRef.current = false;
    setPreparing(false);
  }, [preparingRef, sessionOwner, sessionTicketRef, setPreparing]);

  // The overlay calls this once its iframe has unmounted, which settles the session's release.
  const onPreviewDetached = useCallback(() => {
    previewReleaseRef.current?.();
    previewReleaseRef.current = null;
  }, []);

  return {
    previewOpen,
    previewSrc,
    previewIframeRef,
    previewError,
    previewPhase,
    previewPreparationError,
    previewCanCancel,
    closePreview,
    registerPreviewBeforeStop,
    requestPreviewBuild,
    cancelPreviewPreparation,
    onPreviewDetached,
  };
}
