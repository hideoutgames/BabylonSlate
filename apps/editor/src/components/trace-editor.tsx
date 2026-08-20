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
import {
  NumberField,
  PanelFrame,
  SelectableText,
  TREE_ROW_HEIGHT,
  WindowedList,
} from "@babylonslate/editor-kit";
import { Field, FieldLabel } from "@babylonslate/ui/components/field";
import { Slider } from "@babylonslate/ui/components/slider";
import { ScrollArea } from "@babylonslate/ui/components/scroll-area";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@babylonslate/ui/components/empty";
import { cn } from "@babylonslate/ui/lib/utils";
import { TICK_BUDGET_MS } from "@babylonslate/debugger";
import { useDocuments } from "../context/document-context";
import {
  asTracePayload,
  collectTraceLogWindow,
  frameTickMs,
} from "../lib/trace-view";

type TracePlaybackContextValue = {
  payload: TracePayload | null;
  index: number;
  setIndex: (index: number) => void;
};

const TracePlaybackContext = createContext<TracePlaybackContextValue | null>(
  null,
);

function sliderNumber(next: number | readonly number[]): number | undefined {
  const value = Array.isArray(next) ? next[0] : next;
  return typeof value === "number" ? value : undefined;
}

export function TracePlaybackProvider({
  documentId,
  children,
}: {
  documentId: string;
  children: ReactNode;
}) {
  const { openDocuments } = useDocuments();
  const doc = openDocuments.find((entry) => entry.id === documentId);
  const payload = asTracePayload(doc?.content);
  const last = Math.max(0, (payload?.frames.length ?? 1) - 1);
  const [index, setIndexState] = useState(last);
  const setIndex = useCallback(
    (next: number) => {
      setIndexState(Math.min(last, Math.max(0, next)));
    },
    [last],
  );
  const clamped = Math.min(last, Math.max(0, index));
  const value = useMemo(
    () => ({ payload, index: clamped, setIndex }),
    [payload, clamped, setIndex],
  );
  return (
    <TracePlaybackContext.Provider value={value}>
      {children}
    </TracePlaybackContext.Provider>
  );
}

function useTracePlayback(): TracePlaybackContextValue {
  const context = useContext(TracePlaybackContext);
  if (!context) {
    throw new Error("useTracePlayback must be used within TracePlaybackProvider");
  }
  return context;
}

export function TraceTimelineView({
  payload,
  index,
  onIndexChange,
}: {
  payload: TracePayload;
  index: number;
  onIndexChange: (index: number) => void;
}) {
  const max = Math.max(0, payload.frames.length - 1);
  return (
    <div className="flex flex-col gap-2 p-3" data-testid="trace-playback">
      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
        <span data-testid="trace-playback-seed">
          <SelectableText>seed {payload.seed}</SelectableText>
        </span>
        <span data-testid="trace-playback-frames">
          <SelectableText>
            {payload.frames.length} frames · dt {payload.dt.toFixed(4)}s
          </SelectableText>
        </span>
      </div>
      <div
        className="flex h-16 items-end gap-px"
        data-testid="trace-playback-graph"
      >
        {payload.frames.map((frame, frameIndex) => {
          const total = frameTickMs(frame);
          const height = Math.max(2, Math.min(100, (total / TICK_BUDGET_MS) * 100));
          return (
            <button
              key={frame.tickIndex}
              type="button"
              className={cn(
                "min-h-[2px] min-w-px flex-1 rounded-sm",
                frameIndex === index ? "bg-ring" : "bg-muted-foreground",
                total > TICK_BUDGET_MS && "bg-destructive",
              )}
              style={{ height: `${height}%` }}
              aria-label={`Frame ${frameIndex}`}
              data-testid={`trace-playback-graph-bar-${frameIndex}`}
              data-selected={frameIndex === index ? "true" : "false"}
              onClick={() => onIndexChange(frameIndex)}
            />
          );
        })}
      </div>
      <Field>
        <FieldLabel htmlFor="trace-frame">Frame</FieldLabel>
        <div className="flex min-w-0 items-center gap-2">
          <Slider
            className="min-w-0 flex-1"
            min={0}
            max={max}
            step={1}
            value={index}
            aria-label="Frame"
            data-testid="trace-playback-scrubber"
            onValueChange={(next) => {
              const value = sliderNumber(next);
              if (value !== undefined) onIndexChange(value);
            }}
          />
          <div className="w-20 shrink-0">
            <NumberField
              id="trace-frame"
              value={index}
              min={0}
              max={max}
              data-testid="trace-playback-frame"
              onChange={onIndexChange}
            />
          </div>
        </div>
      </Field>
    </div>
  );
}

export function TraceSnapshotView({
  payload,
  index,
}: {
  payload: TracePayload;
  index: number;
}) {
  const frame = payload.frames[index];
  return (
    <ScrollArea className="min-h-0 flex-1 p-3">
      <pre
        className="whitespace-pre-wrap font-mono text-xs"
        data-testid="trace-playback-snapshot"
      >
        <SelectableText>{frame?.snapshotText ?? ""}</SelectableText>
      </pre>
    </ScrollArea>
  );
}

export function TraceLogView({
  payload,
  index,
}: {
  payload: TracePayload;
  index: number;
}) {
  const lines = collectTraceLogWindow(payload, index);
  return (
    <ScrollArea className="min-h-0 flex-1 p-2">
      {lines.length === 0 ? (
        <p className="text-sm text-muted-foreground">No log output in this window.</p>
      ) : (
        <div data-testid="trace-playback-log">
          <WindowedList itemCount={lines.length} rowHeight={TREE_ROW_HEIGHT}>
            {(row) => (
              <li
                data-testid="trace-playback-log-line"
                className="flex h-full items-center font-mono text-xs"
              >
                <SelectableText className="truncate">
                  {lines[row]?.tickIndex} {lines[row]?.text}
                </SelectableText>
              </li>
            )}
          </WindowedList>
        </div>
      )}
    </ScrollArea>
  );
}

function TraceEmpty() {
  return (
    <Empty data-testid="trace-playback-empty">
      <EmptyHeader>
        <EmptyTitle>No Trace</EmptyTitle>
        <EmptyDescription>
          Record a Play session with snapshot start, then stop Play.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export function TraceTimelinePanel(_props: IDockviewPanelProps) {
  void _props;
  const { payload, index, setIndex } = useTracePlayback();
  return (
    <PanelFrame data-testid="trace-timeline-panel">
      {payload ? (
        <TraceTimelineView
          payload={payload}
          index={index}
          onIndexChange={setIndex}
        />
      ) : (
        <TraceEmpty />
      )}
    </PanelFrame>
  );
}

export function TraceSnapshotPanel(_props: IDockviewPanelProps) {
  void _props;
  const { payload, index } = useTracePlayback();
  return (
    <PanelFrame data-testid="trace-snapshot-panel">
      {payload ? (
        <TraceSnapshotView payload={payload} index={index} />
      ) : (
        <TraceEmpty />
      )}
    </PanelFrame>
  );
}

export function TraceLogPanel(_props: IDockviewPanelProps) {
  void _props;
  const { payload, index } = useTracePlayback();
  return (
    <PanelFrame data-testid="trace-log-panel">
      {payload ? <TraceLogView payload={payload} index={index} /> : <TraceEmpty />}
    </PanelFrame>
  );
}

/** Combined viewer for unit tests. Dock panels host the split views. */
export type TracePlaybackProps = {
  payload: TracePayload;
};

export function TracePlayback({ payload }: TracePlaybackProps) {
  const [index, setIndex] = useState(Math.max(0, payload.frames.length - 1));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <TraceTimelineView payload={payload} index={index} onIndexChange={setIndex} />
      <TraceSnapshotView payload={payload} index={index} />
      <TraceLogView payload={payload} index={index} />
    </div>
  );
}
