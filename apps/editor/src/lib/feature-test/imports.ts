import {
  createSkyboxFaceTextureResult,
  newAssetGuid,
  normalizeAnimationPayload,
  normalizeFontPayload,
} from "@haptic/assets";
import { SKYBOX_FACE_KEYS } from "@haptic/core";
import { bundledAsciiTypeFace } from "@haptic/render/default-typeface";
import { encodeRgbaPng } from "@haptic/render/png-encode";
import { MANNEQUIN_ACTOR_ID, MANNEQUIN_ASSET_FOLDER, MANNEQUIN_CLASS_FILE, MANNEQUIN_CLASS_ID } from "../scaffold-empty-3d";
import type { FeatureTestContext } from "./context";
import {
  ARK_PIXEL_FONTS,
  FEATURE_TEST_HOLIDAY_MODELS,
  FEATURE_TEST_OPTIONAL_SLOTS,
  ONEST_FONT_PATH,
  HOLIDAY_COLORMAP_PATH,
  PLATFORMER_TILESHEET_PATH,
  ROBOT_FRAMES,
  SKYBOX_NET_PATH,
  holidayModelPath,
  robotFramePath,
} from "./engine-content-files";

const TEXTURES = "Textures";
const SKY = "Sky";
const MODELS = "Models";
const FONTS = "Fonts";

/** The generated sprite sheet's grid: Columns × Rows cells of `cell` pixels. */
export const FEATURE_TEST_SPRITE_SHEET = { columns: 4, rows: 4, cell: 16 } as const;

/**
 * The sprite sheet's RGBA pixels, computed from numbers (no artwork): cell c (from the top
 * left, row by row) is a disc whose hue steps around the colour wheel and whose radius grows
 * with c % 4, on a transparent background, so each frame of a flipbook reads differently.
 */
export function featureTestSpriteSheetPixels(): { width: number; height: number; rgba: Uint8Array } {
  const { columns, rows, cell } = FEATURE_TEST_SPRITE_SHEET;
  const width = columns * cell;
  const height = rows * cell;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = Math.floor(y / cell) * columns + Math.floor(x / cell);
      const dx = (x % cell) + 0.5 - cell / 2;
      const dy = (y % cell) + 0.5 - cell / 2;
      const radius = 3 + (index % 4) * 1.5;
      const inside = Math.hypot(dx, dy) <= radius;
      // Hue sextants: full saturation and value.
      const hue = (index / (columns * rows)) * 6;
      const fall = 1 - Math.abs((hue % 2) - 1);
      const [r, g, b] = [[1, fall, 0], [fall, 1, 0], [0, 1, fall], [0, fall, 1], [fall, 0, 1], [1, 0, fall]][Math.floor(hue) % 6]!;
      const offset = (y * width + x) * 4;
      rgba[offset] = Math.round(r * 255);
      rgba[offset + 1] = Math.round(g * 255);
      rgba[offset + 2] = Math.round(b * 255);
      rgba[offset + 3] = inside ? 255 : 0;
    }
  }
  return { width, height, rgba };
}

/** Engine billboard PNGs (already published) reused as UI icons. */
const UI_ICON_STEMS = ["camera", "audio", "particles", "point_light", "spot_light", "navmesh", "default"] as const;

/**
 * Import every source file FeatureTest needs: Textures (albedo + KTX2 encode,
 * pixel art, Kenney platformer tiles and robot frames, UI, skybox faces,
 * Skybox Creator net, optional LUT), Holiday Pack
 * Models (the door brings rigid node Animations), and Fonts
 * (bundled ASCII facetype + Onest). Also records the Basic 3D Mannequin.
 */
export async function importFeatureTestContent(ctx: FeatureTestContext): Promise<void> {
  const { host, assets } = ctx;
  recordMannequin(ctx);

  const colormap = await host.loadBytes(HOLIDAY_COLORMAP_PATH);
  // File names choose the usage: plain → compressed albedo, `_tileset` → pixel art, `ui_` → UI.
  assets.textures.colormap = single(await ctx.importFile(TEXTURES, "FT_Colormap.png", colormap), "Texture").header.guid;
  assets.textures.colormapPixelArt = single(
    await ctx.importFile(TEXTURES, "FT_Colormap_tileset.png", colormap),
    "Texture",
  ).header.guid;
  // `_tileset` / `_sprite` names select uncompressed Pixel Art usage.
  assets.textures.platformerTiles = single(
    await ctx.importFile(TEXTURES, "FT_PlatformerTiles_tileset.png", await host.loadBytes(PLATFORMER_TILESHEET_PATH)),
    "Texture",
  ).header.guid;
  for (const frame of ROBOT_FRAMES) {
    assets.textures.robotFrames[frame] = single(
      await ctx.importFile(TEXTURES, `FT_Robot_${frame}_sprite.png`, await host.loadBytes(robotFramePath(frame))),
      "Texture",
    ).header.guid;
  }
  for (const stem of UI_ICON_STEMS) {
    const bytes = await host.loadBytes(`engine-content/billboards/${stem}.png`);
    assets.textures.ui[stem] = single(await ctx.importFile(TEXTURES, `ui_${stem}.png`, bytes), "Texture").header.guid;
  }

  // Skybox faces stay uncompressed (`skybox` usage); the net is the Skybox Creator source.
  for (const key of SKYBOX_FACE_KEYS) {
    const guid = newAssetGuid();
    await ctx.createImportResult(
      SKY,
      `FT_Sky_${key}.hasset`,
      createSkyboxFaceTextureResult({
        name: `FT_Sky_${key}`,
        guid,
        pngBytes: await host.loadBytes(`engine-content/skybox/${key}.png`),
      }),
    );
    assets.textures.skyFaces[key] = guid;
  }
  const netGuid = newAssetGuid();
  await ctx.createImportResult(
    SKY,
    "FT_Sky_Net.hasset",
    createSkyboxFaceTextureResult({ name: "FT_Sky_Net", guid: netGuid, pngBytes: await host.loadBytes(SKYBOX_NET_PATH) }),
  );
  assets.textures.skyboxNet = netGuid;

  const sheet = featureTestSpriteSheetPixels();
  assets.textures.spriteSheet = single(
    await ctx.importFile(TEXTURES, "FT_SpriteSheet_sprite.png", encodeRgbaPng(sheet.width, sheet.height, sheet.rgba)),
    "Texture",
  ).header.guid;

  const lut = await host.loadOptional(FEATURE_TEST_OPTIONAL_SLOTS.colorGradingLut);
  assets.textures.colorGradingLut = lut
    ? single(await ctx.importFile(TEXTURES, "FT_Grade_lut.png", lut.bytes), "Texture").header.guid
    : null;

  // Holiday Pack GLBs reference Textures/colormap.png; embed it so materials keep their albedo.
  const sidecars = { "Textures/colormap.png": colormap, "colormap.png": colormap };
  for (const stem of FEATURE_TEST_HOLIDAY_MODELS) {
    const created = await ctx.importFile(MODELS, `${stem}.glb`, await host.loadBytes(holidayModelPath(stem)), {
      modelImportScale: host.modelImportScale,
      sidecars,
    });
    assets.models[stem] = single(created, "Model").header.guid;
    if (stem === "cabin-door-rotate") {
      // A rigid node animation (no Skeleton): the door swings open and closed.
      for (const animation of created.filter((asset) => asset.header.type === "Animation")) {
        assets.doorAnimations[normalizeAnimationPayload(animation.header.payload).clipName] = animation.header.guid;
      }
    }
  }

  const facetype = await ctx.importFile(
    FONTS,
    "FT_Ascii.facetype.json",
    new TextEncoder().encode(JSON.stringify(bundledAsciiTypeFace)),
  );
  assets.fonts.facetype = single(facetype, "Font").header.guid;
  assets.fonts.onest = single(
    await ctx.importFile(FONTS, "FT_Onest.woff2", await host.loadBytes(ONEST_FONT_PATH)),
    "Font",
  ).header.guid;
  // A pixel Font: an imported source Font given its Pixel Size, as Pixel Art Optimized projects set it.
  const ark = ARK_PIXEL_FONTS[0];
  const arkFont = single(await ctx.importFile(FONTS, "FT_ArkPixel.woff2", await host.loadBytes(ark.path)), "Font");
  await ctx.saveDocument("font", FONTS, arkFont.path.slice(arkFont.path.lastIndexOf("/") + 1), {
    ...normalizeFontPayload(arkFont.header.payload, ark.name),
    family: ark.name,
    pixelSize: ark.pixelSize,
  });
  assets.fonts.arkPixel = arkFont.header.guid;
}

function single<T extends { header: { type: string } }>(created: readonly T[], type: string): T {
  const found = created.find((asset) => asset.header.type === type);
  if (!found) throw new Error(`FeatureTest import did not create a ${type}.`);
  return found;
}

/** Basic 3D already imported the Mannequin; FeatureTest reuses it instead of importing again. */
function recordMannequin(ctx: FeatureTestContext): void {
  const inFolder = ctx.registry
    .list()
    .filter((asset) => asset.rootId === "project" && asset.path.startsWith(`assets/${MANNEQUIN_ASSET_FOLDER}/`));
  const model = inFolder.find((asset) => asset.header.type === "Model");
  const skeleton = inFolder.find((asset) => asset.header.type === "Skeleton");
  const graph = inFolder.find((asset) => asset.header.type === "AnimationGraph");
  const classAsset = ctx.registry.getByPath(`assets/${MANNEQUIN_CLASS_FILE}`);
  if (!model || !skeleton || !graph || !classAsset) {
    throw new Error("FeatureTest needs the Basic 3D Mannequin scaffold first.");
  }
  const animations: Record<string, string> = {};
  for (const animation of inFolder.filter((asset) => asset.header.type === "Animation")) {
    animations[normalizeAnimationPayload(animation.header.payload).clipName] = animation.header.guid;
  }
  Object.assign(ctx.assets.mannequin, {
    modelGuid: model.header.guid,
    skeletonGuid: skeleton.header.guid,
    animations,
    idleGraphGuid: graph.header.guid,
    classId: MANNEQUIN_CLASS_ID,
    classPath: classAsset.path,
    actorId: MANNEQUIN_ACTOR_ID,
  });
}
