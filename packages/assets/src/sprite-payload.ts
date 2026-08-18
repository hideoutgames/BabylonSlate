/** Normalized AABB in texture/frame space. Default is the full image. */
export interface SpriteCollision {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const DEFAULT_SPRITE_COLLISION: SpriteCollision = {
  x: 0,
  y: 0,
  width: 1,
  height: 1,
};

export const DEFAULT_SPRITE_PIVOT = { x: 0.5, y: 0.5 } as const;

export interface SpriteFrame {
  name: string;
  u: number;
  v: number;
  uSize: number;
  vSize: number;
  durationMs: number;
  pivot: { x: number; y: number };
  /** Normalized AABB; omitted documents parse as the full image. */
  collision?: SpriteCollision;
  /** Pixel rect in the packed atlas, when packed from loose frames. */
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface SpriteClip {
  name: string;
  frames: string[];
}

export interface SpritePayload {
  textureGuid: string | null;
  pixelsPerUnit: number;
  frames: SpriteFrame[];
  clips: SpriteClip[];
}

export function createDefaultSpritePayload(): SpritePayload {
  return {
    textureGuid: null,
    pixelsPerUnit: 100,
    frames: [
      {
        name: "idle",
        u: 0,
        v: 0,
        uSize: 1,
        vSize: 1,
        durationMs: 100,
        pivot: { x: 0.5, y: 0.5 },
        collision: { ...DEFAULT_SPRITE_COLLISION },
      },
    ],
    clips: [{ name: "Idle", frames: ["idle"] }],
  };
}

/** Pick the clip frame at normalised time in `[0, 1]` (inclusive of the last frame). */
export function spriteClipFrameAt(
  payload: SpritePayload,
  clipName: string,
  normalisedTime: number,
): SpriteFrame | null {
  const named = new Map(payload.frames.map((frame) => [frame.name, frame]));
  const clip =
    payload.clips.find((entry) => entry.name === clipName) ?? payload.clips[0];
  const frames = (clip?.frames ?? [])
    .map((name) => named.get(name))
    .filter((frame): frame is SpriteFrame => frame !== undefined);
  const sequence = frames.length > 0 ? frames : payload.frames;
  if (sequence.length === 0) return null;
  const t = Number.isFinite(normalisedTime)
    ? Math.min(1, Math.max(0, normalisedTime))
    : 0;
  if (t >= 1) return sequence[sequence.length - 1]!;
  const total = sequence.reduce(
    (sum, frame) => sum + Math.max(1, frame.durationMs),
    0,
  );
  let cursor = t * total;
  for (const frame of sequence) {
    cursor -= Math.max(1, frame.durationMs);
    if (cursor < 0) return frame;
  }
  return sequence[sequence.length - 1]!;
}

export function spriteFrameUvs(
  frame: SpriteFrame,
): { u0: number; v0: number; u1: number; v1: number } {
  return {
    u0: frame.u,
    v0: frame.v,
    u1: frame.u + frame.uSize,
    v1: frame.v + frame.vSize,
  };
}

export function packedRectsToFrames(
  pack: {
    width: number;
    height: number;
    rects: Array<{
      id: string;
      x: number;
      y: number;
      width: number;
      height: number;
    }>;
  },
  durationMs = 100,
): SpriteFrame[] {
  return pack.rects.map((rect) => ({
    name: rect.id,
    u: pack.width > 0 ? rect.x / pack.width : 0,
    v: pack.height > 0 ? rect.y / pack.height : 0,
    uSize: pack.width > 0 ? rect.width / pack.width : 1,
    vSize: pack.height > 0 ? rect.height / pack.height : 1,
    durationMs,
    pivot: { x: 0.5, y: 0.5 },
    collision: { ...DEFAULT_SPRITE_COLLISION },
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  }));
}

function clampUnit(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

/** Parse a normalized AABB, defaulting missing/invalid values to the full image. */
export function parseSpriteCollision(value: unknown): SpriteCollision {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_SPRITE_COLLISION };
  }
  const source = value as Record<string, unknown>;
  const x = clampUnit(typeof source.x === "number" ? source.x : 0, 0);
  const y = clampUnit(typeof source.y === "number" ? source.y : 0, 0);
  const width = clampUnit(
    typeof source.width === "number" ? source.width : 1,
    1,
  );
  const height = clampUnit(
    typeof source.height === "number" ? source.height : 1,
    1,
  );
  return {
    x,
    y,
    width: Math.max(0.001, Math.min(1 - x, width)),
    height: Math.max(0.001, Math.min(1 - y, height)),
  };
}

export function parseSpritePivot(value: unknown): { x: number; y: number } {
  if (!value || typeof value !== "object") {
    return { x: DEFAULT_SPRITE_PIVOT.x, y: DEFAULT_SPRITE_PIVOT.y };
  }
  const source = value as Record<string, unknown>;
  return {
    x: clampUnit(
      typeof source.x === "number" ? source.x : DEFAULT_SPRITE_PIVOT.x,
      DEFAULT_SPRITE_PIVOT.x,
    ),
    y: clampUnit(
      typeof source.y === "number" ? source.y : DEFAULT_SPRITE_PIVOT.y,
      DEFAULT_SPRITE_PIVOT.y,
    ),
  };
}

/**
 * Map a normalized frame AABB (minus pivot) into a 2D box collider.
 * Y is up: texture v=0 is the top of the image.
 */
export function spriteCollisionToBox2d(options: {
  collision: SpriteCollision;
  pivot: { x: number; y: number };
  pixelWidth: number;
  pixelHeight: number;
  pixelsPerUnit: number;
}): {
  translation: { x: number; y: number };
  halfExtents: { x: number; y: number };
} {
  const ppu = options.pixelsPerUnit > 0 ? options.pixelsPerUnit : 100;
  const worldWidth = Math.max(0, options.pixelWidth) / ppu;
  const worldHeight = Math.max(0, options.pixelHeight) / ppu;
  const collision = parseSpriteCollision(options.collision);
  const pivot = parseSpritePivot(options.pivot);
  const centerX = collision.x + collision.width / 2;
  const centerY = collision.y + collision.height / 2;
  return {
    translation: {
      x: (centerX - pivot.x) * worldWidth,
      y: (pivot.y - centerY) * worldHeight,
    },
    halfExtents: {
      x: (collision.width * worldWidth) / 2,
      y: (collision.height * worldHeight) / 2,
    },
  };
}
