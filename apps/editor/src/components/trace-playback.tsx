import { useState } from "react";
import type { TracePayload } from "@babylonslate/debugger";
import { SelectableText } from "@babylonslate/editor-kit";
import { Field, FieldLabel } from "@babylonslate/ui/components/field";
import { Input } from "@babylonslate/ui/components/input";
import { ScrollArea } from "@babylonslate/ui/components/scroll-area";

export type TracePlaybackProps = {
  payload: TracePayload;
};

/** Scrubbable recorded-session viewer (seed, frames, snapshot, log). */
export function TracePlayback({ payload }: TracePlaybackProps) {
  const [index, setIndex] = useState(Math.max(0, payload.frames.length - 1));
  const frame = payload.frames[index];
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
      <Field>
        <FieldLabel htmlFor="trace-frame">Frame</FieldLabel>
        <Input
          id="trace-frame"
          type="range"
          min={0}
          max={max}
          value={index}
          data-testid="trace-playback-scrubber"
          onChange={(event) => setIndex(Number(event.target.value))}
        />
      </Field>
      {frame ? (
        <ScrollArea className="max-h-48">
          <pre
            className="whitespace-pre-wrap font-mono text-xs"
            data-testid="trace-playback-snapshot"
          >
            <SelectableText>{frame.snapshotText ?? ""}</SelectableText>
          </pre>
          <div data-testid="trace-playback-log" className="flex flex-col gap-1">
            {frame.logs.map((entry, i) => (
              <SelectableText key={`${i}-${entry.message}`}>
                {entry.message}
              </SelectableText>
            ))}
          </div>
        </ScrollArea>
      ) : null}
    </div>
  );
}
