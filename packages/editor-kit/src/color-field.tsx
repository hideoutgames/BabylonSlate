import { useState } from "react";
import { Input } from "@babylonslate/ui/components/input";

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
  const hex =
    /^[0-9a-fA-F]{3}$/.test(raw)
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
  value: ColorValue;
  onChange: (value: ColorValue) => void;
  disabled?: boolean;
  "data-testid"?: string;
}

/** Native color swatch plus a pasteable `#rrggbb` field. */
export function ColorField({
  id,
  value,
  onChange,
  disabled,
  "data-testid": testId,
}: ColorFieldProps) {
  const committed = colorToHex(value);
  const [draft, setDraft] = useState<string | null>(null);

  return (
    <div className="flex min-w-0 items-center gap-2">
      <input
        type="color"
        id={id}
        className="min-h-[var(--chrome-row,28px)] w-10 shrink-0 rounded-md border border-input bg-background"
        value={committed}
        disabled={disabled}
        onChange={(event) => {
          setDraft(null);
          onChange(colorFromHex(event.target.value));
        }}
        data-testid={testId}
      />
      <Input
        id={id ? `${id}-hex` : undefined}
        className="min-h-[var(--chrome-row,28px)] min-w-0 flex-1"
        value={draft ?? committed}
        disabled={disabled}
        spellCheck={false}
        autoComplete="off"
        aria-label="Hex"
        data-testid={testId ? `${testId}-hex` : undefined}
        onChange={(event) => {
          const raw = event.target.value;
          setDraft(raw);
          const parsed = parseHexColor(raw);
          if (parsed) onChange(parsed);
        }}
        onBlur={() => setDraft(null)}
      />
    </div>
  );
}
