import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { Button } from "@haptic/ui/components/button";
import { cn } from "@haptic/ui/lib/utils";
import { ColorField } from "./color-field";
import {
  clampKeyTimeTo,
  clampNumber,
  curveValue,
  editorKeys,
  insertionTime,
  keyAt,
  roundTime,
  type CurveEditorConstraints,
  type CurveEditorValue,
  type EditorKey,
} from "./curve-editor-model";
import { NumericDragField } from "./numeric-drag-field";
import { gradientBackground, gradientDomain, swatchBackground, type Rgba } from "./gradient-colors";

export interface GradientEditorProps {
  /** A Color Curve value. */
  value: CurveEditorValue;
  /** Called once per finished stop drag or Location edit, and per colour edit or discrete action. */
  onChange: (next: ReturnType<typeof curveValue>) => void;
  "aria-label": string;
  constraints?: CurveEditorConstraints;
  disabled?: boolean;
  /** Prefix for the editor's test ids. */
  "data-testid"?: string;
}

/**
 * Gradient bar with stops for a Color Curve: drag a stop along the bar, arrows nudge (Shift ×10),
 * Delete removes, double-click adds; **Add Stop**, **Remove Stop**, and Location and Color (with alpha)
 * for the selected stop. Each stop is a curve key, so its interpolation and tangents are kept.
 */
export function GradientEditor({
  value,
  onChange,
  "aria-label": ariaLabel,
  constraints = {},
  disabled = false,
  "data-testid": testId = "gradient-editor",
}: GradientEditorProps) {
  const committed = editorKeys("color", value);
  const [draft, setDraft] = useState<EditorKey[] | null>(null);
  const keys = draft ?? committed;
  const [selected, setSelected] = useState(0);
  const [frozenDomain, setFrozenDomain] = useState<[number, number] | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const stopRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const dragRef = useRef<{ pointerId: number; index: number } | null>(null);
  const focusIndexRef = useRef<number | null>(null);

  const domain = frozenDomain ?? gradientDomain(keys, constraints.fixedTime);
  const [start, end] = domain;
  const span = end - start;
  const last = keys.length - 1;
  const selectedIndex = clampNumber(selected, 0, Math.max(0, last));
  const selectedKey = keys[selectedIndex];
  const locked = (index: number) => !!constraints.lockEnds && (index === 0 || index === last);
  const minKeys = constraints.minKeys ?? 0;
  const maxKeys = constraints.maxKeys ?? Number.POSITIVE_INFINITY;
  const insertion = insertionTime(keys, constraints);
  const canAdd = !disabled && keys.length < maxKeys && insertion !== null;
  const canRemove = !disabled && !!selectedKey && !locked(selectedIndex) && keys.length > minKeys;
  const background = gradientBackground(curveValue("color", keys, value.Before, value.After), domain);

  useEffect(() => {
    const index = focusIndexRef.current;
    if (index === null) return;
    focusIndexRef.current = null;
    stopRefs.current[index]?.focus();
  });

  const emit = (next: readonly EditorKey[]) => onChange(curveValue("color", next, value.Before, value.After));
  const clone = (source: readonly EditorKey[]) =>
    source.map((key) => ({ ...key, values: [...key.values], arrive: [...key.arrive], leave: [...key.leave] }));
  const moved = (source: readonly EditorKey[], index: number, time: number) => {
    const next = clone(source);
    next[index]!.time = clampKeyTimeTo(next, index, time, constraints);
    return next;
  };

  const insertStop = (time: number) => {
    if (disabled || keys.length >= maxKeys) return;
    const t = roundTime(time);
    const gap = constraints.keyGap ?? 0.001;
    if (keys.some((key) => Math.abs(key.time - t) < gap)) return;
    if (constraints.lockEnds && (t <= 0 || t >= 1)) return;
    const index = keys.findIndex((key) => key.time > t);
    const at = index < 0 ? keys.length : index;
    const next = clone(keys);
    next.splice(at, 0, keyAt("color", keys, t, constraints));
    setSelected(at);
    emit(next);
  };

  const removeStop = (index: number) => {
    if (disabled || locked(index) || keys.length <= minKeys) return;
    setSelected(Math.max(0, index - 1));
    emit(keys.filter((_, keyIndex) => keyIndex !== index));
  };

  const pointerToTime = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return null;
    return start + ((clientX - rect.left) / rect.width) * span;
  };

  const onStopPointerDown = (event: PointerEvent<HTMLButtonElement>, index: number) => {
    setSelected(index);
    if (disabled) return;
    dragRef.current = { pointerId: event.pointerId, index };
    setFrozenDomain(domain);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const onStopPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || locked(drag.index)) return;
    const time = pointerToTime(event.clientX);
    if (time !== null) setDraft(moved(draft ?? committed, drag.index, clampNumber(time, start, end)));
  };

  const endStopDrag = (event: PointerEvent<HTMLButtonElement>, commit: boolean) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setFrozenDomain(null);
    if (commit && draft && JSON.stringify(draft) !== JSON.stringify(committed)) emit(draft);
    setDraft(null);
  };

  const onStopKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (disabled) return;
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowRight": {
        const step = (constraints.fixedTime ? 0.01 : span / 100) * (event.shiftKey ? 10 : 1) * (event.key === "ArrowLeft" ? -1 : 1);
        emit(moved(keys, index, keys[index]!.time + step));
        break;
      }
      case "Delete":
      case "Backspace":
        if (!locked(index) && keys.length > minKeys) {
          focusIndexRef.current = Math.max(0, index - 1);
          removeStop(index);
        }
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const onBarDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    const time = pointerToTime(event.clientX);
    if (time !== null) insertStop(clampNumber(time, start, end));
  };

  const setColor = (index: number, color: Rgba) => {
    const next = clone(keys);
    next[index]!.values = [...color];
    emit(next);
  };

  const hitFraction = (index: number) => {
    const left = index > 0 ? (keys[index]!.time - keys[index - 1]!.time) / span : 1;
    const right = index < last ? (keys[index + 1]!.time - keys[index]!.time) / span : 1;
    return Math.max(0, Math.min(left, right, 1));
  };
  const bound = (time: number) => (selectedKey ? clampKeyTimeTo(keys, selectedIndex, time, constraints) : time);
  const selectedColor = (selectedKey?.values ?? [0, 0, 0, 0]) as unknown as Rgba;

  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid={testId}>
      <div className="relative isolate touch-none px-3.5 pointer-coarse:px-[22px]">
        <div ref={trackRef} className="relative">
          <div className="h-6 rounded-sm border border-input" style={{ background }} onDoubleClick={onBarDoubleClick} data-testid={`${testId}-bar`} />
          <div role="group" aria-label={`${ariaLabel} Gradient Stops`} className="relative h-7 pointer-coarse:h-11">
            {keys.map((key, index) => {
              const isSelected = index === selectedIndex;
              return (
                // Raw handles: Button primitives grow to 44×44 in touch rows; these cap at the gap to their neighbours.
                <button
                  key={index}
                  ref={(element) => { stopRefs.current[index] = element; }}
                  type="button"
                  className={cn(
                    "absolute top-0 flex h-7 w-7 -translate-x-1/2 touch-none flex-col items-center rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-default pointer-coarse:h-11 pointer-coarse:w-[min(44px,var(--gradient-stop-hit))]",
                    isSelected && "z-10",
                  )}
                  style={{ left: `${((key.time - start) / span) * 100}%`, "--gradient-stop-hit": `${hitFraction(index) * 100}%` } as CSSProperties}
                  aria-label={`Stop ${index + 1}, Location ${key.time.toFixed(2)}`}
                  aria-pressed={isSelected}
                  disabled={disabled}
                  onPointerDown={(event) => onStopPointerDown(event, index)}
                  onPointerMove={onStopPointerMove}
                  onPointerUp={(event) => endStopDrag(event, true)}
                  onPointerCancel={(event) => endStopDrag(event, false)}
                  onFocus={() => setSelected(index)}
                  onKeyDown={(event) => onStopKeyDown(event, index)}
                  data-testid={`${testId}-stop-${index}`}
                >
                  <span aria-hidden="true" className="h-1 w-0.5 bg-foreground" />
                  <span
                    aria-hidden="true"
                    className={cn("size-3 rounded-sm border", isSelected ? "border-primary ring-2 ring-ring/50" : "border-foreground")}
                    style={{ background: swatchBackground(key.values as unknown as Rgba) }}
                  />
                </button>
              );
            })}
          </div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <Button type="button" variant="outline" size="xs" className="pointer-coarse:min-h-11" disabled={!canAdd}
          onClick={() => { if (insertion) insertStop(insertion.time); }} data-testid={`${testId}-add`}>
          <PlusIcon data-icon="inline-start" aria-hidden="true" />
          Add Stop
        </Button>
        <Button type="button" variant="outline" size="xs" className="pointer-coarse:min-h-11" disabled={!canRemove}
          onClick={() => removeStop(selectedIndex)} data-testid={`${testId}-remove`}>
          <Trash2Icon data-icon="inline-start" aria-hidden="true" />
          Remove Stop
        </Button>
      </div>
      {selectedKey ? (
        <>
          <div className="flex min-w-0 items-center gap-1">
            <span aria-hidden="true" className="shrink-0 text-xs text-muted-foreground">Location</span>
            <div className="w-24 pointer-coarse:w-32">
              <NumericDragField
                aria-label={`${ariaLabel} Stop ${selectedIndex + 1} Location`}
                value={selectedKey.time}
                min={bound(Number.NEGATIVE_INFINITY)}
                max={bound(Number.POSITIVE_INFINITY)}
                sensitivity={span / 200}
                disabled={disabled || locked(selectedIndex)}
                onChange={(time) => setDraft(moved(draft ?? committed, selectedIndex, time))}
                onDragEnd={(time) => { setDraft(null); emit(moved(committed, selectedIndex, time)); }}
                data-testid={`${testId}-location`}
              />
            </div>
          </div>
          <ColorField
            aria-label={`${ariaLabel} Stop ${selectedIndex + 1}`}
            value={[selectedColor[0], selectedColor[1], selectedColor[2]]}
            alpha={selectedColor[3]}
            disabled={disabled}
            onChange={([r, g, b]) => setColor(selectedIndex, [r, g, b, selectedColor[3]])}
            onAlphaChange={(alpha) => setColor(selectedIndex, [selectedColor[0], selectedColor[1], selectedColor[2], alpha])}
            data-testid={`${testId}-color`}
          />
        </>
      ) : null}
    </div>
  );
}
