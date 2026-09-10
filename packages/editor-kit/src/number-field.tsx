import { useId, useRef, useState, type ComponentProps } from "react";
import {
  FieldDescription,
  FieldError,
} from "@babylonslate/ui/components/field";
import { Input } from "@babylonslate/ui/components/input";
import { parseNumberInput } from "./parse-number-input";
import { evaluateNumericExpression } from "./numeric-expression";
import { SelectAllInput } from "./select-all-input";

export interface NumberFieldProps extends Omit<
  ComponentProps<typeof Input>,
  "type" | "value" | "onChange" | "min" | "max"
> {
  value: number;
  onChange: (value: number) => void;
  /** Enter confirms only valid drafts, after clamping to the configured range. */
  onEnter?: (value: number) => void;
  min?: number;
  max?: number;
}

function clamp(value: number, min?: number, max?: number): number {
  let next = value;
  if (typeof min === "number") next = Math.max(min, next);
  if (typeof max === "number") next = Math.min(max, next);
  return next;
}

function inRange(value: number, min?: number, max?: number): boolean {
  if (typeof min === "number" && value < min) return false;
  if (typeof max === "number" && value > max) return false;
  return true;
}

/**
 * Numeric text field that keeps an empty draft while typing.
 * Commits live when the draft is a finite in-range number or expression;
 * Enter / blur restores the last value or clamps an out-of-range draft.
 */
export function NumberField({
  value,
  onChange,
  min,
  max,
  onBlur,
  onKeyDown,
  onEnter,
  ...props
}: NumberFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    message: string;
    invalid: boolean;
  } | null>(null);
  const feedbackId = useId();
  const baselineRef = useRef(value);
  const parseDraft = (raw: string) =>
    parseNumberInput(raw) ??
    evaluateNumericExpression(raw, baselineRef.current);
  const finishDraft = (): number | undefined => {
    const parsed = parseDraft(draft ?? String(value));
    setDraft(null);
    if (parsed === undefined) {
      if (draft?.trim())
        setFeedback({
          message:
            "Enter a number or expression. Restored the last valid value.",
          invalid: true,
        });
      return undefined;
    }
    const next = clamp(parsed, min, max);
    if (next !== parsed)
      setFeedback({
        message: `Adjusted to ${next} to stay within the allowed range.`,
        invalid: false,
      });
    if (next !== value) onChange(next);
    return next;
  };

  return (
    <div
      className="flex min-w-0 flex-col gap-1"
      data-invalid={feedback?.invalid || undefined}
    >
      <SelectAllInput
        {...props}
        aria-describedby={
          [props["aria-describedby"], feedback ? feedbackId : undefined]
            .filter(Boolean)
            .join(" ") || undefined
        }
        aria-invalid={feedback?.invalid || props["aria-invalid"]}
        type="text"
        inputMode="text"
        autoComplete="off"
        spellCheck={false}
        min={min}
        max={max}
        value={draft ?? String(value)}
        onChange={(event) => {
          const raw = event.target.value;
          if (draft === null) baselineRef.current = value;
          setDraft(raw);
          setFeedback(null);
          const parsed = parseDraft(raw);
          if (parsed === undefined) return;
          if (!inRange(parsed, min, max)) return;
          onChange(parsed);
        }}
        onBlur={(event) => {
          finishDraft();
          onBlur?.(event);
        }}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          if (
            event.key !== "Enter" ||
            event.defaultPrevented ||
            event.nativeEvent.isComposing ||
            event.keyCode === 229
          )
            return;
          event.preventDefault();
          if (onEnter) {
            const next = finishDraft();
            if (next !== undefined) onEnter(next);
          } else {
            event.currentTarget.blur();
          }
        }}
      />
      {feedback?.invalid ? (
        <FieldError id={feedbackId}>{feedback.message}</FieldError>
      ) : feedback ? (
        <FieldDescription id={feedbackId} role="status">
          {feedback.message}
        </FieldDescription>
      ) : null}
    </div>
  );
}
