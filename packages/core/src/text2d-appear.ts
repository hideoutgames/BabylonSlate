import {
  parseRichText,
  type ParseRichTextDefaults,
  type RichTextEffects,
  type RichTextStyle,
} from "./rich-text";

export const ENGINE_TEXT2D_APPEAR_MODE_ENUM_ID = "engine:Text2DAppearMode";
export const ENGINE_TEXT2D_APPEAR_TRANSITION_ENUM_ID = "engine:Text2DAppearTransition";
export const ENGINE_TEXT2D_APPEAR_START_ENUM_ID = "engine:Text2DAppearStart";

export const TEXT2D_APPEAR_MODES = ["fade", "scale", "slide", "instant"] as const;
export type Text2DAppearMode = (typeof TEXT2D_APPEAR_MODES)[number];
export const TEXT2D_APPEAR_MODE_LABELS: Record<Text2DAppearMode, string> = {
  fade: "Fade", scale: "Scale", slide: "Slide", instant: "Instant",
};

export const TEXT2D_APPEAR_TRANSITIONS = [
  "instant", "linear",
  "quadIn", "quadOut", "quadInOut",
  "cubicIn", "cubicOut", "cubicInOut",
  "quartIn", "quartOut", "quartInOut",
  "quintIn", "quintOut", "quintInOut",
  "sineIn", "sineOut", "sineInOut",
  "expoIn", "expoOut", "expoInOut",
  "circIn", "circOut", "circInOut",
  "backIn", "backOut", "backInOut",
  "elasticIn", "elasticOut", "elasticInOut",
  "bounceIn", "bounceOut", "bounceInOut",
] as const;
export type Text2DAppearTransition = (typeof TEXT2D_APPEAR_TRANSITIONS)[number];
export const TEXT2D_APPEAR_TRANSITION_LABELS: Record<Text2DAppearTransition, string> = {
  instant: "Instant", linear: "Linear",
  quadIn: "Quad In", quadOut: "Quad Out", quadInOut: "Quad In Out",
  cubicIn: "Cubic In", cubicOut: "Cubic Out", cubicInOut: "Cubic In Out",
  quartIn: "Quart In", quartOut: "Quart Out", quartInOut: "Quart In Out",
  quintIn: "Quint In", quintOut: "Quint Out", quintInOut: "Quint In Out",
  sineIn: "Sine In", sineOut: "Sine Out", sineInOut: "Sine In Out",
  expoIn: "Expo In", expoOut: "Expo Out", expoInOut: "Expo In Out",
  circIn: "Circ In", circOut: "Circ Out", circInOut: "Circ In Out",
  backIn: "Back In", backOut: "Back Out", backInOut: "Back In Out",
  elasticIn: "Elastic In", elasticOut: "Elastic Out", elasticInOut: "Elastic In Out",
  bounceIn: "Bounce In", bounceOut: "Bounce Out", bounceInOut: "Bounce In Out",
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

function bounceOut(t: number): number {
  const scale = 7.5625;
  const period = 2.75;
  if (t < 1 / period) return scale * t * t;
  if (t < 2 / period) return scale * (t - 1.5 / period) ** 2 + 0.75;
  if (t < 2.5 / period) return scale * (t - 2.25 / period) ** 2 + 0.9375;
  return scale * (t - 2.625 / period) ** 2 + 0.984375;
}

/** Named easing on a normalized input; Back and Elastic preserve their overshoot. */
export function sampleText2DAppearTransition(transition: Text2DAppearTransition, value: number): number {
  const t = normalized(value);
  if (t === 0 || t === 1) return t;
  const back = 1.70158;
  switch (transition) {
    case "instant": return 1;
    case "linear": return t;
    case "quadIn": return t * t;
    case "quadOut": return 1 - (1 - t) ** 2;
    case "quadInOut": return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    case "cubicIn": return t ** 3;
    case "cubicOut": return 1 - (1 - t) ** 3;
    case "cubicInOut": return t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
    case "quartIn": return t ** 4;
    case "quartOut": return 1 - (1 - t) ** 4;
    case "quartInOut": return t < 0.5 ? 8 * t ** 4 : 1 - (-2 * t + 2) ** 4 / 2;
    case "quintIn": return t ** 5;
    case "quintOut": return 1 - (1 - t) ** 5;
    case "quintInOut": return t < 0.5 ? 16 * t ** 5 : 1 - (-2 * t + 2) ** 5 / 2;
    case "sineIn": return 1 - Math.cos(t * Math.PI / 2);
    case "sineOut": return Math.sin(t * Math.PI / 2);
    case "sineInOut": return (1 - Math.cos(Math.PI * t)) / 2;
    case "expoIn": return 2 ** (10 * t - 10);
    case "expoOut": return 1 - 2 ** (-10 * t);
    case "expoInOut": return t < 0.5 ? 2 ** (20 * t - 10) / 2 : (2 - 2 ** (-20 * t + 10)) / 2;
    case "circIn": return 1 - Math.sqrt(1 - t * t);
    case "circOut": return Math.sqrt(1 - (t - 1) ** 2);
    case "circInOut": return t < 0.5
      ? (1 - Math.sqrt(1 - (2 * t) ** 2)) / 2
      : (Math.sqrt(1 - (-2 * t + 2) ** 2) + 1) / 2;
    case "backIn": return (back + 1) * t ** 3 - back * t * t;
    case "backOut": return 1 + (back + 1) * (t - 1) ** 3 + back * (t - 1) ** 2;
    case "backInOut": {
      const amount = back * 1.525;
      return t < 0.5
        ? (2 * t) ** 2 * ((amount + 1) * 2 * t - amount) / 2
        : ((2 * t - 2) ** 2 * ((amount + 1) * (2 * t - 2) + amount) + 2) / 2;
    }
    case "elasticIn": return -(2 ** (10 * t - 10)) * Math.sin((t * 10 - 10.75) * 2 * Math.PI / 3);
    case "elasticOut": return 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * 2 * Math.PI / 3) + 1;
    case "elasticInOut": return t < 0.5
      ? -(2 ** (20 * t - 10) * Math.sin((20 * t - 11.125) * 2 * Math.PI / 4.5)) / 2
      : 2 ** (-20 * t + 10) * Math.sin((20 * t - 11.125) * 2 * Math.PI / 4.5) / 2 + 1;
    case "bounceIn": return 1 - bounceOut(1 - t);
    case "bounceOut": return bounceOut(t);
    case "bounceInOut": return t < 0.5 ? (1 - bounceOut(1 - 2 * t)) / 2 : (1 + bounceOut(2 * t - 1)) / 2;
  }
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
