import {
  addTilemapTileset,
  createDefaultTilemapPayload,
  createTilemapLayer,
  emptyChunkTiles,
  encodeTileGid,
  ensureTilesetTiles,
  localIndex,
  normalizeTilemapPayload,
  normalizeTilesetPayload,
  spriteAnimationDurationMs,
  tilesetAtlasColumns,
  tilesetAtlasRows,
  type SpriteAnimationPayload,
  type SpriteCollision,
  type SpritePayload,
  type TilemapChunk,
  type TilemapPayload,
  type TilesetPayload,
  type TilesetTile,
} from "@babylonslate/assets";
import {
  ANIM_EXIT_TIME_REACHED_TYPE,
  ANIM_RULE_ENTER_NODE_ID,
  createDefaultAnimGraph,
  createDefaultTransitionRuleGraph,
  defaultAnimStatePosition,
  type AnimGraphDocument,
  type AnimTransition,
} from "@babylonslate/anim-graph";
import {
  createDefaultScene,
  DEFAULT_TWO_D_PROJECT_SETTINGS,
  type ProjectSettings,
  type SerializedComponent,
  type SerializedGraph,
  type SerializedScene,
} from "@babylonslate/core";
import { parseColliderProperties, parseConstraintProperties } from "@babylonslate/physics";
import {
  actor,
  comp,
  requireRef,
  SCENE_SAVE_ORDER,
  tf,
  type FeatureTestContext,
  type Vec3,
} from "./context";

/** Folder under `assets/FeatureTest/` for every 2D asset (the scene goes to `Scenes`). */
export const FEATURE_TEST_TWO_D_FOLDER = "TwoD";

/** The 2D world scene (`FeatureTest/Scenes/FT_2D`): open its tab and press Play. */
export const FEATURE_TEST_TWO_D_SCENE_NAME = "FT_2D";

/** Asset names, so sibling FeatureTest modules and docs can find them by path. */
export const FEATURE_TEST_TWO_D_NAMES = {
  cameraSprite: "FT_2DCameraSprite",
  audioSprite: "FT_2DAudioSprite",
  particlesSprite: "FT_2DParticlesSprite",
  navSprite: "FT_2DNavSprite",
  lightSprite: "FT_2DLightSprite",
  /** Full-height colormap strips (one frame per strip) and a `Cycle` clip. */
  colorBars: "FT_2DColorBars",
  blinkAnimation: "FT_2DBlinkAnim",
  pulseAnimation: "FT_2DPulseAnim",
  iconGraph: "FT_2DIconGraph",
  tiles: "FT_2DTiles",
  iconTiles: "FT_2DIconTiles",
  worldMap: "FT_2DWorldMap",
} as const;

/** Custom sorting layer between Default and Foreground (world rendering group). */
export const FEATURE_TEST_TWO_D_CHARACTERS_LAYER = "Characters";

/** Project sorting layers FT_2D uses, back to front; missing ones are merged in. */
export const FEATURE_TEST_TWO_D_SORTING_LAYERS = [
  "Background",
  "Default",
  FEATURE_TEST_TWO_D_CHARACTERS_LAYER,
  "Foreground",
  "UI",
] as const;

const NAMES = FEATURE_TEST_TWO_D_NAMES;
const FOLDER = FEATURE_TEST_TWO_D_FOLDER;
const CHARACTERS = FEATURE_TEST_TWO_D_CHARACTERS_LAYER;

/** Equal to the project PPU (FeatureTest keeps the engine default). */
const PPU = DEFAULT_TWO_D_PROJECT_SETTINGS.pixelsPerUnit;
const TILE_PX = 32;
const TILE = TILE_PX / PPU;

/**
 * Perf knobs. The map is 64 × 36 tiles (20.48 × 11.52 units, exactly the
 * camera view at 16:9) in 32-tile chunks: one draw per non-empty chunk per
 * atlas per layer, plus `:anim` siblings for animated tiles.
 */
const MAP_W = 64;
const MAP_H = 36;
const CHUNK = 32;
const MAP_ORIGIN: readonly [number, number] = [-(MAP_W * TILE) / 2, -(MAP_H * TILE) / 2];

/**
 * Perf knob: falling dynamic sprite bodies, one Sprite draw and one 2D body
 * each. Columns are aimed at the ledges, the chain funnel, the glowing blocks
 * and the ramp; rows stack upward.
 */
const BODY_COLUMNS = [-7, -5.6, -4.2, -2.1, -0.6, 1.9, 3.4, 5.3] as const;
const BODY_ROWS = [0.6, 1.5, 2.4, 3.3] as const;

/** Holiday Pack colormap: 512 px, 16 × 16 cells of 32 px. Tile id = row × 16 + col + 1. */
const ATLAS_GRID = 16;
/** Colormap strips the color-bar Sprite frames crop (full height, see `colorBarsSprite`). */
const COLOR_BAR_STRIPS = 8;

/** Engine billboard PNGs measured once: opaque bounds (left, top, right, bottom) of the 64 px source. */
const ICON_SOURCE_PX = 64;
const ICON_BOUNDS = {
  camera: [1, 14, 62, 50],
  audio: [3, 6, 61, 58],
  particles: [2, 3, 61, 62],
  point_light: [10, 3, 54, 61],
  spot_light: [10, 3, 54, 61],
  navmesh: [6, 8, 58, 56],
  default: [6, 4, 58, 60],
} as const;
type IconStem = keyof typeof ICON_BOUNDS;

const FOLDERS = {
  world: { id: "ft-2d-folder-world", name: "World" },
  bodies: { id: "ft-2d-folder-bodies", name: "Falling Bodies" },
  animation: { id: "ft-2d-folder-animation", name: "Sprite Animation" },
  pendulum: { id: "ft-2d-folder-pendulum", name: "Hinge Pendulum" },
} as const;

const CENTER_PIVOT = { x: 0.5, y: 0.5 } as const;

type Shape2D = Record<string, unknown> & { kind: "box2d" | "circle" | "capsule2d" | "polygon" | "chain" };

/** Body kinds cycle through every 2D Collider shape; Box uses the Sprite frame's collision rect at runtime. */
const BODY_KINDS: ReadonlyArray<{ title: string; sprite: keyof SpriteGuids; shape: Shape2D; restitution: number }> = [
  { title: "Box", sprite: "cameraSprite", shape: { kind: "box2d", halfExtents: { x: 0.305, y: 0.18 } }, restitution: 0.1 },
  { title: "Circle", sprite: "audioSprite", shape: { kind: "circle", radius: 0.29 }, restitution: 0.45 },
  { title: "Capsule", sprite: "navSprite", shape: { kind: "capsule2d", radius: 0.2, halfHeight: 0.06 }, restitution: 0.2 },
  {
    title: "Hexagon",
    sprite: "particlesSprite",
    shape: {
      kind: "polygon",
      points: [
        { x: 0.3, y: 0 },
        { x: 0.15, y: 0.26 },
        { x: -0.15, y: 0.26 },
        { x: -0.3, y: 0 },
        { x: -0.15, y: -0.26 },
        { x: 0.15, y: -0.26 },
      ],
    },
    restitution: 0.1,
  },
];

/**
 * 2D area: Sprites (billboard icons with measured collision rects, plus
 * full-height colormap strips), two Sprite Animations played by a 2D
 * AnimationGraph, a colormap Tileset (full, chain and animated tiles) and an
 * icon Tileset, a chunked Tilemap painted in code, and the `FT_2D` scene
 * (2D physics world) where sprite bodies fall onto the tilemap collision.
 * Queues the project sorting layers FT_2D uses (PPU and pixel snap untouched).
 */
export async function buildFeatureTestTwoD(ctx: FeatureTestContext): Promise<void> {
  const sprites = await buildSprites(ctx);
  const graph = await buildIconGraph(ctx);
  const tilemap = await buildTilemap(ctx);
  const scene = buildScene(ctx, { sprites, graph, tilemap });
  await ctx.addSceneDocument({
    kind: "scene",
    folder: "Scenes",
    name: FEATURE_TEST_TWO_D_SCENE_NAME,
    content: scene,
    order: SCENE_SAVE_ORDER.scene,
  });
  ctx.patchSettings((settings) => withTwoDSortingLayers(settings));
}

// ---------------------------------------------------------------------------
// Sprites and Sprite Animations

type SpriteGuids = Record<
  "cameraSprite" | "audioSprite" | "particlesSprite" | "navSprite" | "lightSprite" | "colorBars",
  string
>;

async function buildSprites(ctx: FeatureTestContext): Promise<SpriteGuids> {
  const icon = async (name: string, stem: IconStem) =>
    (await ctx.createAsset("Sprite", FOLDER, name, { payload: payload(iconSprite(ctx, stem)) })).guid;
  return {
    cameraSprite: await icon(NAMES.cameraSprite, "camera"),
    audioSprite: await icon(NAMES.audioSprite, "audio"),
    particlesSprite: await icon(NAMES.particlesSprite, "particles"),
    navSprite: await icon(NAMES.navSprite, "navmesh"),
    lightSprite: await icon(NAMES.lightSprite, "point_light"),
    colorBars: (await ctx.createAsset("Sprite", FOLDER, NAMES.colorBars, { payload: payload(colorBarsSprite(ctx)) }))
      .guid,
  };
}

/** Single full frame of a UI icon Texture; quad = texture px / PPU, collision = opaque bounds. */
function iconSprite(ctx: FeatureTestContext, stem: IconStem): SpritePayload {
  const textureGuid = iconTexture(ctx, stem);
  const size = textureSize(ctx, textureGuid, `${stem} UI Texture`);
  return {
    textureGuid,
    pixelsPerUnit: PPU,
    frames: [
      {
        name: "idle",
        u: 0,
        v: 0,
        uSize: 1,
        vSize: 1,
        durationMs: 100,
        pivot: { ...CENTER_PIVOT },
        collision: iconCollision(stem),
        x: 0,
        y: 0,
        width: size.width,
        height: size.height,
      },
    ],
    clips: [{ name: "Idle", frames: ["idle"] }],
  };
}

/**
 * Atlas Sprite on the pixel-art colormap: one full-height strip per frame
 * (`v: 0, vSize: 1`, the only sub-rects whose V orientation the editor
 * preview and the runtime agree on) and a `Cycle` clip over all strips. The
 * scene shows frame 0 as a 0.64 × 5.12 pillar.
 */
function colorBarsSprite(ctx: FeatureTestContext): SpritePayload {
  const textureGuid = requireRef(ctx.assets.textures.colormapPixelArt, "the pixel-art colormap Texture");
  const size = textureSize(ctx, textureGuid, "pixel-art colormap Texture");
  const stripWidth = size.width / COLOR_BAR_STRIPS;
  const frames = Array.from({ length: COLOR_BAR_STRIPS }, (_, index) => ({
    name: `bar-${index + 1}`,
    u: index / COLOR_BAR_STRIPS,
    v: 0,
    uSize: 1 / COLOR_BAR_STRIPS,
    vSize: 1,
    durationMs: 150,
    pivot: { ...CENTER_PIVOT },
    collision: { x: 0, y: 0, width: 1, height: 1 },
    x: index * stripWidth,
    y: 0,
    width: stripWidth,
    height: size.height,
  }));
  return {
    textureGuid,
    pixelsPerUnit: PPU,
    frames,
    clips: [{ name: "Cycle", frames: frames.map((frame) => frame.name) }],
  };
}

/** Whole-Texture frames (one icon each) with per-frame collision; `hold` overrides the first frame. */
function iconAnimation(
  ctx: FeatureTestContext,
  stems: readonly IconStem[],
  frameDurationMs: number,
  hold?: number,
): SpriteAnimationPayload {
  return {
    frameDurationMs,
    frames: stems.map((stem, index) => {
      const textureGuid = iconTexture(ctx, stem);
      const size = textureSize(ctx, textureGuid, `${stem} UI Texture`);
      const holdMs = index === 0 ? hold : undefined;
      return {
        textureGuid,
        durationMs: holdMs ?? frameDurationMs,
        ...(holdMs !== undefined ? { durationMsOverride: true } : {}),
        pivot: { ...CENTER_PIVOT },
        collision: iconCollision(stem),
        width: size.width,
        height: size.height,
      };
    }),
  };
}

/**
 * Two Sprite Animations and the 2D AnimationGraph that plays them: Blink
 * (4 light icons, first held 360 ms; 720 ms loop) crossfades to Pulse
 * (3 icons at 1.5×) after 3 loops, and Pulse returns after 4 loops.
 */
async function buildIconGraph(ctx: FeatureTestContext): Promise<string> {
  const blinkPayload = iconAnimation(ctx, ["point_light", "spot_light", "audio", "camera"], 120, 360);
  const pulsePayload = iconAnimation(ctx, ["particles", "navmesh", "default"], 160);
  const blink = (await ctx.createAsset("SpriteAnimation", FOLDER, NAMES.blinkAnimation, { payload: payload(blinkPayload) }))
    .guid;
  const pulse = (await ctx.createAsset("SpriteAnimation", FOLDER, NAMES.pulseAnimation, { payload: payload(pulsePayload) }))
    .guid;

  const graph: AnimGraphDocument = {
    ...createDefaultAnimGraph(NAMES.iconGraph),
    entryStateId: "blink",
    states: [
      { id: "blink", name: "Blink", clipId: "clip-blink", speed: 1, loop: true, position: defaultAnimStatePosition(0) },
      { id: "pulse", name: "Pulse", clipId: "clip-pulse", speed: 1.5, loop: true, position: defaultAnimStatePosition(1) },
    ],
    clips: [
      { id: "clip-blink", kind: "sprite", assetGuid: blink, clipName: "", durationMs: spriteAnimationDurationMs(blinkPayload) },
      { id: "clip-pulse", kind: "sprite", assetGuid: pulse, clipName: "", durationMs: spriteAnimationDurationMs(pulsePayload) },
    ],
    // A Both Ways pair keeps both rule sinks live; each condition drives Enter State.
    transitions: [
      exitTimeTransition("blink-to-pulse", "blink", "pulse", 0.1, 3),
      exitTimeTransition("pulse-to-blink", "pulse", "blink", 0, 4),
    ],
    variables: [],
    parameters: [],
  };
  return (await ctx.createAsset("AnimationGraph", FOLDER, NAMES.iconGraph, { payload: payload(graph) })).guid;
}

/** Transition whose rule is `Exit Time Reached(exitTime) → Enter State`. */
function exitTimeTransition(
  id: string,
  fromStateId: string,
  toStateId: string,
  blendSeconds: number,
  exitTime: number,
): AnimTransition {
  const ruleGraph: SerializedGraph = createDefaultTransitionRuleGraph();
  ruleGraph.nodes.push({
    id: "exit-time",
    type: ANIM_EXIT_TIME_REACHED_TYPE,
    position: { x: 80, y: 40 },
    data: { title: "Exit Time Reached", exitTime },
  });
  ruleGraph.edges.push({
    id: "e-exit-time-enter",
    source: "exit-time",
    sourceHandle: "value",
    target: ANIM_RULE_ENTER_NODE_ID,
    targetHandle: "value",
  });
  return {
    id,
    fromStateId,
    toStateId,
    blendSeconds,
    priority: 0,
    ruleGraph,
    sourceHandle: "right-out",
    targetHandle: "left-in",
  };
}

// ---------------------------------------------------------------------------
// Tilesets and Tilemap

/** Colormap cells the painted map uses (flat color swatches, picked by sampling the PNG). */
const CELL = {
  sky: cell(2, 4),
  cloud: cell(4, 4),
  hill: cell(2, 12),
  dirt: cell(4, 8),
  grass: cell(10, 8),
  stone: cell(10, 12),
  wall: cell(12, 12),
  ramp: cell(6, 9),
  glow: cell(12, 8),
  glowOrange: cell(14, 8),
  glowRed: cell(0, 4),
  flower: cell(8, 4),
  snow: cell(0, 8),
} as const;

/** Tileset flags (free-form game data bits). */
const FLAG_SOLID = 1;
const FLAG_RAMP = 2;
const FLAG_ANIMATED = 4;

/**
 * Tilesets (colormap 512 px at 32 px = 256 tiles with full, chain and
 * animated tiles; a 2 × 2 icon atlas) and the Tilemap: Sky (Background,
 * parallax 0.5, no collision), Ground (collision) and Decor (Foreground,
 * second atlas) layers painted chunk by chunk.
 */
async function buildTilemap(ctx: FeatureTestContext): Promise<string> {
  const tileset = colormapTileset(ctx);
  const tilesGuid = (await ctx.createAsset("Tileset", FOLDER, NAMES.tiles, { payload: payload(tileset) })).guid;
  const iconTileset = iconAtlasTileset(ctx);
  const iconTilesGuid = (await ctx.createAsset("Tileset", FOLDER, NAMES.iconTiles, { payload: payload(iconTileset) }))
    .guid;

  let map: TilemapPayload = {
    ...createDefaultTilemapPayload(),
    tileWidth: TILE_PX,
    tileHeight: TILE_PX,
    width: MAP_W,
    height: MAP_H,
    chunkSize: CHUNK,
    layers: [],
  };
  const known = new Map([
    [tilesGuid, tileset],
    [iconTilesGuid, iconTileset],
  ]);
  map = addTilemapTileset(map, tilesGuid, tileset, known);
  map = addTilemapTileset(map, iconTilesGuid, iconTileset, known);
  const firstGid = (guid: string) => {
    const ref = map.tilesets.find((entry) => entry.guid === guid);
    if (!ref) throw new Error("FeatureTest Tilemap lost a Tileset reference.");
    return ref.firstGid;
  };
  const tile = (local: number) => encodeTileGid(firstGid(tilesGuid), local);
  const icon = (local: number) => encodeTileGid(firstGid(iconTilesGuid), local);

  const sky = new TileCanvas(MAP_W, MAP_H);
  sky.fill(0, 0, MAP_W - 1, MAP_H - 1, (x, y) => (y < hillHeight(x) ? tile(CELL.hill) : tile(CELL.sky)));
  for (const [x0, y0, x1, y1] of CLOUDS) sky.fill(x0, y0, x1, y1, tile(CELL.cloud));

  const ground = new TileCanvas(MAP_W, MAP_H);
  ground.fill(0, 0, MAP_W - 1, 2, tile(CELL.dirt));
  ground.fill(0, 3, MAP_W - 1, 3, tile(CELL.grass));
  ground.fill(0, 0, 1, 23, tile(CELL.wall));
  ground.fill(MAP_W - 2, 0, MAP_W - 1, 23, tile(CELL.wall));
  ground.fill(8, 14, 20, 14, tile(CELL.stone));
  ground.fill(24, 10, 34, 10, tile(CELL.stone));
  ground.fill(36, 4, 39, 4, tile(CELL.glow));
  // Ramp: chain-collision diagonals rising to a plateau, filled below with dirt.
  for (let step = 0; step < 8; step++) {
    ground.fill(46 + step, 4 + step, 46 + step, 4 + step, tile(CELL.ramp));
    if (step > 0) ground.fill(46 + step, 4, 46 + step, 3 + step, tile(CELL.dirt));
  }
  ground.fill(54, 4, 61, 10, tile(CELL.dirt));
  ground.fill(54, 11, 61, 11, tile(CELL.grass));

  const decor = new TileCanvas(MAP_W, MAP_H);
  for (const x of [4, 6, 21, 23, 27, 31, 42]) decor.fill(x, 4, x, 4, tile(CELL.flower));
  decor.fill(8, 15, 20, 15, tile(CELL.snow));
  decor.fill(24, 11, 34, 11, tile(CELL.snow));
  // 2 × 2 icon decal from the second atlas (tile 1 is the atlas top-left; +Y is up).
  decor.fill(55, 13, 55, 13, icon(1));
  decor.fill(56, 13, 56, 13, icon(2));
  decor.fill(55, 12, 55, 12, icon(3));
  decor.fill(56, 12, 56, 12, icon(4));

  map = {
    ...map,
    layers: [
      {
        ...createTilemapLayer("sky", "Sky"),
        collision: false,
        sortingLayer: "Background",
        parallax: { x: 0.5, y: 1 },
        chunks: sky.chunks(CHUNK),
      },
      { ...createTilemapLayer("ground", "Ground"), collision: true, sortingLayer: "Default", chunks: ground.chunks(CHUNK) },
      {
        ...createTilemapLayer("decor", "Decor"),
        collision: false,
        sortingLayer: "Foreground",
        orderInLayer: 1,
        chunks: decor.chunks(CHUNK),
      },
    ],
  };
  return (
    await ctx.createAsset("Tilemap", FOLDER, NAMES.worldMap, { payload: payload(normalizeTilemapPayload(map)) })
  ).guid;
}

/** Atlas size equals the Texture; full-collision ground, a chain ramp and an animated glowing block. */
function colormapTileset(ctx: FeatureTestContext): TilesetPayload {
  const textureGuid = requireRef(ctx.assets.textures.colormapPixelArt, "the pixel-art colormap Texture");
  const size = textureSize(ctx, textureGuid, "pixel-art colormap Texture");
  const base = ensureTilesetTiles(
    normalizeTilesetPayload({
      textureGuid,
      atlasWidth: size.width,
      atlasHeight: size.height,
      tileWidth: TILE_PX,
      tileHeight: TILE_PX,
      margin: 0,
      spacing: 0,
    }),
  );
  if (tilesetAtlasColumns(base) !== ATLAS_GRID || tilesetAtlasRows(base) !== ATLAS_GRID) {
    throw new Error("FeatureTest expects the 512 px Holiday Pack colormap for the 2D Tileset.");
  }
  const solid = new Set<number>([CELL.dirt, CELL.grass, CELL.stone, CELL.wall]);
  const tiles = base.tiles.map((entry): TilesetTile => {
    if (solid.has(entry.id)) return { ...entry, collision: "full", flags: FLAG_SOLID };
    if (entry.id === CELL.ramp) {
      return {
        ...entry,
        collision: { kind: "chain", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
        flags: FLAG_RAMP,
      };
    }
    if (entry.id === CELL.glow) {
      return {
        ...entry,
        collision: "full",
        flags: FLAG_SOLID | FLAG_ANIMATED,
        animation: [CELL.glow, CELL.glowOrange, CELL.glowRed, CELL.glowOrange],
        animationFrameDurationMs: 180,
      };
    }
    return entry;
  });
  return normalizeTilesetPayload({ ...base, tiles });
}

/** The default billboard icon cut into a 2 × 2 atlas (second Tileset, drawn as `:a1` chunk meshes). */
function iconAtlasTileset(ctx: FeatureTestContext): TilesetPayload {
  const textureGuid = iconTexture(ctx, "default");
  const size = textureSize(ctx, textureGuid, "default UI Texture");
  return ensureTilesetTiles(
    normalizeTilesetPayload({
      textureGuid,
      atlasWidth: size.width,
      atlasHeight: size.height,
      tileWidth: size.width / 2,
      tileHeight: size.height / 2,
      margin: 0,
      spacing: 0,
    }),
  );
}

/** Sky-layer cloud rectangles (x0, y0, x1, y1 in tiles). */
const CLOUDS: ReadonlyArray<readonly [number, number, number, number]> = [
  [6, 29, 11, 30],
  [8, 31, 10, 31],
  [28, 31, 35, 32],
  [30, 33, 33, 33],
  [46, 28, 51, 29],
  [47, 30, 49, 30],
];

/** Distant hills: a deterministic triangle wave 9..14 tiles high. */
function hillHeight(x: number): number {
  return 9 + Math.floor(Math.abs(((x + 5) % 20) - 10) / 2);
}

/** Dense layer grid (+Y up, origin bottom-left) converted to sparse chunks once. */
class TileCanvas {
  private readonly width: number;
  private readonly height: number;
  private readonly cells: number[];

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.cells = new Array<number>(width * height).fill(0);
  }

  fill(x0: number, y0: number, x1: number, y1: number, gid: number | ((x: number, y: number) => number)): void {
    for (let y = Math.max(0, y0); y <= Math.min(this.height - 1, y1); y++) {
      for (let x = Math.max(0, x0); x <= Math.min(this.width - 1, x1); x++) {
        this.cells[y * this.width + x] = typeof gid === "number" ? gid : gid(x, y);
      }
    }
  }

  /** Chunks with `chunkSize²` global GIDs; empty chunks are omitted. */
  chunks(chunkSize: number): TilemapChunk[] {
    const chunks: TilemapChunk[] = [];
    for (let cy = 0; cy * chunkSize < this.height; cy++) {
      for (let cx = 0; cx * chunkSize < this.width; cx++) {
        const tiles = emptyChunkTiles(chunkSize);
        let used = false;
        for (let ly = 0; ly < chunkSize; ly++) {
          for (let lx = 0; lx < chunkSize; lx++) {
            const x = cx * chunkSize + lx;
            const y = cy * chunkSize + ly;
            if (x >= this.width || y >= this.height) continue;
            const gid = this.cells[y * this.width + x] ?? 0;
            if (gid <= 0) continue;
            tiles[localIndex(lx, ly, chunkSize)] = gid;
            used = true;
          }
        }
        if (used) chunks.push({ cx, cy, tiles });
      }
    }
    return chunks;
  }
}

// ---------------------------------------------------------------------------
// FT_2D scene

/**
 * `FT_2D`: orthographic camera framing the whole map, the Tilemap
 * (Background), a Foreground color-bar pillar, falling sprite bodies
 * (Characters) of every 2D Collider shape, a chain funnel, a 2D hinge
 * pendulum (Default), and Sprite Animation actors (UI icon and a dynamic body
 * whose box follows each frame's collision rect).
 */
function buildScene(
  ctx: FeatureTestContext,
  refs: { sprites: SpriteGuids; graph: string; tilemap: string },
): SerializedScene {
  const scene = createDefaultScene("2d");
  scene.name = FEATURE_TEST_TWO_D_SCENE_NAME;
  scene.settings = {
    ...scene.settings,
    physicsWorld: "2d",
    cameraBounds2D: { width: MAP_W * TILE, height: MAP_H * TILE },
    grid: { ...scene.settings.grid, tileSize: TILE },
  };
  scene.folders.push(...Object.values(FOLDERS).map((folder) => ({ ...folder, parentFolderId: null })));
  const camera = scene.actors.find((entry) => entry.id === scene.settings.mainCameraActorId);
  const lens = camera?.components.find((component) => component.classId === "CameraComponent");
  if (!camera || !lens) throw new Error("FeatureTest FT_2D needs the default 2D camera.");
  lens.properties.orthographicSize = (MAP_H * TILE) / 2;
  camera.folderId = FOLDERS.world.id;

  const add = (folder: keyof typeof FOLDERS, id: string, name: string, position: Vec3, components: SerializedComponent[]) =>
    ctx.addActor(actor(id, name, tf(position), components, { folderId: FOLDERS[folder].id }), { scene });

  add("world", "ft-2d-tilemap", "World Tilemap", [MAP_ORIGIN[0], MAP_ORIGIN[1], 0], [
    comp("ft-2d-tilemap-map", "TilemapComponent", { assetGuid: refs.tilemap, sortingLayer: "Background", orderInLayer: 0 }),
  ]);
  // The pillar (frame 0, full colormap height) stands on the grass, in front of the falling bodies.
  const colormap = requireRef(ctx.assets.textures.colormapPixelArt, "the pixel-art colormap Texture");
  const barHeight = textureSize(ctx, colormap, "pixel-art colormap Texture").height / PPU;
  add("world", "ft-2d-color-bars", "Color Bars", [-5.1, MAP_ORIGIN[1] + 4 * TILE + barHeight / 2, 0], [
    sprite("ft-2d-color-bars-sprite", refs.sprites.colorBars, "Foreground", 0),
  ]);
  add("world", "ft-2d-funnel", "Chain Funnel", [-1.35, -0.9, 0], [
    rigidBody("ft-2d-funnel-body", "static"),
    collider(
      "ft-2d-funnel-collider",
      {
        kind: "chain",
        points: [
          { x: -1.3, y: 0.45 },
          { x: 0, y: 0 },
          { x: 1.3, y: 0.45 },
        ],
        loop: false,
      },
      { renderInGame: true },
    ),
  ]);

  BODY_ROWS.forEach((y, row) => {
    BODY_COLUMNS.forEach((x, column) => {
      const index = row * BODY_COLUMNS.length + column;
      const kind = BODY_KINDS[(row + column) % BODY_KINDS.length]!;
      const id = `ft-2d-body-${index + 1}`;
      add("bodies", id, `${kind.title} Body ${index + 1}`, [x, y, 0], [
        sprite(`${id}-sprite`, refs.sprites[kind.sprite], CHARACTERS, index),
        rigidBody(`${id}-body`, "dynamic", { mass: 1 }),
        collider(`${id}-collider`, kind.shape, { restitution: kind.restitution }),
      ]);
    });
  });

  add("animation", "ft-2d-anim-icon", "Animated Icon", [0, 4.6, 0], [
    sprite("ft-2d-anim-icon-sprite", refs.sprites.lightSprite, "UI", 0),
    comp("ft-2d-anim-icon-graph", "AnimationGraphComponent", { graphGuid: refs.graph }),
  ]);
  add("animation", "ft-2d-anim-body", "Animated Body", [9, 0.4, 0], [
    sprite("ft-2d-anim-body-sprite", refs.sprites.lightSprite, CHARACTERS, 100),
    comp("ft-2d-anim-body-graph", "AnimationGraphComponent", { graphGuid: refs.graph }),
    rigidBody("ft-2d-anim-body-body", "dynamic", { mass: 1 }),
    collider("ft-2d-anim-body-collider", { kind: "box2d", halfExtents: { x: 0.32, y: 0.32 } }),
  ]);

  // Released horizontally, the bob swings under the pivot without touching the wall or plateau.
  const pivot: Vec3 = [7.9, 3.6, 0];
  const length = 1.6;
  add("pendulum", "ft-2d-pendulum-pivot", "Pendulum Pivot", pivot, [
    rigidBody("ft-2d-pendulum-pivot-body", "static"),
    collider("ft-2d-pendulum-pivot-collider", { kind: "circle", radius: 0.12 }, { renderInGame: true }),
  ]);
  add("pendulum", "ft-2d-pendulum-bob", "Pendulum Bob", [pivot[0] - length, pivot[1], 0], [
    sprite("ft-2d-pendulum-bob-sprite", refs.sprites.audioSprite, "Default", 0),
    rigidBody("ft-2d-pendulum-bob-body", "dynamic", { mass: 2 }),
    collider("ft-2d-pendulum-bob-collider", { kind: "circle", radius: 0.29 }),
    hinge("ft-2d-pendulum-bob-hinge", "ft-2d-pendulum-pivot", { x: length, y: 0, z: 0 }),
  ]);
  return scene;
}

function sprite(id: string, assetGuid: string, sortingLayer: string, orderInLayer: number): SerializedComponent {
  return comp(id, "SpriteComponent", { assetGuid, sortingLayer, orderInLayer });
}

function rigidBody(
  id: string,
  motionType: "static" | "dynamic" | "kinematic",
  extra: Record<string, unknown> = {},
): SerializedComponent {
  return comp(id, "RigidBodyComponent", { motionType, ...extra }, undefined, { physicsWorld: "2d" });
}

/** 2D Collider, validated with the strict simulation parser so a bad shape fails the scaffold. */
function collider(id: string, shape: Shape2D, extra: Record<string, unknown> = {}): SerializedComponent {
  const component = comp(id, "ColliderComponent", { shape, ...extra }, undefined, { physicsWorld: "2d" });
  parseColliderProperties(component.properties, "2d");
  return component;
}

/** 2D hinge owned by body A; `anchorA` is A-local, `anchorB` sits on the target's origin. */
function hinge(id: string, targetActorId: string, anchorA: { x: number; y: number; z: number }): SerializedComponent {
  const component = comp(
    id,
    "PhysicsConstraintComponent",
    { kind: "hinge", targetActorId, anchorA, anchorB: { x: 0, y: 0, z: 0 } },
    undefined,
    { physicsWorld: "2d" },
  );
  parseConstraintProperties(component.properties, "2d");
  return component;
}

// ---------------------------------------------------------------------------
// Project settings

/** Merge the sorting layers FT_2D uses into the project list, keeping any existing order. */
function withTwoDSortingLayers(settings: ProjectSettings): ProjectSettings {
  const layers = [...settings.twoD.sortingLayers];
  let previous = -1;
  for (const name of FEATURE_TEST_TWO_D_SORTING_LAYERS) {
    const at = layers.indexOf(name);
    if (at >= 0) {
      previous = at;
      continue;
    }
    layers.splice(previous + 1, 0, name);
    previous += 1;
  }
  return { ...settings, twoD: { ...settings.twoD, sortingLayers: layers } };
}

// ---------------------------------------------------------------------------
// Helpers

/** 1-based colormap tile id of a 32 px cell (row 0 is the top of the atlas). */
function cell(column: number, row: number): number {
  return row * ATLAS_GRID + column + 1;
}

function iconTexture(ctx: FeatureTestContext, stem: IconStem): string {
  return requireRef(ctx.assets.textures.ui[stem], `the ${stem} UI Texture`);
}

/** Normalized opaque bounds (y from the top) of a billboard icon. */
function iconCollision(stem: IconStem): SpriteCollision {
  const [left, top, right, bottom] = ICON_BOUNDS[stem];
  const unit = (value: number) => Math.round((value / ICON_SOURCE_PX) * 10_000) / 10_000;
  return { x: unit(left), y: unit(top), width: unit(right - left), height: unit(bottom - top) };
}

/** Pixel size the image importer recorded on the Texture header. */
function textureSize(ctx: FeatureTestContext, guid: string, label: string): { width: number; height: number } {
  const header = ctx.registry.getByGuid(guid)?.header.payload;
  const width = header?.width;
  const height = header?.height;
  if (typeof width !== "number" || typeof height !== "number" || width <= 0 || height <= 0) {
    throw new Error(`FeatureTest ${label} has no pixel size.`);
  }
  return { width, height };
}

function payload(value: object): Record<string, unknown> {
  return value as Record<string, unknown>;
}
