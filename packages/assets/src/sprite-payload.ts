export interface SpriteFrame {
  name: string;
  u: number;
  v: number;
  uSize: number;
  vSize: number;
  durationMs: number;
  pivot: { x: number; y: number };
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
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
  }));
}
