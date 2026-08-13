import { Toggle } from "@babylonslate/ui/components/toggle";

export const DEFAULT_FLAG_BIT_COUNT = 32;

export interface FlagsFieldProps {
  value: number;
  onChange: (value: number) => void;
  /** Number of bits shown. Defaults to 32. */
  bitCount?: number;
  /** Per-bit labels; missing entries fall back to the bit index. */
  labels?: readonly string[];
  disabled?: boolean;
  id?: string;
  "data-testid"?: string;
}

export function hasFlagBit(value: number, bit: number): boolean {
  return (value & (1 << bit)) !== 0;
}

export function setFlagBit(value: number, bit: number, on: boolean): number {
  const mask = 1 << bit;
  return on ? value | mask : value & ~mask;
}

/** Compact bitmask toggles (Unity LayerMask / Godot @export_flags). */
export function FlagsField({
  value,
  onChange,
  bitCount = DEFAULT_FLAG_BIT_COUNT,
  labels,
  disabled,
  id,
  "data-testid": testId,
}: FlagsFieldProps) {
  const bits = Array.from({ length: bitCount }, (_, bit) => bit);
  return (
    <div
      id={id}
      role="group"
      className="flex flex-wrap gap-1"
      data-testid={testId}
    >
      {bits.map((bit) => {
        const label = labels?.[bit] ?? String(bit);
        const pressed = hasFlagBit(value, bit);
        return (
          <Toggle
            key={bit}
            variant="outline"
            size="touch"
            pressed={pressed}
            disabled={disabled}
            aria-label={label}
            aria-pressed={pressed}
            onPressedChange={(next) => onChange(setFlagBit(value, bit, next))}
            data-testid={testId ? `${testId}-bit-${bit}` : undefined}
          >
            {label}
          </Toggle>
        );
      })}
    </div>
  );
}
