import { pngPixelSize } from "./bytes";
import {
  DEFAULT_SPRITE_COLLISION,
  DEFAULT_SPRITE_PIVOT,
  parseSpriteCollision,
  parseSpritePivot,
  type SpriteCollision,
} from "./sprite-payload";

export interface SpriteAnimationFrame {
  textureGuid: string;
  /** When true, `durationMs` is used instead of payload `frameDurationMs`. */
  durationMsOverride?: boolean;
  durationMs: number;
  pivot: { x: number; y: number };
  collision: SpriteCollision;
  /** Pixel size of the texture, when known. */
  width?: number;
  height?: number;
}

export interface SpriteAnimationPayload {
  /** Default duration for frames that do not set `durationMsOverride`. */
  frameDurationMs: number;
  frames: SpriteAnimationFrame[];
}

export function createDefaultSpriteAnimationPayload(): SpriteAnimationPayload {
  return {
    frameDurationMs: 100,
    frames: [
      {
        textureGuid: "",
        durationMs: 100,
        pivot: { x: DEFAULT_SPRITE_PIVOT.x, y: DEFAULT_SPRITE_PIVOT.y },
        collision: { ...DEFAULT_SPRITE_COLLISION },
      },
    ],
  };
}

function asFinitePositive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

export function parseSpriteAnimationFrame(
  value: unknown,
): SpriteAnimationFrame {
  const defaults = createDefaultSpriteAnimationPayload().frames[0]!;
  const source =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const frame: SpriteAnimationFrame = {
    textureGuid:
      typeof source.textureGuid === "string" ? source.textureGuid : "",
    durationMs: Math.max(1, asFinitePositive(source.durationMs, defaults.durationMs)),
    pivot: parseSpritePivot(source.pivot),
    collision: parseSpriteCollision(source.collision),
  };
  if (source.durationMsOverride === true) {
    frame.durationMsOverride = true;
  }
  if (typeof source.width === "number" && Number.isFinite(source.width)) {
    frame.width = source.width;
  }
  if (typeof source.height === "number" && Number.isFinite(source.height)) {
    frame.height = source.height;
  }
  return frame;
}

function withoutDurationOverride(
  frame: SpriteAnimationFrame,
): SpriteAnimationFrame {
  if (frame.durationMsOverride === undefined) return frame;
  const next = { ...frame };
  delete next.durationMsOverride;
  return next;
}

export function parseSpriteAnimationPayload(
  value: unknown,
): SpriteAnimationPayload {
  const source =
    value && typeof value === "object"
      ? (value as { frames?: unknown; frameDurationMs?: unknown })
      : {};
  const frames = Array.isArray(source.frames)
    ? source.frames.map((frame) => parseSpriteAnimationFrame(frame))
    : [];
  if (frames.length === 0) return createDefaultSpriteAnimationPayload();
  if ("frameDurationMs" in source) {
    return {
      frameDurationMs: Math.max(
        1,
        asFinitePositive(
          source.frameDurationMs,
          createDefaultSpriteAnimationPayload().frameDurationMs,
        ),
      ),
      frames,
    };
  }
  const firstDuration = frames[0]!.durationMs;
  const uniform = frames.every((frame) => frame.durationMs === firstDuration);
  if (uniform) {
    return {
      frameDurationMs: firstDuration,
      frames: frames.map(withoutDurationOverride),
    };
  }
  return {
    frameDurationMs: firstDuration,
    frames: frames.map((frame) =>
      frame.durationMs === firstDuration
        ? withoutDurationOverride(frame)
        : { ...frame, durationMsOverride: true },
    ),
  };
}

export function spriteAnimationFrameDurationMs(
  payload: SpriteAnimationPayload,
  frame: SpriteAnimationFrame,
): number {
  return Math.max(
    1,
    frame.durationMsOverride
      ? frame.durationMs
      : asFinitePositive(payload.frameDurationMs, 100),
  );
}

export function spriteAnimationDurationMs(
  payload: SpriteAnimationPayload,
): number {
  return Math.max(
    1,
    payload.frames.reduce(
      (sum, frame) => sum + spriteAnimationFrameDurationMs(payload, frame),
      0,
    ),
  );
}

/** Pick the frame at normalised time in `[0, 1]` (inclusive of the last frame). */
export function spriteAnimationFrameAt(
  payload: SpriteAnimationPayload,
  normalisedTime: number,
): SpriteAnimationFrame | null {
  if (payload.frames.length === 0) return null;
  const t = Number.isFinite(normalisedTime)
    ? Math.min(1, Math.max(0, normalisedTime))
    : 0;
  if (t >= 1) return payload.frames[payload.frames.length - 1]!;
  const total = spriteAnimationDurationMs(payload);
  let cursor = t * total;
  for (const frame of payload.frames) {
    cursor -= spriteAnimationFrameDurationMs(payload, frame);
    if (cursor < 0) return frame;
  }
  return payload.frames[payload.frames.length - 1]!;
}

export function spriteAnimationFrameStartMs(
  payload: SpriteAnimationPayload,
  index: number,
): number {
  const last = Math.max(0, payload.frames.length - 1);
  const clamped = Math.min(Math.max(0, index), last);
  let sum = 0;
  for (let i = 0; i < clamped; i++) {
    sum += spriteAnimationFrameDurationMs(payload, payload.frames[i]!);
  }
  return sum;
}

export function spriteAnimationPlayhead(
  payload: SpriteAnimationPayload,
  elapsedMs: number,
  loop: boolean,
): { index: number; timeMs: number; finished: boolean } {
  const frames = payload.frames;
  if (frames.length === 0) {
    return { index: 0, timeMs: 0, finished: true };
  }
  const total = spriteAnimationDurationMs(payload);
  const raw = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  if (!loop && raw >= total) {
    return { index: frames.length - 1, timeMs: total, finished: true };
  }
  const timeMs = loop ? raw % total : Math.min(raw, total);
  let cursor = timeMs;
  for (let i = 0; i < frames.length; i++) {
    const duration = spriteAnimationFrameDurationMs(payload, frames[i]!);
    if (cursor < duration) {
      return { index: i, timeMs, finished: false };
    }
    cursor -= duration;
  }
  return { index: frames.length - 1, timeMs, finished: false };
}

export function spriteAnimationTextureGuids(
  payload: SpriteAnimationPayload,
): string[] {
  const guids: string[] = [];
  const seen = new Set<string>();
  for (const frame of payload.frames) {
    if (!frame.textureGuid || seen.has(frame.textureGuid)) continue;
    seen.add(frame.textureGuid);
    guids.push(frame.textureGuid);
  }
  return guids;
}

export type TexturePixelSize = { width: number; height: number };

/** Stamp missing frame width/height from a texture-guid lookup. Authored sizes win. */
export function applyTexturePixelSizesToSpriteAnimation(
  payload: SpriteAnimationPayload,
  sizeForGuid: (guid: string) => TexturePixelSize | null | undefined,
): SpriteAnimationPayload {
  let changed = false;
  const frames = payload.frames.map((frame) => {
    if (!frame.textureGuid) return frame;
    if (frame.width != null && frame.height != null) return frame;
    const size = sizeForGuid(frame.textureGuid);
    if (!size) return frame;
    changed = true;
    return {
      ...frame,
      width: frame.width ?? size.width,
      height: frame.height ?? size.height,
    };
  });
  return changed ? { ...payload, frames } : payload;
}

/** Fill missing Sprite Animation frame sizes from PNG texture bytes. */
export function hydrateSpriteAnimationPixelSizes(
  animations: ReadonlyMap<string, SpriteAnimationPayload>,
  textureBytes: ReadonlyMap<string, Uint8Array>,
): Map<string, SpriteAnimationPayload> {
  const cache = new Map<string, TexturePixelSize | null>();
  const sizeForGuid = (guid: string): TexturePixelSize | null => {
    if (cache.has(guid)) return cache.get(guid) ?? null;
    const bytes = textureBytes.get(guid);
    const size = bytes ? pngPixelSize(bytes) : null;
    cache.set(guid, size);
    return size;
  };
  const next = new Map<string, SpriteAnimationPayload>();
  for (const [guid, payload] of animations) {
    next.set(guid, applyTexturePixelSizesToSpriteAnimation(payload, sizeForGuid));
  }
  return next;
}
