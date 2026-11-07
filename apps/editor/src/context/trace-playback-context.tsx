import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { TracePayload } from "@haptic/debugger";
import { useOpenDocument } from "./document-context";
import { asTracePayload, validTraceIndex } from "../lib/trace-view";
import type { TraceSnapshotState } from "../components/trace-snapshot-view";
import type { TraceLogState } from "../components/trace-log-view";

type TracePlaybackContextValue = {
  payload: TracePayload | null;
  index: number;
  setIndex: (index: number) => void;
  snapshot: TraceSnapshotState;
  setSnapshot: (state: TraceSnapshotState) => void;
  log: TraceLogState;
  setLog: (state: TraceLogState) => void;
  windowSize: number | null;
  setWindowSize: (size: number | null) => void;
};
const TracePlaybackContext = createContext<TracePlaybackContextValue | null>(
  null,
);

function TraceSession({
  payload,
  children,
}: {
  payload: TracePayload | null;
  children: ReactNode;
}) {
  const length = payload?.frames.length ?? 0;
  const [index, setIndexState] = useState(Math.max(0, length - 1));
  const [snapshot, setSnapshot] = useState<TraceSnapshotState>(() => ({
    mode: "tree", query: "", selectedId: null, changeId: null,
    expanded: new Set([
      "/snapshot/actors",
      "/snapshot/gameInstance",
      "/snapshot/subsystems",
    ]),
  }));
  const [log, setLog] = useState<TraceLogState>({
    query: "",
    severity: "all",
    selected: null,
  });
  const [windowSize, setWindowSize] = useState<number | null>(null);
  const setIndex = useCallback(
    (next: number) =>
      setIndexState((previous) => validTraceIndex(next, length, previous)),
    [length],
  );
  const clamped = validTraceIndex(index, length);
  const value = useMemo(
    () => ({
      payload,
      index: clamped,
      setIndex,
      snapshot,
      setSnapshot,
      log,
      setLog,
      windowSize,
      setWindowSize,
    }),
    [payload, clamped, setIndex, snapshot, log, windowSize],
  );
  return (
    <TracePlaybackContext.Provider value={value}>
      {children}
    </TracePlaybackContext.Provider>
  );
}

export function TracePlaybackProvider({
  documentId,
  children,
}: {
  documentId: string;
  children: ReactNode;
}) {
  const content = useOpenDocument(documentId)?.content;
  const payload = useMemo(() => asTracePayload(content), [content]);
  return (
    <TraceSession key={documentId} payload={payload}>
      {children}
    </TraceSession>
  );
}

/** The open Trace document's playback state, shared by its Timeline, Snapshot and Log panels. */
export function useTracePlayback(): TracePlaybackContextValue {
  const context = useContext(TracePlaybackContext);
  if (!context)
    throw new Error(
      "useTracePlayback must be used within TracePlaybackProvider",
    );
  return context;
}
