import {
  DEFAULT_SPRITE_COLLISION,
  DEFAULT_SPRITE_PIVOT,
  parseSpriteCollision,
  parseSpritePivot,
  type SpriteCollision,
} from "./sprite-payload";

export interface SpriteAnimationFrame {
  textureGuid: string;
  durationMs: number;
  pivot: { x: number; y: number };
  collision: SpriteCollision;
  /** Pixel size of the texture, when known. */
  width?: number;
  height?: number;
}

export interface SpriteAnimationPayload {
  frames: SpriteAnimationFrame[];
}

export function createDefaultSpriteAnimationPayload(): SpriteAnimationPayload {
  return {
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
  if (typeof source.width === "number" && Number.isFinite(source.width)) {
    frame.width = source.width;
  }
  if (typeof source.height === "number" && Number.isFinite(source.height)) {
    frame.height = source.height;
  }
  return frame;
}

export function parseSpriteAnimationPayload(
  value: unknown,
): SpriteAnimationPayload {
  const source =
    value && typeof value === "object"
      ? (value as { frames?: unknown })
      : {};
  const frames = Array.isArray(source.frames)
    ? source.frames.map((frame) => parseSpriteAnimationFrame(frame))
    : [];
  if (frames.length === 0) return createDefaultSpriteAnimationPayload();
  return { frames };
}

export function spriteAnimationDurationMs(
  payload: SpriteAnimationPayload,
): number {
  return Math.max(
    1,
    payload.frames.reduce((sum, frame) => sum + Math.max(1, frame.durationMs), 0),
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
    cursor -= Math.max(1, frame.durationMs);
    if (cursor < 0) return frame;
  }
  return payload.frames[payload.frames.length - 1]!;
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
