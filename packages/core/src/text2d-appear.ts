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
export const ENGINE_TEXT2D_APPEAR_SOUND_PLAY_ENUM_ID = "engine:Text2DAppearSoundPlay";

export const TEXT2D_APPEAR_MODES = ["fade", "scale", "slide", "instant"] as const;
export type Text2DAppearMode = (typeof TEXT2D_APPEAR_MODES)[number];
export const TEXT2D_APPEAR_MODE_LABELS: Record<Text2DAppearMode, string> = {
  fade: "Fade", scale: "Scale", slide: "Slide", instant: "Instant",
};

/** A Rich Text 2D Appear Mode Class in the Appear Modes list, by Class id. */
export const TEXT2D_CUSTOM_APPEAR_MODE_PREFIX = "class:";
export type Text2DCustomAppearMode = `class:${string}`;
export type Text2DAppearModeEntry = Text2DAppearMode | Text2DCustomAppearMode;

export function text2DCustomAppearMode(classId: string): Text2DCustomAppearMode {
  return `${TEXT2D_CUSTOM_APPEAR_MODE_PREFIX}${classId}`;
}

/** The Class id of a custom Appear Modes entry, or null for a built-in mode. */
export function text2DCustomAppearModeClassId(entry: unknown): string | null {
  if (typeof entry !== "string" || !entry.startsWith(TEXT2D_CUSTOM_APPEAR_MODE_PREFIX)) return null;
  return entry.slice(TEXT2D_CUSTOM_APPEAR_MODE_PREFIX.length).trim() || null;
}

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

export const TEXT2D_APPEAR_SOUND_PLAYS = [
  "everyLetter", "everyOtherLetter", "everyThirdLetter", "everyFourthLetter", "once", "loop",
] as const;
export type Text2DAppearSoundPlay = (typeof TEXT2D_APPEAR_SOUND_PLAYS)[number];
export const TEXT2D_APPEAR_SOUND_PLAY_LABELS: Record<Text2DAppearSoundPlay, string> = {
  everyLetter: "Every Letter", everyOtherLetter: "Every Other Letter", everyThirdLetter: "Every Third Letter",
  everyFourthLetter: "Every Fourth Letter", once: "Once", loop: "Loop Until Finished",
};
const APPEAR_SOUND_LETTER_STEPS: Partial<Record<Text2DAppearSoundPlay, number>> = {
  everyLetter: 1, everyOtherLetter: 2, everyThirdLetter: 3, everyFourthLetter: 4,
};

const DEFAULT_TEXT2D_APPEAR_INTERVAL = 0.1;
const DEFAULT_TEXT2D_APPEAR_DURATION = 0.3;

export type Text2DAppearProperties = {
  appearModes: Text2DAppearModeEntry[];
  appearTransition: Text2DAppearTransition;
  appearInterval: number;
  appearDuration: number;
  appearStart: Text2DAppearStart;
  /** Plays `appearSoundAssetGuid` while the text reveals forwards. */
  appearSound: boolean;
  appearSoundAssetGuid: string | null;
  appearSoundPlay: Text2DAppearSoundPlay;
  /** Seconds after a letter starts appearing (or the reveal starts) that its sound plays. */
  appearSoundOffset: number;
  /** Live normalized timeline position, independent of transition overshoot. */
  appearProgress?: number;
  /** Live scripted letter poses, `TEXT2D_LETTER_POSE_STRIDE` numbers per reveal character; absent when none. */
  letterPoses?: number[];
};

/** Offset X and Y in pixels (Y up), Scale X and Y, Rotation in degrees, Opacity. */
export const TEXT2D_LETTER_POSE_STRIDE = 6;
export type Text2DLetterPose = {
  offsetX: number; offsetY: number; scaleX: number; scaleY: number; rotation: number; opacity: number;
};
const NO_LETTER_POSES: readonly number[] = [];

/** Whole poses of finite numbers, or none: a malformed list poses nothing. */
export function parseText2DLetterPoses(value: unknown): readonly number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length % TEXT2D_LETTER_POSE_STRIDE !== 0) return NO_LETTER_POSES;
  return value.every((entry) => typeof entry === "number" && Number.isFinite(entry)) ? value as number[] : NO_LETTER_POSES;
}

const letterPoseScratch: Text2DLetterPose = { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1, rotation: 0, opacity: 1 };

/** The pose of one reveal character, at rest when the list does not reach it. Returns a shared object: read it at once. */
export function text2DLetterPoseAt(poses: readonly number[], index: number): Text2DLetterPose {
  const at = index * TEXT2D_LETTER_POSE_STRIDE;
  const posed = index >= 0 && at + TEXT2D_LETTER_POSE_STRIDE <= poses.length;
  letterPoseScratch.offsetX = posed ? poses[at]! : 0;
  letterPoseScratch.offsetY = posed ? poses[at + 1]! : 0;
  letterPoseScratch.scaleX = posed ? poses[at + 2]! : 1;
  letterPoseScratch.scaleY = posed ? poses[at + 3]! : 1;
  letterPoseScratch.rotation = posed ? poses[at + 4]! : 0;
  letterPoseScratch.opacity = posed ? Math.min(1, Math.max(0, poses[at + 5]!)) : 1;
  return letterPoseScratch;
}

function parseText2DAppearModes(value: unknown): Text2DAppearModeEntry[] {
  if (!Array.isArray(value)) return [];
  if (value.includes("instant")) return ["instant"];
  return [...new Set(value.flatMap((mode): Text2DAppearModeEntry[] => {
    if (TEXT2D_APPEAR_MODES.includes(mode as Text2DAppearMode)) return [mode as Text2DAppearMode];
    const classId = text2DCustomAppearModeClassId(mode);
    return classId ? [text2DCustomAppearMode(classId)] : [];
  }))];
}

function parseText2DAppearTransition(value: unknown): Text2DAppearTransition {
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
    appearSound: source.appearSound === true,
    appearSoundAssetGuid: typeof source.appearSoundAssetGuid === "string" && source.appearSoundAssetGuid.trim()
      ? source.appearSoundAssetGuid.trim() : null,
    appearSoundPlay: TEXT2D_APPEAR_SOUND_PLAYS.includes(source.appearSoundPlay as Text2DAppearSoundPlay)
      ? source.appearSoundPlay as Text2DAppearSoundPlay : "everyLetter",
    appearSoundOffset: nonnegative(source.appearSoundOffset, 0),
    ...(typeof source.appearProgress === "number" && Number.isFinite(source.appearProgress)
      ? { appearProgress: normalized(source.appearProgress) } : {}),
    ...(parseText2DLetterPoses(source.letterPoses).length ? { letterPoses: source.letterPoses as number[] } : {}),
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

export type Text2DAppearSoundPlan = {
  assetGuid: string;
  /** Timeline seconds at which a one-shot plays, ascending and distinct. */
  times: number[];
  /** Loop Until Finished: the looping voice's start and stop in timeline seconds. */
  loop: { start: number; stop: number } | null;
};

/**
 * When the appear sound plays along a forward reveal. Letters count visible characters only (inline
 * images included, whitespace skipped); characters that start together share one sound.
 */
export function text2DAppearSoundPlan(
  properties: { text: string; rich?: boolean } & Partial<Text2DAppearProperties>,
): Text2DAppearSoundPlan | null {
  const assetGuid = properties.appearSoundAssetGuid;
  if (properties.appearSound !== true || !assetGuid || !properties.appearModes?.length) return null;
  const units = text2DFormattedUnits(properties.text, countDefaults, properties)
    .filter((unit): unit is Exclude<Text2DFormattedUnit, { kind: "lineBreak" }> => unit.kind !== "lineBreak");
  if (!units.length) return null;
  const offset = nonnegative(properties.appearSoundOffset, 0);
  const play = properties.appearSoundPlay ?? "everyLetter";
  if (play === "loop") {
    const stop = text2DAppearDuration(units.length, properties);
    return stop > offset ? { assetGuid, times: [], loop: { start: offset, stop } } : null;
  }
  if (play === "once") return { assetGuid, times: [offset], loop: null };
  const step = APPEAR_SOUND_LETTER_STEPS[play] ?? 1;
  const interval = nonnegative(properties.appearInterval, DEFAULT_TEXT2D_APPEAR_INTERVAL);
  const times = new Set<number>();
  let letter = 0;
  for (const unit of units) {
    if (unit.kind === "glyph" && !unit.ch.trim()) continue;
    if (letter++ % step === 0) times.add(unit.index * interval + offset);
  }
  return times.size ? { assetGuid, times: [...times], loop: null } : null;
}
