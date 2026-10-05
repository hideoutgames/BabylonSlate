import {
  parseRichText,
  type ParseRichTextDefaults,
  type RichTextEffects,
  type RichTextStyle,
} from "./rich-text";
import { EASING_CURVES, EASING_CURVE_LABELS, sampleEasingCurve } from "./easing";

export const ENGINE_TEXT2D_APPEAR_MODE_ENUM_ID = "engine:Text2DAppearMode";
export const ENGINE_TEXT2D_APPEAR_TRANSITION_ENUM_ID = "engine:Text2DAppearTransition";
export const ENGINE_TEXT2D_APPEAR_START_ENUM_ID = "engine:Text2DAppearStart";

export const TEXT2D_APPEAR_MODES = ["fade", "scale", "slide", "instant"] as const;
export type Text2DAppearMode = (typeof TEXT2D_APPEAR_MODES)[number];
export const TEXT2D_APPEAR_MODE_LABELS: Record<Text2DAppearMode, string> = {
  fade: "Fade", scale: "Scale", slide: "Slide", instant: "Instant",
};

export const TEXT2D_APPEAR_TRANSITIONS = [
  "instant", ...EASING_CURVES,
] as const;
export type Text2DAppearTransition = (typeof TEXT2D_APPEAR_TRANSITIONS)[number];
export const TEXT2D_APPEAR_TRANSITION_LABELS: Record<Text2DAppearTransition, string> = {
  instant: "Instant", ...EASING_CURVE_LABELS,
};

export const TEXT2D_APPEAR_STARTS = ["revealed", "hidden", "play"] as const;
export type Text2DAppearStart = (typeof TEXT2D_APPEAR_STARTS)[number];
export const TEXT2D_APPEAR_START_LABELS: Record<Text2DAppearStart, string> = {
  revealed: "Fully Revealed", hidden: "Hidden", play: "Play On Start",
};

export const DEFAULT_TEXT2D_APPEAR_INTERVAL = 0.1;
export const DEFAULT_TEXT2D_APPEAR_DURATION = 0.3;

export type Text2DAppearProperties = {
  appearModes: Text2DAppearMode[];
  appearTransition: Text2DAppearTransition;
  appearInterval: number;
  appearDuration: number;
  appearStart: Text2DAppearStart;
  /** Live normalized timeline position, independent of transition overshoot. */
  appearProgress?: number;
};

export function parseText2DAppearModes(value: unknown): Text2DAppearMode[] {
  if (!Array.isArray(value)) return [];
  if (value.includes("instant")) return ["instant"];
  return [...new Set(value.filter((mode): mode is Text2DAppearMode =>
    TEXT2D_APPEAR_MODES.includes(mode as Text2DAppearMode)))];
}

export function parseText2DAppearTransition(value: unknown): Text2DAppearTransition {
  return TEXT2D_APPEAR_TRANSITIONS.includes(value as Text2DAppearTransition)
    ? value as Text2DAppearTransition
    : "cubicOut";
}

function nonnegative(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function normalized(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

export function parseText2DAppearProperties(value: unknown): Text2DAppearProperties {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    appearModes: parseText2DAppearModes(source.appearModes),
    appearTransition: parseText2DAppearTransition(source.appearTransition),
    appearInterval: nonnegative(source.appearInterval, DEFAULT_TEXT2D_APPEAR_INTERVAL),
    appearDuration: nonnegative(source.appearDuration, DEFAULT_TEXT2D_APPEAR_DURATION),
    appearStart: TEXT2D_APPEAR_STARTS.includes(source.appearStart as Text2DAppearStart)
      ? source.appearStart as Text2DAppearStart : "revealed",
    ...(typeof source.appearProgress === "number" && Number.isFinite(source.appearProgress)
      ? { appearProgress: normalized(source.appearProgress) } : {}),
  };
}

/** Named easing on a normalized input; Back and Elastic preserve their overshoot. */
export function sampleText2DAppearTransition(transition: Text2DAppearTransition, value: number): number {
  const t = normalized(value);
  return transition === "instant" ? (t === 0 ? 0 : 1) : sampleEasingCurve(transition, t);
}

type AppearTiming = Pick<Text2DAppearProperties, "appearModes" | "appearTransition" | "appearInterval" | "appearDuration">;

function characterDuration(properties: Partial<AppearTiming>): number {
  return properties.appearModes?.includes("instant") || properties.appearTransition === "instant"
    ? 0 : nonnegative(properties.appearDuration, DEFAULT_TEXT2D_APPEAR_DURATION);
}

/** Full timeline length including the final character's transition, in seconds. */
export function text2DAppearDuration(characterCount: number, properties: Partial<AppearTiming>): number {
  if (!Number.isFinite(characterCount) || characterCount <= 0 || !properties.appearModes?.length) return 0;
  return Math.max(0, Math.floor(characterCount) - 1) *
    nonnegative(properties.appearInterval, DEFAULT_TEXT2D_APPEAR_INTERVAL) + characterDuration(properties);
}

/** The same timeline works forwards and backwards without changing the character order. */
export function text2DCharacterReveal(
  progress: number,
  characterIndex: number,
  characterCount: number,
  properties: Partial<AppearTiming>,
): number {
  const position = normalized(progress);
  if (position === 0 || position === 1) return position;
  const timelineDuration = text2DAppearDuration(characterCount, properties);
  if (timelineDuration === 0) return 0;
  const elapsed = position * timelineDuration;
  const start = Math.max(0, characterIndex) * nonnegative(properties.appearInterval, DEFAULT_TEXT2D_APPEAR_INTERVAL);
  const duration = characterDuration(properties);
  if (duration === 0) return elapsed >= start ? 1 : 0;
  return sampleText2DAppearTransition(
    properties.appearTransition ?? "cubicOut",
    (elapsed - start) / duration,
  );
}

type FormattedStyle = { style: RichTextStyle; effects: RichTextEffects };
export type Text2DFormattedUnit = FormattedStyle & (
  | { kind: "glyph"; ch: string; index: number }
  | { kind: "image"; guid: string; size: number; index: number }
  | { kind: "lineBreak" }
);

const countDefaults: ParseRichTextDefaults = {
  bold: false, italic: false, underline: false, color: [1, 1, 1],
  size: 32, outline: 0, outlineColor: [0, 0, 0],
};

/** Post-format code points share an index with rendering; images occupy one slot. */
export function text2DFormattedUnits(
  text: string,
  defaults: ParseRichTextDefaults = countDefaults,
  options: { rich?: boolean } = {},
): Text2DFormattedUnit[] {
  const spans = options.rich === false ? [{
    kind: "text" as const, text, style: defaults,
    effects: { shake: 0, waveSpeed: 0, waveIntensity: 0, hover: 0, rotate: 0 },
  }] : parseRichText(text, defaults);
  const units: Text2DFormattedUnit[] = [];
  let index = 0;
  for (const span of spans) {
    const formatted = { style: span.style, effects: span.effects };
    if (span.kind === "image") {
      units.push({ ...formatted, kind: "image", guid: span.guid, size: span.size, index: index++ });
      continue;
    }
    for (const ch of span.text) {
      units.push(ch === "\n" ? { ...formatted, kind: "lineBreak" }
        : { ...formatted, kind: "glyph", ch, index: index++ });
    }
  }
  return units;
}

export function countText2DRevealCharacters(properties: { text: string; rich?: boolean }): number {
  let count = 0;
  for (const unit of text2DFormattedUnits(properties.text, countDefaults, properties)) {
    if (unit.kind !== "lineBreak") count += 1;
  }
  return count;
}
