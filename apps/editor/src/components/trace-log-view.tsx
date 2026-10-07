import { useMemo } from "react";
import type { TracePayload } from "@babylonslate/debugger";
import {
  SearchInput,
  SelectableText,
  WindowedList,
} from "@babylonslate/editor-kit";
import { Button } from "@babylonslate/ui/components/button";
import { ScrollArea } from "@babylonslate/ui/components/scroll-area";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@babylonslate/ui/components/select";
import { cn } from "@babylonslate/ui/lib/utils";
import {
  collectTraceLogWindow,
  filterTraceLogs,
  TRACE_LOG_WINDOW_FRAMES,
  type TraceLogLine,
} from "../lib/trace-view";
import {
  TraceCopyButton,
  TraceEmptyState,
} from "./trace-inspection-controls";
import { useTraceTouch } from "../lib/use-trace-touch";

const severityLabel = (severity: string) =>
  severity === "warn"
    ? "Warning"
    : severity.charAt(0).toUpperCase() + severity.slice(1);
const severityTone = (severity: string) =>
  severity === "error"
    ? "text-destructive"
    : severity === "warn" || severity === "warning"
      ? "text-(--warning)"
      : severity === "print"
        ? "text-trace-script"
        : "text-muted-foreground";

export type TraceLogState = {
  query: string;
  severity: string;
  selected: TraceLogLine | null;
};

export function TraceLogView({
  payload,
  index,
  onIndexChange,
  state,
  onStateChange,
}: {
  payload: TracePayload;
  index: number;
  onIndexChange: (index: number) => void;
  state: TraceLogState;
  onStateChange: (state: TraceLogState) => void;
}) {
  const windowLines = useMemo(
    () => collectTraceLogWindow(payload, index),
    [payload, index],
  );
  const lines = useMemo(
    () => filterTraceLogs(windowLines, state.query, state.severity),
    [windowLines, state.query, state.severity],
  );
  const touch = useTraceTouch();
  const first =
    payload.frames[Math.max(0, index - TRACE_LOG_WINDOW_FRAMES + 1)]?.tickIndex;
  const last = payload.frames[index]?.tickIndex;
  const selected = state.selected;
  const severities = useMemo(
    () =>
      [
        ...new Set([
          "log",
          "info",
          "warn",
          "error",
          "print",
          ...payload.frames.flatMap((frame) =>
            frame.logs.map((line) => line.severity),
          ),
        ]),
      ].filter(Boolean),
    [payload],
  );
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col gap-2 p-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <SearchInput
          aria-label="Search Log"
          placeholder="Search Log…"
          value={state.query}
          onChange={(query) => onStateChange({ ...state, query })}
        />
        <Select
          value={state.severity}
          onValueChange={(severity) =>
            onStateChange({ ...state, severity: severity ?? "all" })
          }
        >
          <SelectTrigger aria-label="Log Severity" size="sm">
            <SelectValue>
              {state.severity === "all"
                ? "All Severities"
                : severityLabel(state.severity)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="all">All Severities</SelectItem>
              {severities.map((severity) => (
                <SelectItem key={severity} value={severity}>
                  {severityLabel(severity)}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
      <span data-testid="trace-log-scope">
        <SelectableText className="text-[0.7rem] text-muted-foreground">
          Selected Frame + Previous {TRACE_LOG_WINDOW_FRAMES - 1} (Up To{" "}
          {TRACE_LOG_WINDOW_FRAMES} Frames)
          {first !== undefined ? ` · Ticks ${first}–${last}` : ""} ·{" "}
          {lines.length} Entries
        </SelectableText>
      </span>
      <ScrollArea className="min-h-0 flex-1 rounded-md border bg-background">
        {lines.length === 0 ? (
          <TraceEmptyState
            title="No Log Output In This Window"
            description={
              state.query || state.severity !== "all"
                ? "Try clearing the search or severity filter."
                : undefined
            }
          />
        ) : (
          <div data-testid="trace-playback-log">
            <WindowedList itemCount={lines.length} rowHeight={touch ? 44 : 28}>
              {(i) => {
                const line = lines[i]!;
                return (
                  <Button
                    variant="ghost"
                    className={cn(
                      "h-full w-full justify-start gap-3 rounded-none border-l-2 border-transparent px-2 text-left font-normal",
                      selected?.id === line.id && "border-l-trace-selected bg-accent",
                    )}
                    data-testid="trace-playback-log-line"
                    data-current-tick={
                      line.frameIndex === index ? "true" : "false"
                    }
                    aria-pressed={selected?.id === line.id}
                    onClick={() => {
                      onStateChange({ ...state, selected: line });
                      onIndexChange(line.frameIndex);
                    }}
                  >
                    <span className="w-10 shrink-0 text-right font-mono text-xs text-muted-foreground tabular-nums">
                      {line.tickIndex}
                    </span>
                    <span
                      className={cn(
                        "w-14 shrink-0 text-left text-xs font-medium",
                        severityTone(line.severity),
                      )}
                      data-severity={line.severity}
                    >
                      {severityLabel(line.severity)}
                    </span>
                    <span className="w-24 shrink-0 truncate text-left text-xs text-muted-foreground">
                      {line.category}
                      {line.key ? ` [${line.key}]` : ""}
                    </span>
                    <span className="min-w-0 truncate font-mono text-xs">
                      {line.text}
                    </span>
                  </Button>
                );
              }}
            </WindowedList>
          </div>
        )}
      </ScrollArea>
      {selected && (
        <div
          className="flex max-h-48 shrink-0 flex-col gap-1.5 overflow-auto rounded-md border bg-background p-2"
          data-testid="trace-log-detail"
        >
          <SelectableText className="break-all text-xs text-muted-foreground">
            Tick {selected.tickIndex} · {selected.severity} ·{" "}
            {selected.category}
            {selected.key ? ` · ${selected.key}` : ""}
          </SelectableText>
          <SelectableText
            className={cn(
              "whitespace-pre-wrap break-all font-mono text-xs",
              selected.severity === "error" && "text-destructive",
            )}
          >
            {selected.text}
          </SelectableText>
          <TraceCopyButton label="Copy Message" text={selected.text} />
        </div>
      )}
    </div>
  );
}
