import type { IDockviewPanelProps } from "dockview-react";
import { PanelFrame } from "@haptic/editor-kit";
import { useTracePlayback } from "../context/trace-playback-context";
import { TraceTimelineView } from "./trace-timeline-view";
import { TraceSnapshotView } from "./trace-snapshot-view";
import { TraceLogView } from "./trace-log-view";
import { TraceEmptyState } from "./trace-inspection-controls";
import "./trace-editor.css";

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
