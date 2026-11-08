import { sniffSourceImageSize } from "./image-size";
import {
  DEFAULT_SPRITE_COLLISION,
  DEFAULT_SPRITE_PIVOT,
  parseSpriteCollision,
  parseSpritePivot,
  type SpriteCollision,
  type SpritePayload,
} from "./sprite-payload";
import {
  tilesetAtlasTileCount,
  tilesetTileRect,
  tilesetTileUv,
  type TilesetPayload,
  type TileRect,
  type TileUv,
} from "./tileset-payload";

/**
 * Where a Sprite Animation's frames come from: `frames` lists a Texture or a
 * Sprite per frame; `sheet` cuts every frame from one Texture's grid of cells.
 */
export type SpriteAnimationSource = "frames" | "sheet";

/** The grid a `sheet` animation cuts its frames from, like a Tileset's. */
export interface SpriteAnimationSheet {
  textureGuid: string;
  cellWidth: number;
  cellHeight: number;
  margin: number;
  spacing: number;
}

export interface SpriteAnimationFrame {
  /**
   * The Texture the frame shows. Authored for Texture frames; loaders fill it
   * for Sprite frames (the Sprite's Texture) and sheet cells (the sheet's).
   */
  textureGuid: string;
  /** `frames` source: the Sprite this frame shows, with its pivot and collision. */
  spriteGuid?: string;
  /** `sheet` source: the 1-based cell, counted row by row from the top-left. */
  cell?: number;
  /** When true, `durationMs` is used instead of payload `frameDurationMs`. */
  durationMsOverride?: boolean;
  durationMs: number;
  /** Authored for Texture frames and cells; loaders copy a Sprite frame's from its Sprite. */
  pivot: { x: number; y: number };
  collision: SpriteCollision;
  /** Pixel size of what the frame shows, when known. */
  width?: number;
  height?: number;
  /** Set by loaders for a sheet cell: the cell's UVs (GL, v up); absent shows the whole Texture. */
  uv?: TileUv;
}

export interface SpriteAnimationPayload {
  /** Default duration for frames that do not set `durationMsOverride`. */
  frameDurationMs: number;
  source: SpriteAnimationSource;
  /** Used by the `sheet` source; kept when switching so switching back restores it. */
  sheet: SpriteAnimationSheet;
  frames: SpriteAnimationFrame[];
}

export function createDefaultSpriteAnimationSheet(): SpriteAnimationSheet {
  return { textureGuid: "", cellWidth: 32, cellHeight: 32, margin: 0, spacing: 0 };
}

function defaultFrame(source: SpriteAnimationSource): SpriteAnimationFrame {
  return {
    textureGuid: "",
    ...(source === "sheet" ? { cell: 1 } : {}),
    durationMs: 100,
    pivot: { x: DEFAULT_SPRITE_PIVOT.x, y: DEFAULT_SPRITE_PIVOT.y },
    collision: { ...DEFAULT_SPRITE_COLLISION },
  };
}

export function createDefaultSpriteAnimationPayload(): SpriteAnimationPayload {
  return {
    frameDurationMs: 100,
    source: "frames",
    sheet: createDefaultSpriteAnimationSheet(),
    frames: [defaultFrame("frames")],
  };
}

function asFinitePositive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function nonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function parseUv(value: unknown): TileUv | undefined {
  if (!value || typeof value !== "object") return undefined;
  const uv = value as Record<string, unknown>;
  const keys = ["u0", "v0", "u1", "v1"] as const;
  if (!keys.every((key) => typeof uv[key] === "number" && Number.isFinite(uv[key]))) return undefined;
  return { u0: uv.u0 as number, v0: uv.v0 as number, u1: uv.u1 as number, v1: uv.v1 as number };
}

function parseSpriteAnimationFrame(
  value: unknown,
): SpriteAnimationFrame {
  const defaults = defaultFrame("frames");
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
  if (typeof source.spriteGuid === "string" && source.spriteGuid.length > 0) frame.spriteGuid = source.spriteGuid;
  const cell = nonNegativeInt(source.cell);
  if (cell > 0) frame.cell = cell;
  if (source.durationMsOverride === true) {
    frame.durationMsOverride = true;
  }
  if (typeof source.width === "number" && Number.isFinite(source.width)) {
    frame.width = source.width;
  }
  if (typeof source.height === "number" && Number.isFinite(source.height)) {
    frame.height = source.height;
  }
  const uv = parseUv(source.uv);
  if (uv) frame.uv = uv;
  return frame;
}

function parseSpriteAnimationSheet(value: unknown): SpriteAnimationSheet {
  const defaults = createDefaultSpriteAnimationSheet();
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    textureGuid: typeof source.textureGuid === "string" ? source.textureGuid : "",
    cellWidth: Math.max(1, Math.floor(asFinitePositive(source.cellWidth, defaults.cellWidth))),
    cellHeight: Math.max(1, Math.floor(asFinitePositive(source.cellHeight, defaults.cellHeight))),
    margin: nonNegativeInt(source.margin),
    spacing: nonNegativeInt(source.spacing),
  };
}

export function parseSpriteAnimationPayload(
  value: unknown,
): SpriteAnimationPayload {
  const record =
    value && typeof value === "object"
      ? (value as { frames?: unknown; frameDurationMs?: unknown; source?: unknown; sheet?: unknown })
      : {};
  const source: SpriteAnimationSource = record.source === "sheet" ? "sheet" : "frames";
  const frames = Array.isArray(record.frames)
    ? record.frames.map((frame) => parseSpriteAnimationFrame(frame))
    : [];
  return {
    frameDurationMs: Math.max(1, asFinitePositive(record.frameDurationMs, 100)),
    source,
    sheet: parseSpriteAnimationSheet(record.sheet),
    frames: frames.length > 0 ? frames : [defaultFrame(source)],
  };
}

/** The sheet's grid as a Tileset, so cells share the Tileset's cell rects and UVs. */
export function spriteAnimationSheetGrid(
  sheet: SpriteAnimationSheet,
  atlas: { width: number; height: number },
): TilesetPayload {
  return {
    textureGuid: sheet.textureGuid || null,
    tileWidth: sheet.cellWidth,
    tileHeight: sheet.cellHeight,
    margin: sheet.margin,
    spacing: sheet.spacing,
    atlasWidth: atlas.width,
    atlasHeight: atlas.height,
    tiles: [],
  };
}

/** How many cells a sheet holds in a Texture of `atlas` size. */
export function spriteAnimationSheetCellCount(sheet: SpriteAnimationSheet, atlas: { width: number; height: number }): number {
  if (atlas.width <= 0 || atlas.height <= 0) return 0;
  const grid = spriteAnimationSheetGrid(sheet, atlas);
  return tilesetAtlasTileCount(grid);
}

/** Image-space rect of a sheet cell (row 0 at the top), or null outside the Texture. */
export function spriteAnimationSheetCellRect(
  sheet: SpriteAnimationSheet,
  atlas: { width: number; height: number },
  cell: number,
): TileRect | null {
  if (cell > spriteAnimationSheetCellCount(sheet, atlas)) return null;
  return tilesetTileRect(spriteAnimationSheetGrid(sheet, atlas), cell);
}

/** What resolving reads: Sprites by guid and Texture pixel sizes by guid. */
export interface SpriteAnimationSources {
  sprite: (guid: string) => SpritePayload | null | undefined;
  textureSize: (guid: string) => { width: number; height: number } | null | undefined;
}

/**
 * Every frame as the renderer and physics read it: its Texture, pixel size,
 * pivot, collision and, for a sheet cell, UVs. A Sprite frame takes the
 * Sprite's Texture, size, pivot and collision; a cell takes the sheet's
 * Texture and the cell's size. Frames whose source is missing keep what they
 * have and show nothing.
 */
export function resolveSpriteAnimation(
  payload: SpriteAnimationPayload,
  sources: SpriteAnimationSources,
): SpriteAnimationPayload {
  const sheetAtlas = payload.source === "sheet" && payload.sheet.textureGuid
    ? sources.textureSize(payload.sheet.textureGuid)
    : null;
  const frames = payload.frames.map((frame): SpriteAnimationFrame => {
    if (payload.source === "sheet") {
      const cell = frame.cell ?? 1;
      const uv = sheetAtlas && cell <= spriteAnimationSheetCellCount(payload.sheet, sheetAtlas)
        ? tilesetTileUv(spriteAnimationSheetGrid(payload.sheet, sheetAtlas), cell)
        : null;
      const resolved: SpriteAnimationFrame = {
        ...frame,
        textureGuid: payload.sheet.textureGuid,
        width: payload.sheet.cellWidth,
        height: payload.sheet.cellHeight,
      };
      if (uv) resolved.uv = uv;
      else delete resolved.uv;
      return resolved;
    }
    if (frame.spriteGuid) {
      const sprite = sources.sprite(frame.spriteGuid);
      if (!sprite) return frame;
      const size = sprite.textureGuid ? sources.textureSize(sprite.textureGuid) : null;
      const resolved: SpriteAnimationFrame = {
        ...frame,
        textureGuid: sprite.textureGuid ?? "",
        pivot: { ...sprite.pivot },
        collision: { ...sprite.collision },
      };
      const width = size?.width ?? sprite.width;
      const height = size?.height ?? sprite.height;
      if (width !== undefined) resolved.width = width;
      if (height !== undefined) resolved.height = height;
      return resolved;
    }
    const size = frame.textureGuid ? sources.textureSize(frame.textureGuid) : null;
    return size ? { ...frame, width: size.width, height: size.height } : frame;
  });
  return { ...payload, frames };
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

/** Textures a Sprite Animation shows directly: frame Textures, or the sheet's. Sprite frames add theirs through the Sprite. */
export function spriteAnimationTextureGuids(
  payload: SpriteAnimationPayload,
): string[] {
  if (payload.source === "sheet") return payload.sheet.textureGuid ? [payload.sheet.textureGuid] : [];
  const guids: string[] = [];
  const seen = new Set<string>();
  for (const frame of payload.frames) {
    if (frame.spriteGuid || !frame.textureGuid || seen.has(frame.textureGuid)) continue;
    seen.add(frame.textureGuid);
    guids.push(frame.textureGuid);
  }
  return guids;
}

/** Sprites a `frames` animation shows, in first-use order. */
export function spriteAnimationSpriteGuids(payload: SpriteAnimationPayload): string[] {
  if (payload.source === "sheet") return [];
  const guids: string[] = [];
  const seen = new Set<string>();
  for (const frame of payload.frames) {
    if (!frame.spriteGuid || seen.has(frame.spriteGuid)) continue;
    seen.add(frame.spriteGuid);
    guids.push(frame.spriteGuid);
  }
  return guids;
}

/** Assets a Sprite Animation references: its Textures, then its Sprites. */
export function spriteAnimationDependencyGuids(payload: SpriteAnimationPayload): string[] {
  return [...spriteAnimationTextureGuids(payload), ...spriteAnimationSpriteGuids(payload)];
}

/**
 * Resolve every animation for Play and the player. Texture sizes come from
 * `textureSizes` (catalog sizes), else the Texture's source bytes (PNG, JPEG,
 * WebP, GIF); Sprites come from `sprites`.
 */
export function hydrateSpriteAnimations(
  animations: ReadonlyMap<string, SpriteAnimationPayload>,
  sources: {
    sprites: ReadonlyMap<string, SpritePayload>;
    textureSizes: ReadonlyMap<string, { width: number; height: number }>;
    textureBytes: ReadonlyMap<string, Uint8Array>;
  },
): Map<string, SpriteAnimationPayload> {
  const cache = new Map<string, { width: number; height: number } | null>();
  const textureSize = (guid: string) => {
    const known = sources.textureSizes.get(guid);
    if (known) return known;
    if (cache.has(guid)) return cache.get(guid) ?? null;
    const bytes = sources.textureBytes.get(guid);
    const size = bytes ? sniffSourceImageSize(bytes) : null;
    cache.set(guid, size);
    return size;
  };
  const next = new Map<string, SpriteAnimationPayload>();
  for (const [guid, payload] of animations) {
    next.set(guid, resolveSpriteAnimation(payload, { sprite: (spriteGuid) => sources.sprites.get(spriteGuid), textureSize }));
  }
  return next;
}
