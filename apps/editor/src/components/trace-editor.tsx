import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { IDockviewPanelProps } from "dockview-react";
import type { TracePayload } from "@babylonslate/debugger";
import { PanelFrame } from "@babylonslate/editor-kit";
import { useDocuments } from "../context/document-context";
import { asTracePayload, validTraceIndex } from "../lib/trace-view";
import { TraceTimelineView } from "./trace-timeline-view";
import {
  initialTraceSnapshotState,
  TraceSnapshotView,
  type TraceSnapshotState,
} from "./trace-snapshot-view";
import { TraceLogView, type TraceLogState } from "./trace-log-view";
import { TraceEmptyState } from "./trace-inspection-controls";
import "./trace-editor.css";

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
  const [snapshot, setSnapshot] = useState(initialTraceSnapshotState);
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
  const { openDocuments } = useDocuments();
  const content = openDocuments.find(
    (entry) => entry.id === documentId,
  )?.content;
  const payload = useMemo(() => asTracePayload(content), [content]);
  return (
    <TraceSession key={documentId} payload={payload}>
      {children}
    </TraceSession>
  );
}

function useTracePlayback(): TracePlaybackContextValue {
  const context = useContext(TracePlaybackContext);
  if (!context)
    throw new Error(
      "useTracePlayback must be used within TracePlaybackProvider",
    );
  return context;
}

function TraceEmpty() {
  return (
    <TraceEmptyState
      title="No Trace"
      description="Record a Play session with snapshot start, then stop Play."
    />
  );
}

export function TraceTimelinePanel(_props: IDockviewPanelProps) {
  void _props;
  const { payload, index, setIndex, windowSize, setWindowSize } =
    useTracePlayback();
  return (
    <PanelFrame data-testid="trace-timeline-panel">
      {payload ? (
        <TraceTimelineView
          payload={payload}
          index={index}
          onIndexChange={setIndex}
          windowSize={windowSize}
          onWindowSizeChange={setWindowSize}
        />
      ) : (
        <TraceEmpty />
      )}
    </PanelFrame>
  );
}
export function TraceSnapshotPanel(_props: IDockviewPanelProps) {
  void _props;
  const { payload, index, snapshot, setSnapshot } = useTracePlayback();
  return (
    <PanelFrame data-testid="trace-snapshot-panel">
      {payload ? (
        <TraceSnapshotView
          payload={payload}
          index={index}
          state={snapshot}
          onStateChange={setSnapshot}
        />
      ) : (
        <TraceEmpty />
      )}
    </PanelFrame>
  );
}
export function TraceLogPanel(_props: IDockviewPanelProps) {
  void _props;
  const { payload, index, setIndex, log, setLog } = useTracePlayback();
  return (
    <PanelFrame data-testid="trace-log-panel">
      {payload ? (
        <TraceLogView
          payload={payload}
          index={index}
          onIndexChange={setIndex}
          state={log}
          onStateChange={setLog}
        />
      ) : (
        <TraceEmpty />
      )}
    </PanelFrame>
  );
}

export type TracePlaybackProps = { payload: TracePayload };
function TraceCombinedViews() {
  const {
    payload,
    index,
    setIndex,
    snapshot,
    setSnapshot,
    log,
    setLog,
    windowSize,
    setWindowSize,
  } = useTracePlayback();
  if (!payload) return <TraceEmpty />;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TraceTimelineView
        payload={payload}
        index={index}
        onIndexChange={setIndex}
        windowSize={windowSize}
        onWindowSizeChange={setWindowSize}
      />
      <TraceSnapshotView
        payload={payload}
        index={index}
        state={snapshot}
        onStateChange={setSnapshot}
      />
      <TraceLogView
        payload={payload}
        index={index}
        onIndexChange={setIndex}
        state={log}
        onStateChange={setLog}
      />
    </div>
  );
}
/** Combined viewer exercises the same document session as the DockView panels. */
export function TracePlayback({ payload }: TracePlaybackProps) {
  return (
    <TraceSession payload={payload}>
      <TraceCombinedViews />
    </TraceSession>
  );
}
