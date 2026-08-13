export type ColorValue = [number, number, number];

export function colorToHex(color: ColorValue): string {
  const channel = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value * 255)))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(color[0])}${channel(color[1])}${channel(color[2])}`;
}

export function colorFromHex(hex: string): ColorValue {
  const value = hex.replace("#", "");
  return [
    Number.parseInt(value.slice(0, 2), 16) / 255,
    Number.parseInt(value.slice(2, 4), 16) / 255,
    Number.parseInt(value.slice(4, 6), 16) / 255,
  ];
}

export interface ColorFieldProps {
  id?: string;
  value: ColorValue;
  onChange: (value: ColorValue) => void;
  disabled?: boolean;
  "data-testid"?: string;
}

/** Catalogued wrapper around the native color input. */
export function ColorField({
  id,
  value,
  onChange,
  disabled,
  "data-testid": testId,
}: ColorFieldProps) {
  return (
    <input
      type="color"
      id={id}
      className="min-h-[var(--chrome-row,28px)] w-full rounded-md border border-input bg-background"
      value={colorToHex(value)}
      disabled={disabled}
      onChange={(event) => onChange(colorFromHex(event.target.value))}
      data-testid={testId}
    />
  );
}
