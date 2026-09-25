import {
  PARTICLE_CURVE_MAX_KEYS,
  PARTICLE_CURVE_MIN_KEYS,
} from "@babylonslate/core";
import { resizeParticleValue, type ParticleNumericType } from "./types";

/** One Gradient node stop. `value` has the node's `valueType` width. */
export interface ParticleGradientStop {
  position: number;
  value: number[];
}

/** White to transparent for colors (the Basic default); 1 → 0 otherwise. */
export function defaultParticleGradientStops(
  valueType: ParticleNumericType,
): ParticleGradientStop[] {
  if (valueType === "color") {
    return [
      { position: 0, value: [1, 1, 1, 1] },
      { position: 1, value: [1, 1, 1, 0] },
    ];
  }
  return [
    { position: 0, value: resizeParticleValue([1], valueType) },
    { position: 1, value: resizeParticleValue([0], valueType) },
  ];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Sanitize stored stops: positions clamped to 0–1, values resized to
 * `valueType`, stable-sorted by position and capped at 8. Fewer than 2 usable
 * stops fall back to the defaults.
 */
export function particleGradientStops(
  value: unknown,
  valueType: ParticleNumericType,
): ParticleGradientStop[] {
  if (!Array.isArray(value)) return defaultParticleGradientStops(valueType);
  const stops = value
    .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
    .map((entry): ParticleGradientStop => {
      const record = asRecord(entry);
      const position =
        typeof record.position === "number" && Number.isFinite(record.position)
          ? Math.min(1, Math.max(0, record.position))
          : 0;
      return {
        position,
        value: resizeParticleValue(
          Array.isArray(record.value) ? record.value : undefined,
          valueType,
        ),
      };
    })
    .map((stop, index) => ({ stop, index }))
    .sort((a, b) => a.stop.position - b.stop.position || a.index - b.index)
    .map(({ stop }) => stop)
    .slice(0, PARTICLE_CURVE_MAX_KEYS);
  return stops.length < PARTICLE_CURVE_MIN_KEYS
    ? defaultParticleGradientStops(valueType)
    : stops;
}

/**
 * Stops as lowering emits them. Babylon's gradient returns 0 below its first
 * stop, so a stop at 0 carrying the first value is prepended when missing.
 */
export function canonicalParticleGradientStops(
  stops: readonly ParticleGradientStop[],
): ParticleGradientStop[] {
  const copy = stops.map((stop) => ({ position: stop.position, value: [...stop.value] }));
  const first = copy[0];
  if (first && first.position > 0) copy.unshift({ position: 0, value: [...first.value] });
  return copy;
}
