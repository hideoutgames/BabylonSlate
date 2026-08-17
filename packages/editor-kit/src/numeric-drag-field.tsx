import { useCallback, useRef, useState, type PointerEvent } from "react";
import { cn } from "@babylonslate/ui/lib/utils";
import { parseNumberInput } from "./parse-number-input";
import { useSelectAllOnActivate } from "./select-all-on-activate";

export interface NumericDragFieldProps {
  /** Visual scrub-handle text (axis letter). Omit for a compact unlabeled handle. */
  label?: string;
  id?: string;
  value: number;
  /** World units (or degrees) per pixel of horizontal drag. */
  sensitivity?: number;
  step?: number;
  min?: number;
  max?: number;
  disabled?: boolean;
  /** Fired once when a scrub starts, so callers can open one undo entry. */
  onDragBegin?: () => void;
  onChange: (value: number) => void;
  /** Fired once when a scrub ends, so callers can close the undo entry. */
  onDragEnd?: (value: number) => void;
  /** Axis color token: X red, Y green, Z blue. */
  accent?: "x" | "y" | "z";
  "data-testid"?: string;
}

function clamp(value: number, min?: number, max?: number): number {
  let next = value;
  if (typeof min === "number") next = Math.max(min, next);
  if (typeof max === "number") next = Math.min(max, next);
  return next;
}

/**
 * Touch-first numeric entry: drag the label to scrub, tap the field to type.
 * Scrubs report begin/end so one gesture coalesces into one undo entry.
 */
export function NumericDragField({
  label,
  id,
  value,
  sensitivity = 0.01,
  min,
  max,
  disabled = false,
  onDragBegin,
  onChange,
  onDragEnd,
  accent,
  "data-testid": testId,
}: NumericDragFieldProps) {
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startValue: number;
    latest: number;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const selectAll = useSelectAllOnActivate();

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLSpanElement>) => {
      if (disabled) return;
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startValue: value,
        latest: value,
      };
      setDragging(true);
      onDragBegin?.();
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    [disabled, onDragBegin, value],
  );

  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLSpanElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const delta = (event.clientX - drag.startX) * sensitivity;
      const next = clamp(drag.startValue + delta, min, max);
      drag.latest = next;
      onChange(next);
    },
    [max, min, onChange, sensitivity],
  );

  const endDrag = useCallback(
    (event: PointerEvent<HTMLSpanElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      dragRef.current = null;
      setDragging(false);
      onDragEnd?.(drag.latest);
    },
    [onDragEnd],
  );

  return (
    <div className="flex min-h-[var(--chrome-row,28px)] min-w-0 items-center gap-1">
      <span
        className={cn(
          "w-3 shrink-0 cursor-ew-resize touch-none select-none text-[10px] font-semibold",
          accent === "x" && "text-axis-x",
          accent === "y" && "text-axis-y",
          accent === "z" && "text-axis-z",
          !accent && "text-muted-foreground",
          dragging && !accent && "text-foreground",
        )}
        data-testid={testId ? `${testId}-scrub` : undefined}
        aria-hidden="true"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {label}
      </span>
      <input
        type="text"
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        id={id}
        className="h-[var(--chrome-row,28px)] min-h-[var(--chrome-row,28px)] w-full min-w-0 rounded-md border border-input bg-background px-1 text-xs"
        aria-label={label || undefined}
        data-testid={testId}
        disabled={disabled}
        value={draft ?? String(value)}
        onChange={(event) => {
          setDraft(event.target.value);
          const parsed = parseNumberInput(event.target.value);
          if (parsed === undefined) return;
          onChange(clamp(parsed, min, max));
        }}
        onFocus={selectAll.onFocus}
        onPointerDown={selectAll.onPointerDown}
        onPointerUp={selectAll.onPointerUp}
        onMouseUp={selectAll.onMouseUp}
        onBlur={() => {
          selectAll.onBlur();
          setDraft(null);
          onDragEnd?.(value);
        }}
      />
    </div>
  );
}
