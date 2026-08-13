import { useState } from "react";
import type { TracePayload } from "@babylonslate/debugger";
import { NumberField, SelectableText } from "@babylonslate/editor-kit";
import { Field, FieldLabel } from "@babylonslate/ui/components/field";
import { Slider } from "@babylonslate/ui/components/slider";
import { ScrollArea } from "@babylonslate/ui/components/scroll-area";

export type TracePlaybackProps = {
  payload: TracePayload;
};

function sliderNumber(next: number | readonly number[]): number | undefined {
  const value = Array.isArray(next) ? next[0] : next;
  return typeof value === "number" ? value : undefined;
}

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
              if (value !== undefined) setIndex(value);
            }}
          />
          <div className="w-20 shrink-0">
            <NumberField
              id="trace-frame"
              value={index}
              min={0}
              max={max}
              data-testid="trace-playback-frame"
              onChange={setIndex}
            />
          </div>
        </div>
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
