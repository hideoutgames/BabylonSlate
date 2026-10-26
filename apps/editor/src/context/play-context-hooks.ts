import { createContext, useContext, useEffect } from "react";
import type { AbstractEngine } from "@babylonjs/core";
import type { ScriptBundleEntry } from "@haptic/bridge";
import type { PlayUnsavedChoice } from "../components/play-unsaved-dialog";
import type { EditorLoopHandle } from "../lib/editor-scheduler-registry";
import type {
  navigateToSessionReportEntry,
  SessionReportNavigationResult,
} from "../services/diagnostic-navigation";
import type { GameSessionOwner, GameSessionState } from "../services/game-session-owner";
import type { PlaySessionResult } from "../services/play-session";
import type { SimulationViewport } from "../services/simulation-viewport";
import type { DocumentContextValue } from "./document-context-types";

// The contexts `PlayProvider` fills, the hooks that read them, and the types
// its hooks share.

export type PlayOptions = {
  /** Internal until the Simulation Inspector and authoring gates are qualified. */
  mode?: "play" | "simulate";
  injectFixtureThrow?: boolean;
  /** Answer from the Unsaved Changes prompt; unset means ask when dirty. */
  saveChoice?: PlayUnsavedChoice;
};

export interface PlayContextValue {
  sessionState: GameSessionState;
  sessionOwner: GameSessionOwner<PlaySessionResult>;
  requestSimulate: () => Promise<void>;
  canSimulate: boolean;
  simulationUnavailableReason: string | null;
  simulationDocumentId: string | null;
  registerSimulationViewport: (viewport: SimulationViewport) => () => void;
  playing: boolean;
  preparing: boolean;
  playAwaitingMigration: boolean;
  requestPlay: (options?: PlayOptions) => Promise<void>;
  canPlay: boolean;
  previewBuild: boolean;
  setPreviewBuild: (value: boolean) => void;
  playFromScene: boolean;
  setPlayFromScene: (value: boolean) => void;
  overlayStats: boolean;
  overlayConsole: boolean;
  overlayInspector: boolean;
  overlayProfiler: boolean;
  pauseOnPlay: boolean;
  setOverlayStats: (value: boolean) => void;
  setOverlayConsole: (value: boolean) => void;
  setOverlayInspector: (value: boolean) => void;
  setOverlayProfiler: (value: boolean) => void;
  setPauseOnPlay: (value: boolean) => void;
  launchPlay: (options?: PlayOptions & { scripts?: ScriptBundleEntry[] }) => void;
  resumePlayAfterMigration: () => Promise<void>;
  cancelPlayMigration: () => void;
  registerSharedEngine: (engine: AbstractEngine | null) => void;
  ensureSharedEngine: () => AbstractEngine | null;
  sharedEngineGeneration: number;
  registerScheduler: (scheduler: EditorLoopHandle) => () => void;
  /** A Scene viewport is in a blocking load; Play waits for it to finish. */
  sceneViewportLoading: boolean;
  reportSceneViewportLoading: (documentId: string, loading: boolean) => void;
  focusedNodeId: string | null;
  clearFocusedNode: () => void;
  appendLog: (line: string) => void;
  /** Open the graph that owns a node and focus it, as a session report row or a Simulation stop does. */
  openSessionSource: (
    entry: Parameters<typeof navigateToSessionReportEntry>[0],
  ) => Promise<SessionReportNavigationResult>;
}

/** What a Play or Preview Build request reads when it runs: the documents and Scenes as they were at the last render. */
export type PlayRequestInputs = {
  documents: DocumentContextValue;
  openPlaySceneGuid: string | null;
  openPlaySceneDocumentId: string | null;
  hasStartupScene: boolean;
};

/** The Unsaved Changes prompt a Play or Preview Build request opens before it saves. */
export type PlayUnsavedPrompt = {
  dirtyNames: string[];
  previewBuild: boolean;
  options?: PlayOptions;
};

/** The names a save prompt lists: each dirty document, then Project Settings when the project is dirty. */
export function dirtyDocumentLabels(documents: readonly { ref: { label: string } }[], projectDirty: boolean): string[] {
  return [...documents.map((doc) => doc.ref.label), ...(projectDirty ? ["Project Settings"] : [])];
}

export const PlayContext = createContext<PlayContextValue | null>(null);
// Single values of the Play state, each in a context of its own: a reader
// re-renders only when that value changes, not for every `PlayContext` change.
export const PlaySimulationDocumentIdContext = createContext<string | null>(null);
export const PlayFocusedNodeIdContext = createContext<string | null>(null);
export const OutputLogContext = createContext<{ lines: string[] }>({ lines: [] });
export type PlayDiagnosticsActions = Pick<PlayContextValue, "appendLog"> & {
  /** Counts a visible Output Log window until the returned release runs. */
  showOutputLogWindow: () => () => void;
  outputLogWindowVisible: () => boolean;
};
export const PlayDiagnosticsActionsContext = createContext<PlayDiagnosticsActions | null>(null);

export function usePlay(): PlayContextValue {
  const ctx = useContext(PlayContext);
  if (!ctx) {
    throw new Error("usePlay requires PlayProvider");
  }
  return ctx;
}

export function useOptionalPlay(): PlayContextValue | null {
  return useContext(PlayContext);
}

/**
 * The Scene document a Simulate session runs from, or null (also without a
 * PlayProvider). Unlike `usePlay()`, a reader re-renders only when this
 * changes, not for every Play state change.
 */
export function usePlaySimulationDocumentId(): string | null {
  return useContext(PlaySimulationDocumentIdContext);
}

/**
 * The graph node Play diagnostics asked to focus, or null (also without a
 * PlayProvider). Re-renders its reader only when the focused node changes.
 */
export function usePlayFocusedNodeId(): string | null {
  return useContext(PlayFocusedNodeIdContext);
}

/**
 * Output Log writer only. Stable for the provider's lifetime, so a caller that only
 * logs does not re-render when Play state changes.
 */
export function usePlayDiagnosticsActions(): Pick<PlayContextValue, "appendLog"> {
  const actions = useContext(PlayDiagnosticsActionsContext);
  if (!actions) {
    throw new Error("usePlayDiagnosticsActions requires PlayProvider");
  }
  return actions;
}

export function useOutputLog(): { lines: string[] } {
  return useContext(OutputLogContext);
}

/**
 * Marks an Output Log window as visible while the caller is mounted and
 * `visible`. Play reports a preparation failure in a dialog only while no
 * Output Log window is visible.
 */
export function useOutputLogWindow(visible: boolean): void {
  const actions = useContext(PlayDiagnosticsActionsContext);
  useEffect(() => (visible ? actions?.showOutputLogWindow() : undefined), [actions, visible]);
}
