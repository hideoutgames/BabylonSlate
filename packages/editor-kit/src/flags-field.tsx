import { Toggle } from "@babylonslate/ui/components/toggle";

export const DEFAULT_FLAG_BIT_COUNT = 32;
/** Masks are unsigned 32-bit integers; JavaScript bit operators stop at bit 31. */
const MAX_FLAG_BIT_COUNT = 32;

export interface FlagsFieldProps {
  value: number;
  onChange: (value: number) => void;
  /** Number of bits shown. Defaults to and is capped at 32. */
  bitCount?: number;
  /** Per-bit labels; missing entries fall back to the bit index. */
  labels?: readonly string[];
  disabled?: boolean;
  id?: string;
  "data-testid"?: string;
}

function flagMask(bit: number): number {
  if (!Number.isInteger(bit) || bit < 0 || bit >= MAX_FLAG_BIT_COUNT) {
    throw new RangeError(`Flag bit ${bit} is outside 0-${MAX_FLAG_BIT_COUNT - 1}.`);
  }
  return 2 ** bit;
}

export function hasFlagBit(value: number, bit: number): boolean {
  return (value & flagMask(bit)) !== 0;
}

/** Returns the unsigned mask, so bit 31 stays positive (2147483648). */
export function setFlagBit(value: number, bit: number, on: boolean): number {
  const mask = flagMask(bit);
  return (on ? value | mask : value & ~mask) >>> 0;
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
  const bits = Array.from(
    { length: Math.max(0, Math.min(bitCount, MAX_FLAG_BIT_COUNT)) },
    (_, bit) => bit,
  );
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
