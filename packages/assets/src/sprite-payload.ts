import { sniffSourceImageSize } from "./image-size";

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

/**
 * One image: a Texture shown whole, its pivot and its collision box. Moving
 * images are Sprite Animation assets.
 */
export interface SpritePayload {
  textureGuid: string | null;
  pixelsPerUnit: number;
  /** Normalized point of the image on the actor origin; v grows downward. */
  pivot: { x: number; y: number };
  /** Normalized AABB; the default covers the whole image. */
  collision: SpriteCollision;
  /**
   * Pixel size of the Texture. Never authored: loaders fill it from the
   * Texture (`applyTexturePixelSizeToSprite`), and it sizes the quad.
   */
  width?: number;
  height?: number;
}

/** Quad size, in pixels, for a Sprite whose Texture size is not known yet. */
export const DEFAULT_SPRITE_PIXEL_SIZE = 100;

export function createDefaultSpritePayload(): SpritePayload {
  return {
    textureGuid: null,
    pixelsPerUnit: 100,
    pivot: { x: DEFAULT_SPRITE_PIVOT.x, y: DEFAULT_SPRITE_PIVOT.y },
    collision: { ...DEFAULT_SPRITE_COLLISION },
  };
}

function positiveFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Parse a stored Sprite; missing or invalid fields take their defaults. */
export function parseSpritePayload(value: unknown): SpritePayload {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const sprite: SpritePayload = {
    textureGuid: typeof source.textureGuid === "string" && source.textureGuid.length > 0 ? source.textureGuid : null,
    pixelsPerUnit: positiveFinite(source.pixelsPerUnit) ?? 100,
    pivot: parseSpritePivot(source.pivot),
    collision: parseSpriteCollision(source.collision),
  };
  const width = positiveFinite(source.width);
  const height = positiveFinite(source.height);
  if (width !== undefined) sprite.width = width;
  if (height !== undefined) sprite.height = height;
  return sprite;
}

/** World size of a Sprite's quad: its Texture's pixels over Pixels Per Unit. */
export function spriteWorldSize(sprite: Pick<SpritePayload, "pixelsPerUnit" | "width" | "height">): { width: number; height: number } {
  const ppu = sprite.pixelsPerUnit > 0 ? sprite.pixelsPerUnit : 100;
  return {
    width: (sprite.width ?? DEFAULT_SPRITE_PIXEL_SIZE) / ppu,
    height: (sprite.height ?? DEFAULT_SPRITE_PIXEL_SIZE) / ppu,
  };
}

/** Size a Sprite from its Texture; an unknown Texture size leaves it as it is. */
export function applyTexturePixelSizeToSprite(
  sprite: SpritePayload,
  sizeForGuid: (guid: string) => { width: number; height: number } | null | undefined,
): SpritePayload {
  const size = sprite.textureGuid ? sizeForGuid(sprite.textureGuid) : null;
  if (!size || (sprite.width === size.width && sprite.height === size.height)) return sprite;
  return { ...sprite, width: size.width, height: size.height };
}

/** Fill missing Sprite pixel sizes from Texture source bytes (PNG, JPEG, WebP, GIF). */
export function hydrateSpritePixelSizes(
  sprites: ReadonlyMap<string, SpritePayload>,
  textureBytes: ReadonlyMap<string, Uint8Array>,
): Map<string, SpritePayload> {
  const next = new Map<string, SpritePayload>();
  for (const [guid, sprite] of sprites) {
    next.set(guid, applyTexturePixelSizeToSprite(sprite, (textureGuid) => {
      const bytes = textureBytes.get(textureGuid);
      return bytes ? sniffSourceImageSize(bytes) : null;
    }));
  }
  return next;
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

export type SpriteCollisionHandle =
  | "n"
  | "s"
  | "e"
  | "w"
  | "ne"
  | "nw"
  | "se"
  | "sw"
  | "move";

/** Resize or move a normalized AABB from a pointer in 0–1 frame space. */
export function resizeSpriteCollision(
  start: SpriteCollision,
  handle: SpriteCollisionHandle,
  pointer: { x: number; y: number },
  origin: { x: number; y: number },
): SpriteCollision {
  const right = start.x + start.width;
  const bottom = start.y + start.height;
  if (handle === "move") {
    const dx = pointer.x - origin.x;
    const dy = pointer.y - origin.y;
    const width = start.width;
    const height = start.height;
    return {
      x: Math.min(Math.max(0, start.x + dx), Math.max(0, 1 - width)),
      y: Math.min(Math.max(0, start.y + dy), Math.max(0, 1 - height)),
      width,
      height,
    };
  }
  let x = start.x;
  let y = start.y;
  let width = start.width;
  let height = start.height;
  if (handle.includes("e")) {
    width = Math.max(0.001, pointer.x - start.x);
  }
  if (handle.includes("w")) {
    x = Math.min(pointer.x, right - 0.001);
    width = right - x;
  }
  if (handle.includes("s")) {
    height = Math.max(0.001, pointer.y - start.y);
  }
  if (handle.includes("n")) {
    y = Math.min(pointer.y, bottom - 0.001);
    height = bottom - y;
  }
  return parseSpriteCollision({ x, y, width, height });
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
