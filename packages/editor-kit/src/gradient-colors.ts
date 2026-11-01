import {
  clampNumber,
  curveValue,
  editorKeys,
  sampleChannel,
  type CurveEditorValue,
  type EditorKey,
} from "./curve-editor-model";

/** Alpha checkerboard from theme tokens, visible in both schemes. */
const CHECKERBOARD =
  "conic-gradient(var(--muted) 0.25turn, var(--border) 0 0.5turn, var(--muted) 0 0.75turn, var(--border) 0) 0 0 / 8px 8px";

export type Rgba = readonly [number, number, number, number];

export function cssRgba([r, g, b, a]: Rgba): string {
  const channel = (value: number) => Math.round(clampNumber(value, 0, 1) * 255);
  return `rgb(${channel(r)} ${channel(g)} ${channel(b)} / ${clampNumber(a, 0, 1)})`;
}

export function swatchBackground(color: Rgba): string {
  return `linear-gradient(${cssRgba(color)}, ${cssRgba(color)}), ${CHECKERBOARD}`;
}

/** The time span a gradient bar shows: 0–1, widened to every key. */
export function gradientDomain(keys: readonly EditorKey[], fixedTime = false): [number, number] {
  if (fixedTime || keys.length === 0) return [0, 1];
  const start = Math.min(0, keys[0]!.time);
  const end = Math.max(1, keys[keys.length - 1]!.time);
  return end > start ? [start, end] : [start, start + 1];
}

/**
 * The colours of a Color Curve across `domain`, over the alpha checkerboard. Sampled with the runtime's
 * interpolation, so eased and Auto keys show as they play.
 */
export function gradientBackground(value: CurveEditorValue, domain: [number, number] = [0, 1], samples = 24): string {
  const keys = editorKeys("color", value);
  if (keys.length === 0) return swatchBackground([0, 0, 0, 0]);
  if (keys.length === 1) return swatchBackground(keys[0]!.values as unknown as Rgba);
  const curve = curveValue("color", keys, value.Before, value.After);
  const [start, end] = domain;
  const stops: string[] = [];
  for (let step = 0; step <= samples; step += 1) {
    const time = start + ((end - start) * step) / samples;
    const color = [0, 1, 2, 3].map((channel) => sampleChannel("color", curve, channel, time)) as unknown as Rgba;
    stops.push(`${cssRgba(color)} ${(step / samples) * 100}%`);
  }
  return `linear-gradient(to right, ${stops.join(", ")}), ${CHECKERBOARD}`;
}

