import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Engine } from "@babylonjs/core";
import { createAppEngine } from "@babylonslate/render";
import type { SessionReportEntry } from "@babylonslate/runtime";
import { PlayOverlay } from "../components/play-overlay";
import { PreviewSessionReport } from "../components/preview-session-report";
import type { PlaySessionResult } from "../services/play-session";
import { PREVIEW_FIXTURE_NODE_ID } from "../services/play-session";

interface PlayContextValue {
  playing: boolean;
  startPlay: (options?: { injectFixtureThrow?: boolean }) => void;
  stopPlay: () => void;
  registerSharedEngine: (engine: Engine | null) => void;
  focusedNodeId: string | null;
  clearFocusedNode: () => void;
  appendLog: (line: string) => void;
  logLines: string[];
}

const PlayContext = createContext<PlayContextValue | null>(null);
const OutputLogContext = createContext<{ lines: string[] }>({ lines: [] });

export function PlayProvider({ children }: { children: ReactNode }) {
  const engineRef = useRef<Engine | null>(null);
  const ownedEngineRef = useRef<Engine | null>(null);
  const ownedCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [injectThrow, setInjectThrow] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportEntries, setReportEntries] = useState<SessionReportEntry[]>([]);
  const [dropped, setDropped] = useState(0);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);

  const appendLog = useCallback((line: string) => {
    setLogLines((prev) => [...prev.slice(-500), line]);
  }, []);

  const registerSharedEngine = useCallback((engine: Engine | null) => {
    // Prefer viewport-owned engine; keep fallback owned engine if viewport gone.
    if (engine) {
      engineRef.current = engine;
      return;
    }
    engineRef.current = ownedEngineRef.current;
  }, []);

  const ensureEngine = useCallback((): Engine | null => {
    if (engineRef.current) return engineRef.current;
    const canvas = document.createElement("canvas");
    canvas.width = 8;
    canvas.height = 8;
    canvas.style.display = "none";
    document.body.appendChild(canvas);
    const engine = createAppEngine(canvas);
    ownedCanvasRef.current = canvas;
    ownedEngineRef.current = engine;
    engineRef.current = engine;
    return engine;
  }, []);

  const startPlay = useCallback(
    (options?: { injectFixtureThrow?: boolean }) => {
      if (!ensureEngine()) {
        appendLog("Play failed: could not create Engine.");
        return;
      }
      setInjectThrow(Boolean(options?.injectFixtureThrow));
      setPlaying(true);
    },
    [appendLog, ensureEngine],
  );

  const handleClose = useCallback(
    (result: PlaySessionResult) => {
      setPlaying(false);
      setDropped(result.droppedDiagnostics);
      setReportEntries(result.diagnostics);
      if (result.diagnostics.length > 0) {
        setReportOpen(true);
      }
      appendLog(
        `Play ended (textures ${result.textureCountBefore}→${result.textureCountAfter})`,
      );
    },
    [appendLog],
  );

  const value = useMemo<PlayContextValue>(
    () => ({
      playing,
      startPlay,
      stopPlay: () => setPlaying(false),
      registerSharedEngine,
      focusedNodeId,
      clearFocusedNode: () => setFocusedNodeId(null),
      appendLog,
      logLines,
    }),
    [
      playing,
      startPlay,
      registerSharedEngine,
      focusedNodeId,
      appendLog,
      logLines,
    ],
  );

  return (
    <PlayContext.Provider value={value}>
      <OutputLogContext.Provider value={{ lines: logLines }}>
        {children}
        {playing && engineRef.current ? (
          <PlayOverlay
            sharedEngine={engineRef.current}
            injectFixtureThrow={injectThrow}
            onClose={handleClose}
          />
        ) : null}
        <PreviewSessionReport
          open={reportOpen}
          entries={reportEntries}
          dropped={dropped}
          onOpenChange={setReportOpen}
          onNavigate={(entry) => {
            setFocusedNodeId(entry.nodeId ?? PREVIEW_FIXTURE_NODE_ID);
            setReportOpen(false);
            appendLog(
              `Navigate to node ${entry.nodeId ?? PREVIEW_FIXTURE_NODE_ID}`,
            );
          }}
        />
        {/* Focus marker for Playwright / graph navigation hook. */}
        {focusedNodeId ? (
          <span
            className="sr-only"
            data-testid="focused-graph-node"
            data-node-id={focusedNodeId}
          >
            {focusedNodeId}
          </span>
        ) : null}
      </OutputLogContext.Provider>
    </PlayContext.Provider>
  );
}

export function usePlay(): PlayContextValue {
  const ctx = useContext(PlayContext);
  if (!ctx) {
    throw new Error("usePlay requires PlayProvider");
  }
  return ctx;
}

export function useOutputLog(): { lines: string[] } {
  return useContext(OutputLogContext);
}
