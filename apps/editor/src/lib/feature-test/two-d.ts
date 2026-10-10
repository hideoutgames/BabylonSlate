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
import { PLATFORMER_TILE_PX, ROBOT_FRAMES, type RobotFrame } from "./engine-content-files";

/** Folder under `assets/FeatureTest/` for every 2D asset (the scene goes to `Scenes`). */
export const FEATURE_TEST_TWO_D_FOLDER = "TwoD";

/** The 2D world scene (`FeatureTest/Scenes/FT_2D`): open its tab and press Play. */
export const FEATURE_TEST_TWO_D_SCENE_NAME = "FT_2D";

/** Asset names, so sibling FeatureTest modules and docs can find them by path. */
export const FEATURE_TEST_TWO_D_NAMES = {
  robotIdleSprite: "FT_2DRobotIdleSprite",
  robotJumpSprite: "FT_2DRobotJumpSprite",
  robotFallSprite: "FT_2DRobotFallSprite",
  robotWalkSprite: "FT_2DRobotWalkSprite",
  /** Full-height colormap strips (one frame per strip) and a `Cycle` clip; authored data, not placed. */
  colorBars: "FT_2DColorBars",
  idleAnimation: "FT_2DRobotIdleAnim",
  walkAnimation: "FT_2DRobotWalkAnim",
  jumpAnimation: "FT_2DRobotJumpAnim",
  fallAnimation: "FT_2DRobotFallAnim",
  robotGraph: "FT_2DRobotGraph",
  tiles: "FT_2DTiles",
  decorTiles: "FT_2DDecorTiles",
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
const TILE_PX = PLATFORMER_TILE_PX;
const TILE = TILE_PX / PPU;

/**
 * Perf knobs. The map is 16 × 9 tiles of 128 px (20.48 × 11.52 units, exactly
 * the camera view at 16:9) in 8-tile chunks: one draw per non-empty chunk per
 * atlas per layer, plus `:anim` siblings for animated tiles.
 */
const MAP_W = 16;
const MAP_H = 9;
const CHUNK = 8;
const MAP_ORIGIN: readonly [number, number] = [-(MAP_W * TILE) / 2, -(MAP_H * TILE) / 2];

/** Play clear color behind the backdrop layer (the editor 2D viewport keeps its own background). */
const SKY_COLOR: [number, number, number] = [0.45, 0.7, 0.9];

/**
 * Perf knob: falling dynamic robot bodies, one Sprite draw and one 2D body
 * each. Columns are aimed at the floating ledge, the chain funnel, the switch
 * blocks and the ramp; rows stack upward above every obstacle.
 */
const BODY_COLUMNS = [-7, -5.6, -4.3, -2.6, -1.2, 2, 3.2, 4.6] as const;
const BODY_ROWS = [1.5, 2.4, 3.3, 4.2] as const;
/** Uniform actor scales; Sprite quads (texture px / PPU) and collider shapes follow them. */
const BODY_SCALE = 0.5;
const BOB_SCALE = 0.6;

/** Kenney platformer tilesheet: 1664 × 1536 px, 13 × 12 cells of 128 px. Tile id = row × 13 + col + 1. */
const ATLAS_COLUMNS = 13;
const ATLAS_ROWS = 12;

/** Kenney toon robot frames, measured once: opaque bounds (left, top, right, bottom) of the 96 × 128 px source. */
const ROBOT_FRAME_PX = { width: 96, height: 128 } as const;
const ROBOT_BOUNDS: Record<RobotFrame, readonly [number, number, number, number]> = {
  idle: [16, 38, 80, 128],
  jump: [9, 33, 90, 127],
  fall: [3, 33, 95, 127],
  walk0: [7, 36, 82, 127],
  walk1: [12, 40, 76, 128],
  walk2: [17, 38, 76, 128],
  walk3: [12, 36, 76, 128],
  walk4: [7, 38, 82, 128],
  walk5: [12, 40, 76, 128],
  walk6: [17, 38, 76, 128],
  walk7: [12, 36, 76, 128],
};
const WALK_FRAMES = ROBOT_FRAMES.filter((frame) => frame.startsWith("walk"));

const FOLDERS = {
  world: { id: "ft-2d-folder-world", name: "World" },
  bodies: { id: "ft-2d-folder-bodies", name: "Falling Bodies" },
  animation: { id: "ft-2d-folder-animation", name: "Sprite Animation" },
  pendulum: { id: "ft-2d-folder-pendulum", name: "Hinge Pendulum" },
} as const;

const CENTER_PIVOT = { x: 0.5, y: 0.5 } as const;

type Shape2D = Record<string, unknown> & { kind: "box2d" | "circle" | "capsule2d" | "polygon" | "chain" };

/** Robot pose Sprites (one whole frame Texture each). */
const ROBOT_SPRITES = {
  robotIdle: { name: NAMES.robotIdleSprite, frame: "idle", clip: "Idle" },
  robotJump: { name: NAMES.robotJumpSprite, frame: "jump", clip: "Jump" },
  robotFall: { name: NAMES.robotFallSprite, frame: "fall", clip: "Fall" },
  robotWalk: { name: NAMES.robotWalkSprite, frame: "walk0", clip: "Walk" },
} as const satisfies Record<string, { name: string; frame: RobotFrame; clip: string }>;
type RobotSpriteKey = keyof typeof ROBOT_SPRITES;

/**
 * Body kinds cycle through every 2D Collider shape, each sized to its robot
 * pose at scale 1 (the actor scale shrinks both). Box uses the Sprite frame's
 * collision rect at runtime; the other shapes sit on the pose's opaque bounds.
 */
const BODY_KINDS: ReadonlyArray<{ title: string; sprite: RobotSpriteKey; shape: Shape2D; restitution: number }> = [
  { title: "Box", sprite: "robotIdle", shape: { kind: "box2d", halfExtents: { x: 0.32, y: 0.45 } }, restitution: 0.1 },
  { title: "Circle", sprite: "robotFall", shape: { kind: "circle", radius: 0.46 }, restitution: 0.45 },
  { title: "Capsule", sprite: "robotJump", shape: { kind: "capsule2d", radius: 0.34, halfHeight: 0.13 }, restitution: 0.2 },
  {
    title: "Hexagon",
    sprite: "robotWalk",
    shape: {
      kind: "polygon",
      points: [
        { x: 0.375, y: 0.23 },
        { x: 0, y: 0.455 },
        { x: -0.375, y: 0.23 },
        { x: -0.375, y: -0.23 },
        { x: 0, y: -0.455 },
        { x: 0.375, y: -0.23 },
      ],
    },
    restitution: 0.1,
  },
];

/**
 * 2D area: robot Sprites (whole Kenney frames with measured collision rects;
 * plus an authored colormap strip Sprite), four robot Sprite Animations
 * played by a 2D AnimationGraph, a terrain Tileset (full, chain, one-way and
 * animated tiles) and a decor Tileset on the same Kenney tilesheet, a chunked
 * Tilemap painted in code, and the `FT_2D` scene (2D physics world) where
 * robot bodies fall onto the tilemap collision. Queues the project sorting
 * layers FT_2D uses (PPU and pixel snap untouched).
 */
export async function buildFeatureTestTwoD(ctx: FeatureTestContext): Promise<void> {
  const sprites = await buildSprites(ctx);
  const graph = await buildRobotGraph(ctx);
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

type SpriteGuids = Record<RobotSpriteKey | "colorBars", string>;

async function buildSprites(ctx: FeatureTestContext): Promise<SpriteGuids> {
  const robot = async (key: RobotSpriteKey) => {
    const spec = ROBOT_SPRITES[key];
    return (await ctx.createAsset("Sprite", FOLDER, spec.name, { payload: payload(robotSprite(ctx, spec.frame, spec.clip)) }))
      .guid;
  };
  return {
    robotIdle: await robot("robotIdle"),
    robotJump: await robot("robotJump"),
    robotFall: await robot("robotFall"),
    robotWalk: await robot("robotWalk"),
    colorBars: (await ctx.createAsset("Sprite", FOLDER, NAMES.colorBars, { payload: payload(colorBarsSprite(ctx)) }))
      .guid,
  };
}

/** Single full frame of a robot Texture; quad = texture px / PPU, collision = opaque bounds. */
function robotSprite(ctx: FeatureTestContext, frame: RobotFrame, clip: string): SpritePayload {
  const textureGuid = robotTexture(ctx, frame);
  const size = robotFrameSize(ctx, frame);
  return {
    textureGuid,
    pixelsPerUnit: PPU,
    frames: [
      {
        name: frame,
        u: 0,
        v: 0,
        uSize: 1,
        vSize: 1,
        durationMs: 100,
        pivot: { ...CENTER_PIVOT },
        collision: robotCollision(frame),
        x: 0,
        y: 0,
        width: size.width,
        height: size.height,
      },
    ],
    clips: [{ name: clip, frames: [frame] }],
  };
}

/** Colormap strips the color-bar Sprite frames crop (full height, see `colorBarsSprite`). */
const COLOR_BAR_STRIPS = 8;

/**
 * Atlas Sprite on the pixel-art colormap: one full-height strip per frame
 * (`v: 0, vSize: 1`, the only sub-rects whose V orientation the editor
 * preview and the runtime agree on) and a `Cycle` clip over all strips.
 * Authored data for multi-frame atlas Sprites; FT_2D does not place it.
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

/** Whole-Texture robot frames with per-frame collision; `holds` override chosen frame durations. */
function robotAnimation(
  ctx: FeatureTestContext,
  frames: readonly RobotFrame[],
  frameDurationMs: number,
  holds: Readonly<Partial<Record<RobotFrame, number>>> = {},
): SpriteAnimationPayload {
  return {
    frameDurationMs,
    frames: frames.map((frame) => {
      const size = robotFrameSize(ctx, frame);
      const holdMs = holds[frame];
      return {
        textureGuid: robotTexture(ctx, frame),
        durationMs: holdMs ?? frameDurationMs,
        ...(holdMs !== undefined ? { durationMsOverride: true } : {}),
        pivot: { ...CENTER_PIVOT },
        collision: robotCollision(frame),
        width: size.width,
        height: size.height,
      };
    }),
  };
}

/**
 * Four robot Sprite Animations and the 2D AnimationGraph that cycles them:
 * Idle (500 ms) → Walk (walk0–7, contact frames held 110 ms; 700 ms loop at
 * 1.25×) → Jump (one-shot 300 ms) → Fall (300 ms) → Idle, all on exit time.
 */
async function buildRobotGraph(ctx: FeatureTestContext): Promise<string> {
  const animations = {
    idle: robotAnimation(ctx, ["idle"], 500),
    walk: robotAnimation(ctx, WALK_FRAMES, 80, { walk0: 110, walk4: 110 }),
    jump: robotAnimation(ctx, ["jump"], 300),
    fall: robotAnimation(ctx, ["fall"], 300),
  };
  const save = async (name: string, value: SpriteAnimationPayload) =>
    (await ctx.createAsset("SpriteAnimation", FOLDER, name, { payload: payload(value) })).guid;
  const guids = {
    idle: await save(NAMES.idleAnimation, animations.idle),
    walk: await save(NAMES.walkAnimation, animations.walk),
    jump: await save(NAMES.jumpAnimation, animations.jump),
    fall: await save(NAMES.fallAnimation, animations.fall),
  };
  const clip = (key: keyof typeof animations) => ({
    id: `clip-${key}`,
    kind: "sprite" as const,
    assetGuid: guids[key],
    clipName: "",
    durationMs: spriteAnimationDurationMs(animations[key]),
  });

  const graph: AnimGraphDocument = {
    ...createDefaultAnimGraph(NAMES.robotGraph),
    entryStateId: "idle",
    states: [
      { id: "idle", name: "Idle", clipId: "clip-idle", speed: 1, loop: true, position: defaultAnimStatePosition(0) },
      { id: "walk", name: "Walk", clipId: "clip-walk", speed: 1.25, loop: true, position: defaultAnimStatePosition(1) },
      { id: "jump", name: "Jump", clipId: "clip-jump", speed: 1, loop: false, position: defaultAnimStatePosition(2) },
      { id: "fall", name: "Fall", clipId: "clip-fall", speed: 1, loop: true, position: defaultAnimStatePosition(3) },
    ],
    clips: [clip("idle"), clip("walk"), clip("jump"), clip("fall")],
    // One-way cycle: the disconnected Exit State sink stays true, so each exit time drives Enter State.
    transitions: [
      exitTimeTransition("idle-to-walk", "idle", "walk", 0, 3),
      exitTimeTransition("walk-to-jump", "walk", "jump", 0.1, 2),
      exitTimeTransition("jump-to-fall", "jump", "fall", 0, 1),
      exitTimeTransition("fall-to-idle", "fall", "idle", 0, 2),
    ],
    variables: [],
    parameters: [],
  };
  return (await ctx.createAsset("AnimationGraph", FOLDER, NAMES.robotGraph, { payload: payload(graph) })).guid;
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

/** Terrain cells of the Kenney tilesheet (row 0 is the top of the image). */
const CELL = {
  crate: cell(0, 0),
  crateCross: cell(1, 0),
  crateSlash: cell(2, 0),
  grassBlock: cell(3, 2),
  dirt: cell(5, 2),
  dirtBlock: cell(6, 2),
  islandLeft: cell(7, 2),
  islandRight: cell(8, 2),
  /** Dirt with a grass corner at the top right: the fill left of a `\` slope. */
  grassCornerRight: cell(11, 2),
  /** Dirt with a grass corner at the top left: the fill right of a `/` slope. */
  grassCornerLeft: cell(12, 2),
  ledge: cell(0, 3),
  ledgeLeft: cell(1, 3),
  ledgeMid: cell(2, 3),
  ledgeRight: cell(3, 3),
  slopeDown: cell(4, 3),
  slopeUp: cell(5, 3),
  grassLeft: cell(6, 3),
  grass: cell(7, 3),
  grassRight: cell(8, 3),
  lockOrange: cell(4, 4),
  lockYellow: cell(5, 4),
  cloud: cell(10, 7),
  snow: cell(11, 7),
  /** Snow corner at the top right: the fill left of a `\` snow slope. */
  snowCornerRight: cell(4, 8),
  /** Snow corner at the top left: the fill right of a `/` snow slope. */
  snowCornerLeft: cell(5, 8),
  snowSlopeDown: cell(10, 8),
  snowSlopeUp: cell(11, 8),
} as const;

/** Decor cells of the same sheet, painted through the second Tileset. */
const DECOR = {
  bush: cell(7, 0),
  tuft: cell(4, 2),
  mushroom: cell(6, 4),
  signExit: cell(6, 7),
  signLeft: cell(7, 7),
  signRight: cell(8, 7),
  torch: cell(12, 10),
  torchFlicker: cell(0, 11),
  torchUnlit: cell(1, 11),
  water: cell(2, 11),
  waterTop: cell(3, 11),
  waterTopLow: cell(4, 11),
} as const;

/** Tileset flags (free-form game data bits). */
const FLAG_SOLID = 1;
const FLAG_RAMP = 2;
const FLAG_ANIMATED = 4;
/** Thin top-edge platform (one-way in game logic; the chain itself is two-sided). */
const FLAG_PLATFORM = 8;
const FLAG_LIQUID = 16;
const FLAG_DECOR = 32;

/** Ramp steps from the ground (row 1 top) to the plateau (row 3 top). */
const RAMP_STEPS = 2;

/** Backdrop clouds (x, y in tiles). */
const CLOUDS: ReadonlyArray<readonly [number, number]> = [
  [2, 7],
  [6, 8],
  [10, 7],
  [13, 8],
];

/**
 * Tilesets (terrain: full, chain slope, one-way platform and animated switch
 * tiles; decor: animated water and torch tiles, both on the 13 × 12 Kenney
 * sheet) and the Tilemap: Backdrop (Background, parallax 0.5, no collision),
 * Ground (collision) and Decor (Foreground, second Tileset) layers painted
 * chunk by chunk.
 */
async function buildTilemap(ctx: FeatureTestContext): Promise<string> {
  const tileset = terrainTileset(ctx);
  const tilesGuid = (await ctx.createAsset("Tileset", FOLDER, NAMES.tiles, { payload: payload(tileset) })).guid;
  const decorTileset = decorAtlasTileset(ctx);
  const decorTilesGuid = (await ctx.createAsset("Tileset", FOLDER, NAMES.decorTiles, { payload: payload(decorTileset) }))
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
    [decorTilesGuid, decorTileset],
  ]);
  map = addTilemapTileset(map, tilesGuid, tileset, known);
  map = addTilemapTileset(map, decorTilesGuid, decorTileset, known);
  const firstGid = (guid: string) => {
    const ref = map.tilesets.find((entry) => entry.guid === guid);
    if (!ref) throw new Error("FeatureTest Tilemap lost a Tileset reference.");
    return ref.firstGid;
  };
  const tile = (local: number) => encodeTileGid(firstGid(tilesGuid), local);
  const decorTile = (local: number) => encodeTileGid(firstGid(decorTilesGuid), local);

  // Backdrop: three snowy peaks standing on the ground line, and clouds.
  const backdrop = new TileCanvas(MAP_W, MAP_H);
  paintMountain(backdrop, -1, 2, 3, tile);
  paintMountain(backdrop, 5, 2, 4, tile);
  paintMountain(backdrop, 12, 4, 3, tile);
  for (const [x, y] of CLOUDS) backdrop.set(x, y, tile(CELL.cloud));

  // Ground: dirt with a grass top (surface at row 1), a left cliff, a pool, crates,
  // a two-step ramp to the right plateau, a floating ledge and switch blocks.
  const ground = new TileCanvas(MAP_W, MAP_H);
  ground.fill(0, 0, MAP_W - 1, 0, tile(CELL.dirt));
  ground.fill(0, 1, 0, 2, tile(CELL.dirt));
  ground.set(0, 3, tile(CELL.grassRight));
  ground.fill(1, 1, 6, 1, tile(CELL.grass));
  ground.set(7, 1, tile(CELL.grassRight));
  ground.set(10, 1, tile(CELL.grassLeft));
  ground.set(5, 2, tile(CELL.crate));
  ground.set(6, 2, tile(CELL.crateCross));
  for (let step = 0; step < RAMP_STEPS; step++) {
    const x = 11 + step;
    const y = 2 + step;
    ground.set(x, y, tile(CELL.slopeUp));
    ground.set(x, y - 1, tile(CELL.grassCornerLeft));
    ground.fill(x, 1, x, y - 2, tile(CELL.dirt));
  }
  ground.fill(13, 1, MAP_W - 1, 2, tile(CELL.dirt));
  ground.fill(13, 3, MAP_W - 1, 3, tile(CELL.grass));
  ground.set(2, 4, tile(CELL.ledgeLeft));
  ground.set(3, 4, tile(CELL.ledgeMid));
  ground.set(4, 4, tile(CELL.ledgeRight));
  // Opposite phases, so the pair swaps orange and yellow.
  ground.set(9, 4, tile(CELL.lockOrange));
  ground.set(10, 4, tile(CELL.lockYellow));

  // Decor (second Tileset): the pool's animated water and torches draw over the robots.
  const decor = new TileCanvas(MAP_W, MAP_H);
  decor.fill(8, 1, 9, 1, decorTile(DECOR.waterTop));
  decor.set(1, 2, decorTile(DECOR.signRight));
  decor.set(2, 2, decorTile(DECOR.bush));
  decor.set(3, 2, decorTile(DECOR.tuft));
  decor.set(4, 2, decorTile(DECOR.mushroom));
  decor.set(7, 2, decorTile(DECOR.torch));
  decor.set(10, 2, decorTile(DECOR.tuft));
  decor.set(13, 4, decorTile(DECOR.torch));
  decor.set(15, 4, decorTile(DECOR.signExit));

  map = {
    ...map,
    layers: [
      {
        ...createTilemapLayer("backdrop", "Backdrop"),
        collision: false,
        sortingLayer: "Background",
        parallax: { x: 0.5, y: 1 },
        chunks: backdrop.chunks(CHUNK),
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

/** The Kenney sheet as an empty 128 px grid; atlas size equals the Texture. */
function platformerAtlas(ctx: FeatureTestContext): TilesetPayload {
  const textureGuid = requireRef(ctx.assets.textures.platformerTiles, "the Kenney platformer tilesheet Texture");
  const size = textureSize(ctx, textureGuid, "Kenney platformer tilesheet Texture");
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
  if (tilesetAtlasColumns(base) !== ATLAS_COLUMNS || tilesetAtlasRows(base) !== ATLAS_ROWS) {
    throw new Error("FeatureTest expects the 1664 × 1536 Kenney platformer tilesheet for the 2D Tilesets.");
  }
  return base;
}

/** Tile metadata by id; untouched cells keep the empty defaults. */
function withTileData(base: TilesetPayload, data: ReadonlyMap<number, Partial<TilesetTile>>): TilesetPayload {
  const tiles = base.tiles.map((entry): TilesetTile => ({ ...entry, ...data.get(entry.id), id: entry.id }));
  return normalizeTilesetPayload({ ...base, tiles });
}

/**
 * Terrain: full collision for dirt, grass tops, crates and switch blocks;
 * chain diagonals for the grass slopes; top-edge chains for the thin ledge
 * pieces; and two lock blocks that swap colors (animated, still solid).
 */
function terrainTileset(ctx: FeatureTestContext): TilesetPayload {
  const data = new Map<number, Partial<TilesetTile>>();
  const solid = [
    CELL.crate,
    CELL.crateCross,
    CELL.crateSlash,
    CELL.grassBlock,
    CELL.dirt,
    CELL.dirtBlock,
    CELL.islandLeft,
    CELL.islandRight,
    CELL.grassCornerRight,
    CELL.grassCornerLeft,
    CELL.grassLeft,
    CELL.grass,
    CELL.grassRight,
  ];
  for (const id of solid) data.set(id, { collision: "full", flags: FLAG_SOLID });
  data.set(CELL.slopeUp, { collision: { kind: "chain", points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }, flags: FLAG_RAMP });
  data.set(CELL.slopeDown, { collision: { kind: "chain", points: [{ x: 0, y: 1 }, { x: 1, y: 0 }] }, flags: FLAG_RAMP });
  for (const id of [CELL.ledge, CELL.ledgeLeft, CELL.ledgeMid, CELL.ledgeRight]) {
    data.set(id, { collision: { kind: "chain", points: [{ x: 0, y: 1 }, { x: 1, y: 1 }] }, flags: FLAG_PLATFORM });
  }
  const lock = (from: number, to: number): Partial<TilesetTile> => ({
    collision: "full",
    flags: FLAG_SOLID | FLAG_ANIMATED,
    animation: [from, to],
    animationFrameDurationMs: 450,
  });
  data.set(CELL.lockOrange, lock(CELL.lockOrange, CELL.lockYellow));
  data.set(CELL.lockYellow, lock(CELL.lockYellow, CELL.lockOrange));
  return withTileData(platformerAtlas(ctx), data);
}

/**
 * Decor (second Tileset on the same sheet, drawn as `:a1` chunk meshes): the
 * water surface bobs between its high and low cells, the torch flickers, and
 * plants, signs and torches carry the decor flag. No collision.
 */
function decorAtlasTileset(ctx: FeatureTestContext): TilesetPayload {
  const data = new Map<number, Partial<TilesetTile>>();
  for (const id of [DECOR.bush, DECOR.tuft, DECOR.mushroom, DECOR.signExit, DECOR.signLeft, DECOR.signRight, DECOR.torchUnlit]) {
    data.set(id, { flags: FLAG_DECOR });
  }
  data.set(DECOR.torch, {
    flags: FLAG_DECOR | FLAG_ANIMATED,
    animation: [DECOR.torch, DECOR.torchFlicker],
    animationFrameDurationMs: 160,
  });
  data.set(DECOR.torchFlicker, { flags: FLAG_DECOR });
  data.set(DECOR.water, { flags: FLAG_LIQUID });
  data.set(DECOR.waterTop, {
    flags: FLAG_LIQUID | FLAG_ANIMATED,
    animation: [DECOR.waterTop, DECOR.waterTopLow],
    animationFrameDurationMs: 420,
  });
  data.set(DECOR.waterTopLow, { flags: FLAG_LIQUID });
  return withTileData(platformerAtlas(ctx), data);
}

/**
 * Snow mountain whose base row is `y0`: `/` and `\` slopes rise `height` rows
 * to a two-tile peak; inner corners continue each slope's snow band.
 */
function paintMountain(
  canvas: TileCanvas,
  x0: number,
  y0: number,
  height: number,
  tile: (local: number) => number,
): void {
  const last = x0 + 2 * height - 1;
  for (let step = 0; step < height; step++) {
    const y = y0 + step;
    const left = x0 + step;
    const right = last - step;
    canvas.set(left, y, tile(CELL.snowSlopeUp));
    canvas.set(right, y, tile(CELL.snowSlopeDown));
    for (let x = left + 1; x < right; x++) {
      const id = x === left + 1 ? CELL.snowCornerLeft : x === right - 1 ? CELL.snowCornerRight : CELL.snow;
      canvas.set(x, y, tile(id));
    }
  }
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

  /** Paint a rectangle; cells outside the map are skipped. */
  fill(x0: number, y0: number, x1: number, y1: number, gid: number | ((x: number, y: number) => number)): void {
    for (let y = Math.max(0, y0); y <= Math.min(this.height - 1, y1); y++) {
      for (let x = Math.max(0, x0); x <= Math.min(this.width - 1, x1); x++) {
        this.cells[y * this.width + x] = typeof gid === "number" ? gid : gid(x, y);
      }
    }
  }

  set(x: number, y: number, gid: number): void {
    this.fill(x, y, x, y, gid);
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

/** World x of a tile column's center. */
function tileCenterX(column: number): number {
  return MAP_ORIGIN[0] + (column + 0.5) * TILE;
}

/** World y of a tile row's bottom edge (the top of the row below). */
function tileBottomY(row: number): number {
  return MAP_ORIGIN[1] + row * TILE;
}

/**
 * `FT_2D`: orthographic camera framing the whole map over a sky clear color,
 * the Tilemap (Background), falling robot bodies (Characters) of every 2D
 * Collider shape, a chain funnel, a 2D hinge pendulum (Default), and two
 * robots on the AnimationGraph: a UI-layer mascot on the left cliff and a
 * dynamic body on the plateau whose box follows each frame's collision rect.
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
    environmentColor: [...SKY_COLOR],
    cameraBounds2D: { width: MAP_W * TILE, height: MAP_H * TILE },
    grid: { ...scene.settings.grid, tileSize: TILE },
  };
  scene.folders.push(...Object.values(FOLDERS).map((folder) => ({ ...folder, parentFolderId: null })));
  const camera = scene.actors.find((entry) => entry.id === scene.settings.mainCameraActorId);
  const lens = camera?.components.find((component) => component.classId === "CameraComponent");
  if (!camera || !lens) throw new Error("FeatureTest FT_2D needs the default 2D camera.");
  lens.properties.orthographicSize = (MAP_H * TILE) / 2;
  camera.folderId = FOLDERS.world.id;

  const add = (
    folder: keyof typeof FOLDERS,
    id: string,
    name: string,
    position: Vec3,
    components: SerializedComponent[],
    scale = 1,
  ) =>
    ctx.addActor(
      actor(id, name, tf(position, scale === 1 ? {} : { scale: [scale, scale, scale] }), components, {
        folderId: FOLDERS[folder].id,
      }),
      { scene },
    );

  add("world", "ft-2d-tilemap", "World Tilemap", [MAP_ORIGIN[0], MAP_ORIGIN[1], 0], [
    comp("ft-2d-tilemap-map", "TilemapComponent", { assetGuid: refs.tilemap, sortingLayer: "Background", orderInLayer: 0 }),
  ]);
  // Floats over the crates, right of the ledge; robots sliding off the ledge end up in it.
  add("world", "ft-2d-funnel", "Chain Funnel", [tileCenterX(6), -1.2, 0], [
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
      add(
        "bodies",
        id,
        `${kind.title} Robot ${index + 1}`,
        [x, y, 0],
        [
          sprite(`${id}-sprite`, refs.sprites[kind.sprite], CHARACTERS, index),
          rigidBody(`${id}-body`, "dynamic", { mass: 1 }),
          collider(`${id}-collider`, kind.shape, { restitution: kind.restitution }, robotBodyOffset(kind)),
        ],
        BODY_SCALE,
      );
    });
  });

  // Feet on the left cliff top (row 3) and on the plateau (dropped 0.3 units).
  const robotHalfHeight = ROBOT_FRAME_PX.height / PPU / 2;
  add("animation", "ft-2d-anim-mascot", "Robot Mascot", [tileCenterX(0), tileBottomY(4) + robotHalfHeight, 0], [
    sprite("ft-2d-anim-mascot-sprite", refs.sprites.robotIdle, "UI", 0),
    comp("ft-2d-anim-mascot-graph", "AnimationGraphComponent", { graphGuid: refs.graph }),
  ]);
  add("animation", "ft-2d-anim-body", "Walking Robot", [tileCenterX(14), tileBottomY(4) + robotHalfHeight + 0.3, 0], [
    sprite("ft-2d-anim-body-sprite", refs.sprites.robotIdle, CHARACTERS, 100),
    comp("ft-2d-anim-body-graph", "AnimationGraphComponent", { graphGuid: refs.graph }),
    rigidBody("ft-2d-anim-body-body", "dynamic", { mass: 1 }),
    collider("ft-2d-anim-body-collider", BODY_KINDS[0]!.shape),
  ]);

  // Released horizontally above the plateau, the bob swings under the pivot without touching it or the walker.
  const pivot: Vec3 = [7.9, 3.6, 0];
  const length = 1.6;
  const bob = BODY_KINDS[1]!;
  add("pendulum", "ft-2d-pendulum-pivot", "Pendulum Pivot", pivot, [
    rigidBody("ft-2d-pendulum-pivot-body", "static"),
    collider("ft-2d-pendulum-pivot-collider", { kind: "circle", radius: 0.12 }, { renderInGame: true }),
  ]);
  add(
    "pendulum",
    "ft-2d-pendulum-bob",
    "Pendulum Bob",
    [pivot[0] - length, pivot[1], 0],
    [
      sprite("ft-2d-pendulum-bob-sprite", refs.sprites[bob.sprite], "Default", 0),
      rigidBody("ft-2d-pendulum-bob-body", "dynamic", { mass: 2 }),
      collider("ft-2d-pendulum-bob-collider", bob.shape, {}, robotBodyOffset(bob)),
      // Anchors are actor-local and scale with the actor.
      hinge("ft-2d-pendulum-bob-hinge", "ft-2d-pendulum-pivot", { x: length / BOB_SCALE, y: 0, z: 0 }),
    ],
    BOB_SCALE,
  );
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

/**
 * 2D Collider, validated with the strict simulation parser so a bad shape
 * fails the scaffold. `offset` is actor-local (scaled with the actor).
 */
function collider(
  id: string,
  shape: Shape2D,
  extra: Record<string, unknown> = {},
  offset: { x: number; y: number } = { x: 0, y: 0 },
): SerializedComponent {
  const transform = offset.x === 0 && offset.y === 0 ? undefined : tf([offset.x, offset.y, 0]);
  const component = comp(id, "ColliderComponent", { shape, ...extra }, transform, { physicsWorld: "2d" });
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

/** 1-based platformer tile id of a 128 px cell (row 0 is the top of the atlas). */
function cell(column: number, row: number): number {
  return row * ATLAS_COLUMNS + column + 1;
}

function robotTexture(ctx: FeatureTestContext, frame: RobotFrame): string {
  return requireRef(ctx.assets.textures.robotFrames[frame], `the robot ${frame} Texture`);
}

/** Robot frame pixel size; the measured bounds assume the 96 × 128 Kenney source. */
function robotFrameSize(ctx: FeatureTestContext, frame: RobotFrame): { width: number; height: number } {
  const size = textureSize(ctx, robotTexture(ctx, frame), `robot ${frame} Texture`);
  if (size.width !== ROBOT_FRAME_PX.width || size.height !== ROBOT_FRAME_PX.height) {
    throw new Error("FeatureTest expects 96 × 128 Kenney robot frames for the 2D Sprites.");
  }
  return size;
}

/** Normalized opaque bounds (y from the top) of a robot frame. */
function robotCollision(frame: RobotFrame): SpriteCollision {
  const [left, top, right, bottom] = ROBOT_BOUNDS[frame];
  const unit = (value: number, size: number) => Math.round((value / size) * 10_000) / 10_000;
  return {
    x: unit(left, ROBOT_FRAME_PX.width),
    y: unit(top, ROBOT_FRAME_PX.height),
    width: unit(right - left, ROBOT_FRAME_PX.width),
    height: unit(bottom - top, ROBOT_FRAME_PX.height),
  };
}

/**
 * Collider offset that centers a non-box shape on its pose's opaque bounds
 * (scale 1, +Y up). Box colliders already follow the frame rect at runtime.
 */
function robotBodyOffset(kind: (typeof BODY_KINDS)[number]): { x: number; y: number } {
  if (kind.shape.kind === "box2d") return { x: 0, y: 0 };
  const [left, top, right, bottom] = ROBOT_BOUNDS[ROBOT_SPRITES[kind.sprite].frame];
  const round = (value: number) => Math.round(value * 1000) / 1000;
  return {
    x: round(((left + right) / 2 - ROBOT_FRAME_PX.width / 2) / PPU),
    y: round((ROBOT_FRAME_PX.height / 2 - (top + bottom) / 2) / PPU),
  };
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
