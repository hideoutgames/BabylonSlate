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
import { NumericDragField } from "./numeric-drag-field";

/** One curve key; `t` runs 0–1 along the axis. */
export type CurveKey = { t: number; value: number };

export interface CurveFieldProps {
  id?: string;
  "aria-label": string;
  /** Host-normalized: sorted, first `t` = 0, last `t` = 1. */
  value: readonly CurveKey[];
  /** Called per drag move and per discrete action. */
  onChange: (next: CurveKey[]) => void;
  valueMin?: number;
  valueMax?: number;
  axisLabels?: { start: string; end: string };
  minKeys?: number;
  maxKeys?: number;
  defaultExpanded?: boolean;
  disabled?: boolean;
  /** Defaults to `curve-<id>`. */
  "data-testid"?: string;
}

/** Interior keys stay at least this far from their neighbours. */
export const KEY_NEIGHBOUR_GAP = 0.01;
const KEY_STEP = 0.01;
const KEY_STEP_LARGE = 0.1;

export function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Rounds away float noise from repeated nudges before values are stored. */
export function roundKeyTime(t: number): number {
  return Math.round(t * 10000) / 10000;
}

/** Endpoints stay at 0 and 1; interior keys stay between their neighbours. */
export function clampKeyTime(
  times: readonly number[],
  index: number,
  t: number,
): number {
  const last = times.length - 1;
  if (index <= 0) return 0;
  if (index >= last) return 1;
  const low = times[index - 1]! + KEY_NEIGHBOUR_GAP;
  const high = times[index + 1]! - KEY_NEIGHBOUR_GAP;
  if (low > high) return times[index]!;
  return roundKeyTime(clampNumber(t, low, high));
}

/** Midpoint of the widest gap, or null when no gap can take another key. */
export function widestGapInsertion(
  times: readonly number[],
): { index: number; t: number } | null {
  let best = -1;
  let index = -1;
  for (let i = 0; i + 1 < times.length; i += 1) {
    const gap = times[i + 1]! - times[i]!;
    if (gap > best) {
      best = gap;
      index = i + 1;
    }
  }
  if (index < 0 || best < KEY_NEIGHBOUR_GAP * 2) return null;
  return { index, t: roundKeyTime((times[index - 1]! + times[index]!) / 2) };
}

/**
 * Coarse-pointer hit width as a fraction of the track: the distance to the
 * nearest neighbour, so enlarged boxes centred on each key never overlap.
 */
export function keyHitFraction(times: readonly number[], index: number): number {
  const left = index > 0 ? times[index]! - times[index - 1]! : 1;
  const right = index < times.length - 1 ? times[index + 1]! - times[index]! : 1;
  return Math.max(0, Math.min(left, right, 1));
}

/** Linear sample, matching how Babylon lerps factor gradients between keys. */
export function sampleCurve(keys: readonly CurveKey[], t: number): number {
  if (keys.length === 0) return 0;
  if (t <= keys[0]!.t) return keys[0]!.value;
  for (let i = 1; i < keys.length; i += 1) {
    const next = keys[i]!;
    if (t <= next.t) {
      const previous = keys[i - 1]!;
      const span = next.t - previous.t;
      const f = span > 0 ? (t - previous.t) / span : 0;
      return previous.value + (next.value - previous.value) * f;
    }
  }
  return keys[keys.length - 1]!.value;
}

function niceCeil(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const fraction = value / magnitude;
  const nice =
    fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return nice * magnitude;
}

function curveDomain(
  keys: readonly CurveKey[],
  valueMin: number | undefined,
  valueMax: number | undefined,
): [number, number] {
  const values = keys.map((key) => key.value);
  const bottom = Number.isFinite(valueMin)
    ? valueMin!
    : Math.min(0, ...values);
  const top = Number.isFinite(valueMax)
    ? valueMax!
    : niceCeil(Math.max(1, ...values) * 1.25);
  return top > bottom ? [bottom, top] : [bottom, bottom + 1];
}

function formatAxisValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function curvePoints(
  keys: readonly CurveKey[],
  [bottom, top]: [number, number],
  height: number,
): string {
  return keys
    .map((key) => {
      const y = (1 - clampNumber((key.value - bottom) / (top - bottom), 0, 1)) * height;
      return `${key.t * 100},${y}`;
    })
    .join(" ");
}

/**
 * Compact curve row (inline sparkline) that expands into a key editor: drag
 * keys, Add / Remove Key, and numeric Time / Value for the selected key.
 */
export function CurveField({
  id,
  "aria-label": ariaLabel,
  value: keys,
  onChange,
  valueMin,
  valueMax,
  axisLabels = { start: "Birth", end: "Death" },
  minKeys = 2,
  maxKeys = 8,
  defaultExpanded = false,
  disabled = false,
  "data-testid": testId,
}: CurveFieldProps) {
  const rootId = testId ?? (id ? `curve-${id}` : "curve-field");
  const editorId = useId();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [selected, setSelected] = useState(0);
  // The frame stays still while a key is dragged; it refits on release.
  const [frozenDomain, setFrozenDomain] = useState<[number, number] | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const keyRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const dragRef = useRef<{ pointerId: number; index: number } | null>(null);
  const focusIndexRef = useRef<number | null>(null);

  const domain = frozenDomain ?? curveDomain(keys, valueMin, valueMax);
  const [bottom, top] = domain;
  const span = top - bottom;
  const times = keys.map((key) => key.t);
  const last = keys.length - 1;
  const selectedIndex = clampNumber(selected, 0, Math.max(0, last));
  const selectedKey = keys[selectedIndex];
  const endpoint = selectedIndex === 0 || selectedIndex === last;
  const insertion = widestGapInsertion(times);
  const canAdd = !disabled && keys.length < maxKeys && insertion !== null;
  const canRemove = !disabled && !endpoint && keys.length > minKeys;

  useEffect(() => {
    const index = focusIndexRef.current;
    if (index === null) return;
    focusIndexRef.current = null;
    keyRefs.current[index]?.focus();
  });

  const clampValue = (value: number) =>
    clampNumber(
      value,
      Number.isFinite(valueMin) ? valueMin! : Number.NEGATIVE_INFINITY,
      Number.isFinite(valueMax) ? valueMax! : Number.POSITIVE_INFINITY,
    );

  const updateKey = (index: number, t: number, value: number) => {
    const next = keys.map((key) => ({ ...key }));
    next[index] = { t: clampKeyTime(times, index, t), value: clampValue(value) };
    onChange(next);
  };

  const insertKey = (index: number, t: number) => {
    const next = keys.map((key) => ({ ...key }));
    next.splice(index, 0, { t, value: clampValue(sampleCurve(keys, t)) });
    setSelected(index);
    onChange(next);
  };

  const removeKey = (index: number) => {
    if (disabled || index <= 0 || index >= last || keys.length <= minKeys) return;
    setSelected(index - 1);
    onChange(keys.filter((_, keyIndex) => keyIndex !== index));
  };

  const pointerToKey = (clientX: number, clientY: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    return {
      t: (clientX - rect.left) / rect.width,
      value: bottom + (1 - (clientY - rect.top) / rect.height) * span,
    };
  };

  const onKeyPointerDown = (event: PointerEvent<HTMLButtonElement>, index: number) => {
    setSelected(index);
    if (disabled) return;
    dragRef.current = { pointerId: event.pointerId, index };
    setFrozenDomain(domain);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const onKeyPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const point = pointerToKey(event.clientX, event.clientY);
    if (point) updateKey(drag.index, point.t, point.value);
  };

  const endKeyDrag = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setFrozenDomain(null);
  };

  const onKeyKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (disabled) return;
    const key = keys[index]!;
    const large = event.shiftKey;
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowRight": {
        const step = (large ? KEY_STEP_LARGE : KEY_STEP) * (event.key === "ArrowLeft" ? -1 : 1);
        updateKey(index, key.t + step, key.value);
        break;
      }
      case "ArrowUp":
      case "ArrowDown": {
        const step = (span / 100) * (large ? 10 : 1) * (event.key === "ArrowDown" ? -1 : 1);
        updateKey(index, key.t, key.value + step);
        break;
      }
      case "Delete":
      case "Backspace":
        if (index > 0 && index < last && keys.length > minKeys) {
          focusIndexRef.current = index - 1;
          removeKey(index);
        }
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const onTrackDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (disabled || keys.length >= maxKeys) return;
    if ((event.target as Element).closest("button")) return;
    const point = pointerToKey(event.clientX, event.clientY);
    if (!point) return;
    const t = roundKeyTime(clampNumber(point.t, 0, 1));
    const index = keys.findIndex((key) => key.t > t);
    if (index <= 0) return;
    const previous = keys[index - 1]!.t;
    const next = keys[index]!.t;
    if (t - previous < KEY_NEIGHBOUR_GAP || next - t < KEY_NEIGHBOUR_GAP) return;
    insertKey(index, t);
  };

  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid={rootId}>
      <button
        type="button"
        id={id}
        className="flex min-h-[var(--chrome-row,28px)] w-full min-w-0 touch-pan-y items-center gap-2 rounded-md border border-input bg-control px-2 outline-none hover:bg-accent focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:min-h-11"
        aria-expanded={expanded}
        aria-controls={editorId}
        aria-label={`${ariaLabel} Curve, ${keys.length} ${keys.length === 1 ? "Key" : "Keys"}`}
        onClick={() => setExpanded((open) => !open)}
        data-testid={`${rootId}-toggle`}
      >
        <svg
          className="h-4 min-w-0 flex-1 overflow-visible"
          viewBox="0 0 100 16"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          <polygon
            className="fill-muted"
            points={`0,16 ${curvePoints(keys, domain, 16)} 100,16`}
          />
          <polyline
            className="fill-none stroke-foreground"
            strokeWidth={1.5}
            vectorEffect="non-scaling-stroke"
            points={curvePoints(keys, domain, 16)}
          />
        </svg>
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
          <div
            className="relative isolate h-24 touch-none rounded-md border border-input bg-control pointer-coarse:h-32"
            data-testid={`${rootId}-plot`}
          >
            <span className="pointer-events-none absolute top-0.5 left-1 text-[10px] tabular-nums text-muted-foreground">
              {formatAxisValue(top)}
            </span>
            <span className="pointer-events-none absolute bottom-0.5 left-1 text-[10px] tabular-nums text-muted-foreground">
              {formatAxisValue(bottom)}
            </span>
            <div
              ref={trackRef}
              role="group"
              aria-label={`${ariaLabel} Curve Keys`}
              className="absolute inset-3.5 pointer-coarse:inset-[22px]"
              onDoubleClick={onTrackDoubleClick}
            >
              <svg
                className="pointer-events-none absolute inset-0 size-full overflow-visible"
                viewBox="0 0 100 100"
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                {[0, 50, 100].map((y) => (
                  <line
                    key={y}
                    x1={0}
                    x2={100}
                    y1={y}
                    y2={y}
                    className="stroke-border"
                    strokeWidth={1}
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
                <polyline
                  className="fill-none stroke-foreground"
                  strokeWidth={2}
                  vectorEffect="non-scaling-stroke"
                  points={curvePoints(keys, domain, 100)}
                />
              </svg>
              {keys.map((key, index) => {
                const isSelected = index === selectedIndex;
                const y = 1 - clampNumber((key.value - bottom) / span, 0, 1);
                return (
                  // Raw handles: the phone PropertyGrid rule would force Button primitives to 44×44.
                  <button
                    key={index}
                    ref={(element) => {
                      keyRefs.current[index] = element;
                    }}
                    type="button"
                    className={cn(
                      "absolute flex size-7 -translate-x-1/2 -translate-y-1/2 touch-none items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default pointer-coarse:h-11 pointer-coarse:w-[min(44px,var(--curve-key-hit))]",
                      isSelected && "z-10",
                    )}
                    style={
                      {
                        left: `${key.t * 100}%`,
                        top: `${y * 100}%`,
                        "--curve-key-hit": `${keyHitFraction(times, index) * 100}%`,
                      } as CSSProperties
                    }
                    aria-label={`Key ${index + 1}, Time ${key.t.toFixed(2)}, Value ${key.value.toFixed(2)}`}
                    aria-pressed={isSelected}
                    disabled={disabled}
                    onPointerDown={(event) => onKeyPointerDown(event, index)}
                    onPointerMove={onKeyPointerMove}
                    onPointerUp={endKeyDrag}
                    onPointerCancel={endKeyDrag}
                    onFocus={() => setSelected(index)}
                    onKeyDown={(event) => onKeyKeyDown(event, index)}
                    data-testid={`${rootId}-key-${index}`}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "size-2.5 rounded-full border-2",
                        isSelected
                          ? "border-primary bg-primary ring-2 ring-ring/50"
                          : "border-foreground bg-background",
                      )}
                    />
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex justify-between text-[10px] text-muted-foreground">
            <span>{axisLabels.start}</span>
            <span>{axisLabels.end}</span>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="pointer-coarse:min-h-11"
              disabled={!canAdd}
              onClick={() => {
                if (insertion) insertKey(insertion.index, insertion.t);
              }}
              data-testid={`${rootId}-add`}
            >
              <PlusIcon data-icon="inline-start" aria-hidden="true" />
              Add Key
            </Button>
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="pointer-coarse:min-h-11"
              disabled={!canRemove}
              onClick={() => removeKey(selectedIndex)}
              data-testid={`${rootId}-remove`}
            >
              <Trash2Icon data-icon="inline-start" aria-hidden="true" />
              Remove Key
            </Button>
          </div>
          {selectedKey ? (
            <div className="grid grid-cols-2 gap-1">
              <div className="flex min-w-0 items-center gap-1">
                <span aria-hidden="true" className="shrink-0 text-xs text-muted-foreground">
                  Time
                </span>
                <div className="min-w-0 flex-1">
                  <NumericDragField
                    aria-label={`${ariaLabel} Key ${selectedIndex + 1} Time`}
                    value={selectedKey.t}
                    min={0}
                    max={1}
                    sensitivity={0.005}
                    disabled={disabled || endpoint}
                    onChange={(t) => updateKey(selectedIndex, t, selectedKey.value)}
                    data-testid={`${rootId}-time`}
                  />
                </div>
              </div>
              <div className="flex min-w-0 items-center gap-1">
                <span aria-hidden="true" className="shrink-0 text-xs text-muted-foreground">
                  Value
                </span>
                <div className="min-w-0 flex-1">
                  <NumericDragField
                    aria-label={`${ariaLabel} Key ${selectedIndex + 1} Value`}
                    value={selectedKey.value}
                    min={valueMin}
                    max={valueMax}
                    sensitivity={span / 200}
                    disabled={disabled}
                    onChange={(value) => updateKey(selectedIndex, selectedKey.t, value)}
                    data-testid={`${rootId}-value`}
                  />
                </div>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
