import { useId, useState } from "react";
import { FieldError } from "@babylonslate/ui/components/field";
import { SelectAllInput } from "./select-all-input";

export type ColorValue = [number, number, number];

export function colorToHex(color: ColorValue): string {
  const channel = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value * 255)))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(color[0])}${channel(color[1])}${channel(color[2])}`;
}

export function parseHexColor(text: string): ColorValue | undefined {
  const raw = text.trim().replace(/^#/, "");
  const hex = /^[0-9a-fA-F]{3}$/.test(raw)
    ? raw
        .split("")
        .map((digit) => digit + digit)
        .join("")
    : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return undefined;
  return [
    Number.parseInt(hex.slice(0, 2), 16) / 255,
    Number.parseInt(hex.slice(2, 4), 16) / 255,
    Number.parseInt(hex.slice(4, 6), 16) / 255,
  ];
}

export function colorFromHex(hex: string): ColorValue {
  return parseHexColor(hex) ?? [0, 0, 0];
}

export interface ColorFieldProps {
  id?: string;
  "aria-label"?: string;
  value: ColorValue | null;
  onChange: (value: ColorValue) => void;
  disabled?: boolean;
  "data-testid"?: string;
}

/** Native color swatch plus a pasteable `#rrggbb` field. */
export function ColorField({
  id,
  "aria-label": ariaLabel,
  value,
  onChange,
  disabled,
  "data-testid": testId,
}: ColorFieldProps) {
  const committed = value ? colorToHex(value) : "";
  const swatch = value ? colorToHex(value) : "#000000";
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const errorId = useId();

  return (
    <div
      className="flex min-w-0 flex-col gap-1"
      data-invalid={error || undefined}
    >
      <div className="flex min-w-0 items-center gap-2">
        <input
          type="color"
          id={id}
          aria-label={ariaLabel}
          className="min-h-[var(--chrome-row,28px)] w-10 shrink-0 rounded-md border border-input bg-background"
          value={swatch}
          disabled={disabled}
          onChange={(event) => {
            setDraft(null);
            setError(false);
            onChange(colorFromHex(event.target.value));
          }}
          data-testid={testId}
        />
        <SelectAllInput
          id={id ? `${id}-hex` : undefined}
          className="min-h-[var(--chrome-row,28px)] min-w-0 flex-1"
          value={draft ?? committed}
          disabled={disabled}
          spellCheck={false}
          autoComplete="off"
          aria-label={ariaLabel ? `${ariaLabel} Hex` : "Hex"}
          aria-invalid={error || undefined}
          aria-describedby={error ? errorId : undefined}
          data-testid={testId ? `${testId}-hex` : undefined}
          onChange={(event) => {
            const raw = event.target.value;
            setDraft(raw);
            setError(false);
            const parsed = parseHexColor(raw);
            if (parsed) onChange(parsed);
          }}
          onBlur={() => {
            if (draft?.trim() && !parseHexColor(draft)) setError(true);
            setDraft(null);
          }}
        />
      </div>
      {error && (
        <FieldError id={errorId}>
          Use a 3- or 6-digit hex color. Restored the last valid color.
        </FieldError>
      )}
    </div>
  );
}
