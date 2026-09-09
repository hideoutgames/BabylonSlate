import { useMemo } from "react";
import type { TracePayload } from "@babylonslate/debugger";
import {
  SearchInput,
  SelectableText,
  TreeView,
  WindowedList,
  type TreeViewNode,
} from "@babylonslate/editor-kit";
import {
  Alert,
  AlertTitle,
  AlertDescription,
} from "@babylonslate/ui/components/alert";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@babylonslate/ui/components/toggle-group";
import { Button } from "@babylonslate/ui/components/button";
import { Separator } from "@babylonslate/ui/components/separator";
import { ScrollArea } from "@babylonslate/ui/components/scroll-area";
import {
  compareTraceSnapshots,
  exactTraceValue,
  findTraceNode,
  flattenTraceSnapshot,
  parseTraceSnapshot,
  traceSnapshotRoots,
  traceValuePreview,
} from "../lib/trace-snapshot";
import {
  TraceCopyButton,
  TraceEmptyState,
  useTraceTouch,
} from "./trace-inspection-controls";

export type TraceSnapshotState = {
  mode: "tree" | "changes" | "raw";
  query: string;
  selectedId: string | null;
  changeId: string | null;
  expanded: Set<string>;
};
export const initialTraceSnapshotState = (): TraceSnapshotState => ({
  mode: "tree",
  query: "",
  selectedId: null,
  changeId: null,
  expanded: new Set(["/snapshot/actors", "/snapshot/gameInstance"]),
});

export function TraceSnapshotView({
  payload,
  index,
  state,
  onStateChange,
}: {
  payload: TracePayload;
  index: number;
  state: TraceSnapshotState;
  onStateChange: (state: TraceSnapshotState) => void;
}) {
  const frame = payload.frames[index];
  const previousText = payload.frames[index - 1]?.snapshotText;
  const parsed = useMemo(
    () => parseTraceSnapshot(frame?.snapshotText),
    [frame?.snapshotText],
  );
  const previous = useMemo(
    () => (state.mode === "changes" ? parseTraceSnapshot(previousText) : null),
    [previousText, state.mode],
  );
  const roots = useMemo(
    () => (frame ? traceSnapshotRoots(frame, parsed) : []),
    [frame, parsed],
  );
  const rows = useMemo(
    () => flattenTraceSnapshot(roots, state.expanded, state.query),
    [roots, state.expanded, state.query],
  );
  const selected = useMemo(
    () => findTraceNode(roots, state.selectedId),
    [roots, state.selectedId],
  );
  const changes = useMemo(
    () =>
      previous?.status === "ready" && parsed.status === "ready"
        ? compareTraceSnapshots(previous.value, parsed.value)
        : [],
    [previous, parsed],
  );
  const filteredChanges = useMemo(() => {
    const q = state.query.trim().toLowerCase();
    return changes.filter((change) =>
      `${change.path} ${change.label} ${change.kind} ${exactTraceValue(change.before)} ${exactTraceValue(change.after)}`
        .toLowerCase()
        .includes(q),
    );
  }, [changes, state.query]);
  const change = changes.find((entry) => entry.id === state.changeId);
  const touch = useTraceTouch();
  const rowHeight = touch ? 44 : 28;
  const treeNodes: TreeViewNode[] = useMemo(
    () =>
      rows.map((row) => ({
        id: row.id,
        label: row.label,
        depth: row.depth,
        expanded: row.expanded,
        hasChildren: row.hasChildren,
        preview: (
          <span
            className="block max-w-32 truncate font-mono text-xs text-muted-foreground"
            title={traceValuePreview(row.value)}
          >
            {traceValuePreview(row.value)}
          </span>
        ),
      })),
    [rows],
  );
  const patch = (next: Partial<TraceSnapshotState>) =>
    onStateChange({ ...state, ...next });

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-2 p-2"
      data-testid="trace-playback-snapshot"
      data-tick={frame?.tickIndex}
    >
      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup
          aria-label="Snapshot View"
          value={[state.mode]}
          size={touch ? "touch" : "sm"}
          variant="outline"
          onValueChange={(values) => {
            const value = values[0];
            if (value === "tree" || value === "changes" || value === "raw")
              patch({ mode: value });
          }}
        >
          <ToggleGroupItem value="tree">Tree</ToggleGroupItem>
          <ToggleGroupItem value="changes">Changes</ToggleGroupItem>
          <ToggleGroupItem value="raw">Raw Snapshot</ToggleGroupItem>
        </ToggleGroup>
        <SelectableText className="text-xs text-muted-foreground">
          {frame ? `Tick ${frame.tickIndex}` : "No Recorded Frames"}
        </SelectableText>
      </div>
      {state.mode !== "raw" && (
        <div className="flex">
          <SearchInput
            aria-label="Search Snapshot"
            placeholder={
              state.mode === "changes" ? "Search Changes…" : "Search Snapshot…"
            }
            value={state.query}
            onChange={(query) => patch({ query })}
          />
        </div>
      )}
      {!frame ? (
        <TraceEmptyState title="No Recorded Frames" />
      ) : state.mode === "raw" ? (
        <>
          <TraceCopyButton label="Copy JSON" text={frame.snapshotText ?? ""} />
          <ScrollArea className="min-h-0 flex-1">
            <pre
              className="whitespace-pre-wrap break-all font-mono text-xs"
              data-testid="trace-snapshot-raw"
            >
              <SelectableText>
                {frame.snapshotText ?? "No Snapshot Recorded"}
              </SelectableText>
            </pre>
          </ScrollArea>
        </>
      ) : state.mode === "changes" ? (
        <>
          <SelectableText className="text-xs text-muted-foreground">
            Changes Since Previous Recorded Frame
            {payload.frames[index - 1]
              ? ` · Tick ${payload.frames[index - 1]!.tickIndex} → ${frame.tickIndex}`
              : ""}
          </SelectableText>
          {index === 0 ? (
            <TraceEmptyState title="No Previous Recorded Frame" />
          ) : previous?.status !== "ready" || parsed.status !== "ready" ? (
            <TraceEmptyState
              title="Comparison Unavailable"
              description="Both recorded frames need a readable snapshot."
            />
          ) : filteredChanges.length === 0 ? (
            <TraceEmptyState
              title={
                changes.length
                  ? "No Matching Changes"
                  : "No World State Changes"
              }
            />
          ) : (
            <ScrollArea
              className="min-h-0 flex-1"
              data-testid="trace-snapshot-changes"
            >
              <WindowedList
                itemCount={filteredChanges.length}
                rowHeight={rowHeight}
              >
                {(i) => {
                  const entry = filteredChanges[i]!;
                  return (
                    <Button
                      variant="ghost"
                      className="h-full w-full justify-start gap-2"
                      aria-pressed={entry.id === state.changeId}
                      onClick={() => patch({ changeId: entry.id })}
                    >
                      <span className="shrink-0">{entry.kind}</span>
                      <span className="min-w-0 flex-1 truncate">
                        {entry.label} · {entry.path}
                      </span>
                      <span className="max-w-40 truncate font-mono text-xs">
                        {traceValuePreview(entry.before)} →{" "}
                        {traceValuePreview(entry.after)}
                      </span>
                    </Button>
                  );
                }}
              </WindowedList>
            </ScrollArea>
          )}
          {change && (
            <div
              className="flex max-h-48 shrink-0 flex-col gap-1 overflow-auto"
              data-testid="trace-change-detail"
            >
              <Separator />
              <SelectableText className="break-all text-xs">
                {change.kind} · {change.path}
              </SelectableText>
              <SelectableText className="whitespace-pre-wrap break-all font-mono text-xs">{`Before: ${exactTraceValue(change.before)}\nAfter: ${exactTraceValue(change.after)}`}</SelectableText>
              <TraceCopyButton
                label="Copy Change"
                text={`${change.path}\nBefore: ${exactTraceValue(change.before)}\nAfter: ${exactTraceValue(change.after)}`}
              />
            </div>
          )}
        </>
      ) : (
        <>
          {parsed.status === "invalid" && (
            <Alert>
              <AlertTitle>Snapshot Could Not Be Parsed</AlertTitle>
              <AlertDescription>
                Open Raw Snapshot to inspect the original text.
              </AlertDescription>
            </Alert>
          )}
          {parsed.status === "missing" && (
            <p className="text-xs text-muted-foreground">
              No Snapshot Recorded
            </p>
          )}
          <div className="min-h-0 flex-1">
            <TreeView
              aria-label="Snapshot"
              nodes={treeNodes}
              rowHeight={rowHeight}
              selectedId={selected?.id ?? null}
              onSelect={(selectedId) => patch({ selectedId })}
              onToggleExpanded={(id) => {
                const expanded = new Set(state.expanded);
                if (expanded.has(id)) expanded.delete(id);
                else expanded.add(id);
                patch({ expanded });
              }}
              emptyLabel="No Matching Values"
            />
          </div>
          <div
            className="flex max-h-48 shrink-0 flex-col gap-1 overflow-auto"
            data-testid="trace-value-detail"
          >
            <Separator />
            {selected ? (
              <>
                <SelectableText className="break-all text-xs text-muted-foreground">
                  {selected.path}
                </SelectableText>
                <SelectableText className="whitespace-pre-wrap break-all font-mono text-xs">
                  {exactTraceValue(selected.value)}
                </SelectableText>
                <div className="flex flex-wrap gap-1">
                  <TraceCopyButton
                    label="Copy Value"
                    text={exactTraceValue(selected.value)}
                  />
                  <TraceCopyButton label="Copy Path" text={selected.path} />
                </div>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                {state.selectedId
                  ? "Selected Value Is Not Present In This Frame"
                  : "Select A Value To Inspect"}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
