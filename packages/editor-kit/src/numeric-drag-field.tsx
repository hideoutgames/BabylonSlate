import { useCallback, useId, useRef, useState, type PointerEvent } from "react";
import { FieldError } from "@babylonslate/ui/components/field";
import { GripVerticalIcon } from "lucide-react";
import { cn } from "@babylonslate/ui/lib/utils";
import {
  evaluateNumericExpression,
  formatNumericDisplay,
} from "./numeric-expression";
import { useSelectAllOnActivate } from "./select-all-on-activate";

export interface NumericDragFieldProps {
  /** Visual scrub-handle text (axis letter). Omit for a compact unlabeled handle. */
  label?: string;
  id?: string;
  "aria-label"?: string;
  value: number;
  /** Different selected values; `value` remains the scrub/expression baseline. */
  mixed?: boolean;
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
  "aria-label": ariaLabel,
  value,
  mixed = false,
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
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const baselineRef = useRef(value);
  const selectAll = useSelectAllOnActivate();

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLSpanElement>) => {
      if (disabled) return;
      setError(null);
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
    <div
      className="flex min-w-0 flex-col gap-1"
      data-invalid={Boolean(error) || undefined}
    >
      <div
        className="numeric-drag-field relative flex min-h-[var(--chrome-row,28px)] min-w-0 items-center gap-1"
        data-scalar={!label || undefined}
      >
        <span
          className={cn(
            "shrink-0 cursor-ew-resize touch-none select-none text-[10px] font-semibold",
            label
              ? label.length <= 1
                ? "w-3"
                : null
              : "absolute right-1 inset-y-0 flex w-4 items-center justify-center",
            accent === "x" && "text-axis-x",
            accent === "y" && "text-axis-y",
            accent === "z" && "text-axis-z",
            !accent && "text-muted-foreground",
            dragging && !accent && "text-foreground",
          )}
          data-testid={testId ? `${testId}-scrub` : undefined}
          data-numeric-scrub=""
          title="Drag To Adjust"
          aria-hidden="true"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          {label || <GripVerticalIcon className="size-3" />}
        </span>
        <input
          data-slot="input"
          type="text"
          inputMode="text"
          autoComplete="off"
          spellCheck={false}
          id={id}
          className={cn(
            "h-[var(--chrome-row,28px)] min-h-[var(--chrome-row,28px)] w-full min-w-0 rounded-md border border-input bg-control px-1.5 py-0 text-xs",
            !label && "pr-6",
          )}
          aria-label={ariaLabel ?? (label || undefined)}
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={error ? errorId : undefined}
          data-testid={testId}
          disabled={disabled}
          value={draft ?? (mixed ? "" : formatNumericDisplay(value))}
          placeholder={mixed ? "Mixed" : undefined}
          onChange={(event) => {
            const raw = event.target.value;
            if (draft === null) baselineRef.current = value;
            setDraft(raw);
            setError(null);
            const parsed = evaluateNumericExpression(raw, baselineRef.current);
            if (parsed === undefined) return;
            onChange(clamp(parsed, min, max));
          }}
          onFocus={selectAll.onFocus}
          onPointerDown={selectAll.onPointerDown}
          onPointerUp={selectAll.onPointerUp}
          onMouseUp={selectAll.onMouseUp}
          onKeyDown={(event) => {
            if (
              event.key !== "Enter" ||
              event.nativeEvent.isComposing ||
              event.keyCode === 229
            )
              return;
            event.preventDefault();
            event.currentTarget.blur();
          }}
          onBlur={() => {
            selectAll.onBlur();
            if (
              draft?.trim() &&
              evaluateNumericExpression(draft, baselineRef.current) ===
                undefined
            ) {
              setError("Invalid expression. Restored the last valid value.");
            }
            setDraft(null);
            onDragEnd?.(value);
          }}
        />
      </div>
      {error && <FieldError id={errorId}>{error}</FieldError>}
    </div>
  );
}
