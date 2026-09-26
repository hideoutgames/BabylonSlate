import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { ChevronDownIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { Button } from "@babylonslate/ui/components/button";
import { cn } from "@babylonslate/ui/lib/utils";
import { ColorField } from "./color-field";
import {
  KEY_NEIGHBOUR_GAP,
  clampKeyTime,
  clampNumber,
  keyHitFraction,
  roundKeyTime,
  sampleGradient,
  widestGapInsertion,
  type GradientStop,
} from "./curve-keys";
import { NumericDragField } from "./numeric-drag-field";

export type { GradientStop } from "./curve-keys";

export interface GradientFieldProps {
  id?: string;
  "aria-label": string;
  /** Host-normalized: sorted, first `t` = 0, last `t` = 1. */
  value: readonly GradientStop[];
  onChange: (next: GradientStop[]) => void;
  minStops?: number;
  maxStops?: number;
  defaultExpanded?: boolean;
  disabled?: boolean;
  /** Defaults to `gradient-<id>`. */
  "data-testid"?: string;
}

const STOP_STEP = 0.01;
const STOP_STEP_LARGE = 0.1;

/** Alpha checkerboard from theme tokens, visible in both schemes. */
const CHECKERBOARD =
  "conic-gradient(var(--muted) 0.25turn, var(--border) 0 0.5turn, var(--muted) 0 0.75turn, var(--border) 0) 0 0 / 8px 8px";

function cssColor([r, g, b, a]: GradientStop["color"]): string {
  const channel = (value: number) => Math.round(clampNumber(value, 0, 1) * 255);
  return `rgb(${channel(r)} ${channel(g)} ${channel(b)} / ${clampNumber(a, 0, 1)})`;
}

function swatchBackground(color: GradientStop["color"]): string {
  return `linear-gradient(${cssColor(color)}, ${cssColor(color)}), ${CHECKERBOARD}`;
}

/** User colours over the token checkerboard, so alpha reads as transparency. */
function gradientBackground(stops: readonly GradientStop[]): string {
  if (stops.length < 2) return swatchBackground(stops[0]?.color ?? [0, 0, 0, 0]);
  const colors = stops.map((stop) => `${cssColor(stop.color)} ${stop.t * 100}%`);
  return `linear-gradient(to right, ${colors.join(", ")}), ${CHECKERBOARD}`;
}

/**
 * Compact gradient row (bar over an alpha checkerboard) that expands into a
 * stop editor: drag stops, Add / Remove Stop, Location and Color with alpha.
 */
export function GradientField({
  id,
  "aria-label": ariaLabel,
  value: stops,
  onChange,
  minStops = 2,
  maxStops = 8,
  defaultExpanded = false,
  disabled = false,
  "data-testid": testId,
}: GradientFieldProps) {
  const rootId = testId ?? (id ? `gradient-${id}` : "gradient-field");
  const editorId = useId();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [selected, setSelected] = useState(0);
  const trackRef = useRef<HTMLDivElement>(null);
  const stopRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const dragRef = useRef<{ pointerId: number; index: number } | null>(null);
  const focusIndexRef = useRef<number | null>(null);

  const times = stops.map((stop) => stop.t);
  const last = stops.length - 1;
  const selectedIndex = clampNumber(selected, 0, Math.max(0, last));
  const selectedStop = stops[selectedIndex];
  const endpoint = selectedIndex === 0 || selectedIndex === last;
  const insertion = widestGapInsertion(times);
  const canAdd = !disabled && stops.length < maxStops && insertion !== null;
  const canRemove = !disabled && !endpoint && stops.length > minStops;
  const background = gradientBackground(stops);

  useEffect(() => {
    const index = focusIndexRef.current;
    if (index === null) return;
    focusIndexRef.current = null;
    stopRefs.current[index]?.focus();
  });

  const replaceStop = (index: number, stop: GradientStop) => {
    const next = stops.map((entry) => ({ t: entry.t, color: [...entry.color] }) as GradientStop);
    next[index] = stop;
    onChange(next);
  };

  const moveStop = (index: number, t: number) => {
    const stop = stops[index]!;
    replaceStop(index, { t: clampKeyTime(times, index, t), color: [...stop.color] });
  };

  const insertStop = (index: number, t: number) => {
    const next = stops.map((entry) => ({ t: entry.t, color: [...entry.color] }) as GradientStop);
    next.splice(index, 0, { t, color: sampleGradient(stops, t) });
    setSelected(index);
    onChange(next);
  };

  const removeStop = (index: number) => {
    if (disabled || index <= 0 || index >= last || stops.length <= minStops) return;
    setSelected(index - 1);
    onChange(stops.filter((_, stopIndex) => stopIndex !== index));
  };

  const pointerToTime = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return null;
    return (clientX - rect.left) / rect.width;
  };

  const onStopPointerDown = (event: PointerEvent<HTMLButtonElement>, index: number) => {
    setSelected(index);
    if (disabled) return;
    dragRef.current = { pointerId: event.pointerId, index };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const onStopPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.index === 0 || drag.index === last) return;
    const t = pointerToTime(event.clientX);
    if (t !== null) moveStop(drag.index, t);
  };

  const endStopDrag = (event: PointerEvent<HTMLButtonElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  };

  const onStopKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (disabled) return;
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowRight": {
        const step =
          (event.shiftKey ? STOP_STEP_LARGE : STOP_STEP) * (event.key === "ArrowLeft" ? -1 : 1);
        moveStop(index, stops[index]!.t + step);
        break;
      }
      case "Delete":
      case "Backspace":
        if (index > 0 && index < last && stops.length > minStops) {
          focusIndexRef.current = index - 1;
          removeStop(index);
        }
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const onBarDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (disabled || stops.length >= maxStops) return;
    const raw = pointerToTime(event.clientX);
    if (raw === null) return;
    const t = roundKeyTime(clampNumber(raw, 0, 1));
    const index = stops.findIndex((stop) => stop.t > t);
    if (index <= 0) return;
    if (t - stops[index - 1]!.t < KEY_NEIGHBOUR_GAP || stops[index]!.t - t < KEY_NEIGHBOUR_GAP) {
      return;
    }
    insertStop(index, t);
  };

  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid={rootId}>
      <button
        type="button"
        id={id}
        className="flex min-h-[var(--chrome-row,28px)] w-full min-w-0 touch-pan-y items-center gap-2 rounded-md border border-input bg-control px-2 outline-none hover:bg-accent focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:min-h-11"
        aria-expanded={expanded}
        aria-controls={editorId}
        aria-label={`${ariaLabel} Gradient, ${stops.length} ${stops.length === 1 ? "Stop" : "Stops"}`}
        onClick={() => setExpanded((open) => !open)}
        data-testid={`${rootId}-toggle`}
      >
        <span
          aria-hidden="true"
          className="h-5 min-w-0 flex-1 rounded-sm border border-input"
          style={{ background }}
        />
        <ChevronDownIcon
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground",
            expanded && "rotate-180",
          )}
        />
      </button>
      {expanded ? (
        <div id={editorId} className="flex min-w-0 flex-col gap-1">
          <div className="relative isolate touch-none px-3.5 pointer-coarse:px-[22px]">
            <div ref={trackRef} className="relative">
              <div
                className="h-6 rounded-sm border border-input"
                style={{ background }}
                onDoubleClick={onBarDoubleClick}
                data-testid={`${rootId}-bar`}
              />
              <div
                role="group"
                aria-label={`${ariaLabel} Gradient Stops`}
                className="relative h-7 pointer-coarse:h-11"
              >
                {stops.map((stop, index) => {
                  const isSelected = index === selectedIndex;
                  return (
                    // Raw handles: the phone PropertyGrid rule would force Button primitives to 44×44.
                    <button
                      key={index}
                      ref={(element) => {
                        stopRefs.current[index] = element;
                      }}
                      type="button"
                      className={cn(
                        "absolute top-0 flex h-7 w-7 -translate-x-1/2 touch-none flex-col items-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default pointer-coarse:h-11 pointer-coarse:w-[min(44px,var(--gradient-stop-hit))]",
                        isSelected && "z-10",
                      )}
                      style={
                        {
                          left: `${stop.t * 100}%`,
                          "--gradient-stop-hit": `${keyHitFraction(times, index) * 100}%`,
                        } as CSSProperties
                      }
                      aria-label={`Stop ${index + 1}, Location ${stop.t.toFixed(2)}`}
                      aria-pressed={isSelected}
                      disabled={disabled}
                      onPointerDown={(event) => onStopPointerDown(event, index)}
                      onPointerMove={onStopPointerMove}
                      onPointerUp={endStopDrag}
                      onPointerCancel={endStopDrag}
                      onFocus={() => setSelected(index)}
                      onKeyDown={(event) => onStopKeyDown(event, index)}
                      data-testid={`${rootId}-stop-${index}`}
                    >
                      <span aria-hidden="true" className="h-1 w-0.5 bg-foreground" />
                      <span
                        aria-hidden="true"
                        className={cn(
                          "size-3 rounded-sm border",
                          isSelected
                            ? "border-primary ring-2 ring-ring/50"
                            : "border-foreground",
                        )}
                        style={{ background: swatchBackground(stop.color) }}
                      />
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="pointer-coarse:min-h-11"
              disabled={!canAdd}
              onClick={() => {
                if (insertion) insertStop(insertion.index, insertion.t);
              }}
              data-testid={`${rootId}-add`}
            >
              <PlusIcon data-icon="inline-start" aria-hidden="true" />
              Add Stop
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="pointer-coarse:min-h-11"
              disabled={!canRemove}
              onClick={() => removeStop(selectedIndex)}
              data-testid={`${rootId}-remove`}
            >
              <Trash2Icon data-icon="inline-start" aria-hidden="true" />
              Remove Stop
            </Button>
          </div>
          {selectedStop ? (
            <>
              <div className="flex min-w-0 items-center gap-1">
                <span aria-hidden="true" className="shrink-0 text-xs text-muted-foreground">
                  Location
                </span>
                <div className="w-24 pointer-coarse:w-32">
                  <NumericDragField
                    aria-label={`${ariaLabel} Stop ${selectedIndex + 1} Location`}
                    value={selectedStop.t}
                    min={0}
                    max={1}
                    sensitivity={0.005}
                    disabled={disabled || endpoint}
                    onChange={(t) => moveStop(selectedIndex, t)}
                    data-testid={`${rootId}-location`}
                  />
                </div>
              </div>
              <ColorField
                aria-label={`${ariaLabel} Stop ${selectedIndex + 1}`}
                value={[selectedStop.color[0], selectedStop.color[1], selectedStop.color[2]]}
                alpha={selectedStop.color[3]}
                disabled={disabled}
                onChange={([r, g, b]) =>
                  replaceStop(selectedIndex, {
                    t: selectedStop.t,
                    color: [r, g, b, selectedStop.color[3]],
                  })
                }
                onAlphaChange={(alpha) =>
                  replaceStop(selectedIndex, {
                    t: selectedStop.t,
                    color: [
                      selectedStop.color[0],
                      selectedStop.color[1],
                      selectedStop.color[2],
                      alpha,
                    ],
                  })
                }
                data-testid={`${rootId}-color`}
              />
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
