import {
  createSkyboxFaceTextureResult,
  newAssetGuid,
  normalizeAnimationPayload,
} from "@babylonslate/assets";
import { SKYBOX_FACE_KEYS } from "@babylonslate/core";
import { bundledAsciiTypeFace } from "@babylonslate/render/default-typeface";
import { MANNEQUIN_ACTOR_ID, MANNEQUIN_ASSET_FOLDER, MANNEQUIN_CLASS_FILE, MANNEQUIN_CLASS_ID } from "../scaffold-empty-3d";
import type { FeatureTestContext } from "./context";
import {
  FEATURE_TEST_HOLIDAY_MODELS,
  FEATURE_TEST_OPTIONAL_SLOTS,
  GEIST_FONT_PATH,
  HOLIDAY_COLORMAP_PATH,
  SKYBOX_NET_PATH,
  holidayModelPath,
} from "./engine-content-files";

const TEXTURES = "Textures";
const SKY = "Sky";
const MODELS = "Models";
const FONTS = "Fonts";

/** Engine billboard PNGs (already published) reused as UI icons. */
const UI_ICON_STEMS = ["camera", "audio", "particles", "point_light", "spot_light", "navmesh", "default"] as const;

/**
 * Import every source file FeatureTest needs: Textures (albedo + KTX2 encode,
 * pixel art, UI, skybox faces, Skybox Creator net, optional LUT), Holiday Pack
 * Models (the door brings rigid node Animations), and Fonts
 * (bundled ASCII facetype + Geist). Also records the Basic 3D Mannequin.
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
  for (const stem of UI_ICON_STEMS) {
    const bytes = await host.loadBytes(`engine-content/billboards/${stem}.png`);
    assets.textures.ui[stem] = single(await ctx.importFile(TEXTURES, `ui_${stem}.png`, bytes), "Texture").header.guid;
  }

  // Skybox faces stay uncompressed (`skybox` usage); the net is the Skybox Creator source.
  for (const key of SKYBOX_FACE_KEYS) {
    const guid = newAssetGuid();
    await ctx.createImportResult(
      SKY,
      `FT_Sky_${key}.babasset`,
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
    "FT_Sky_Net.babasset",
    createSkyboxFaceTextureResult({ name: "FT_Sky_Net", guid: netGuid, pngBytes: await host.loadBytes(SKYBOX_NET_PATH) }),
  );
  assets.textures.skyboxNet = netGuid;

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
  assets.fonts.geist = single(
    await ctx.importFile(FONTS, "FT_Geist.woff2", await host.loadBytes(GEIST_FONT_PATH)),
    "Font",
  ).header.guid;
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
