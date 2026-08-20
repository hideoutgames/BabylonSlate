import {
  Color3,
  Material,
  PBRMaterial,
  RawTexture,
  Texture,
  type Scene,
} from "@babylonjs/core";

export const ENGINE_DEFAULT_MATERIAL_NAME = "engineDefaultMaterial";
/** Repeats of the 2×2 checker across UV 0–1. */
export const ENGINE_DEFAULT_CHECKER_TILES = 8;

const CHECKER_LIGHT = 204; // 0.8 — same as a new surface Material baseColor
const CHECKER_DARK = 166; // ~0.65 — slightly darker grey

export function engineDefaultCheckerRgba(): Uint8Array {
  const light = [CHECKER_LIGHT, CHECKER_LIGHT, CHECKER_LIGHT, 255] as const;
  const dark = [CHECKER_DARK, CHECKER_DARK, CHECKER_DARK, 255] as const;
  return new Uint8Array([...light, ...dark, ...dark, ...light]);
}

export function isEngineDefaultMaterial(
  material: Material | null | undefined,
): boolean {
  return (
    material instanceof PBRMaterial &&
    material.name === ENGINE_DEFAULT_MATERIAL_NAME
  );
}

export function createEngineDefaultMaterial(scene: Scene): PBRMaterial {
  const texture = RawTexture.CreateRGBATexture(
    engineDefaultCheckerRgba(),
    2,
    2,
    scene,
    false,
    false,
    Texture.NEAREST_SAMPLINGMODE,
  );
  texture.wrapU = Texture.WRAP_ADDRESSMODE;
  texture.wrapV = Texture.WRAP_ADDRESSMODE;
  texture.uScale = ENGINE_DEFAULT_CHECKER_TILES;
  texture.vScale = ENGINE_DEFAULT_CHECKER_TILES;
  texture.hasAlpha = false;
  texture.name = `${ENGINE_DEFAULT_MATERIAL_NAME}:checker`;

  const material = new PBRMaterial(ENGINE_DEFAULT_MATERIAL_NAME, scene);
  material.unlit = false;
  material.disableLighting = false;
  material.metallic = 0;
  material.roughness = 0.5;
  material.transparencyMode = Material.MATERIAL_OPAQUE;
  material.backFaceCulling = true;
  material.twoSidedLighting = false;
  material.emissiveColor = new Color3(0, 0, 0);
  material.albedoColor = new Color3(1, 1, 1);
  material.albedoTexture = texture;
  return material;
}

export function installEngineDefaultMaterial(scene: Scene): PBRMaterial {
  const existing = scene.materials.find(isEngineDefaultMaterial);
  if (existing instanceof PBRMaterial) {
    scene.defaultMaterial = existing;
    return existing;
  }
  const material = createEngineDefaultMaterial(scene);
  scene.defaultMaterial = material;
  return material;
}
