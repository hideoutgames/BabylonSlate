import {
  CubeTexture,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  Texture,
  type AbstractEngine,
  type AbstractMesh,
  type Scene,
} from "@babylonjs/core";
import {
  DEFAULT_SKYBOX_SIZE,
  SKYBOX_FACE_KEYS,
  emptySkyboxFaces,
  parseSkyboxFaces,
  parseSkyboxSize,
  skyboxFaceGuids,
  type SkyboxFaceKey,
  type SkyboxFaces,
} from "@babylonslate/core";
import {
  DEFAULT_SKYBOX_FACE_SIZE,
  generateDefaultSkyboxFaceRgba,
} from "./default-skybox/faces";
import { encodePngRgba } from "./default-skybox/png";
import type { MeshAssetContext } from "./mesh-assets";
import {
  createEngineCubeTextureFromImages,
  type ResourceCache,
} from "./resource-cache";

export const ENGINE_DEFAULT_SKYBOX_GUID = "engine-default-skybox";

const defaultCubeByEngine = new WeakMap<AbstractEngine, CubeTexture>();

export function isSkyboxMesh(mesh: AbstractMesh): boolean {
  return Boolean((mesh.metadata as { skybox?: boolean } | null)?.skybox);
}

export function createGeometricDaylightCubeTexture(
  scene: Scene,
  cache?: ResourceCache,
): CubeTexture {
  const files = SKYBOX_FACE_KEYS.map((key) =>
    urlForBytes(
      `${ENGINE_DEFAULT_SKYBOX_GUID}:${key}`,
      defaultFacePng(key),
      cache,
    ),
  );
  if (cache) {
    return cache.getCubeTextureFromImages(ENGINE_DEFAULT_SKYBOX_GUID, scene, files);
  }
  return createEngineCubeTextureFromImages(scene.getEngine(), files);
}

function defaultFacePng(face: SkyboxFaceKey): Uint8Array {
  return encodePngRgba(
    DEFAULT_SKYBOX_FACE_SIZE,
    DEFAULT_SKYBOX_FACE_SIZE,
    generateDefaultSkyboxFaceRgba(face, DEFAULT_SKYBOX_FACE_SIZE),
  );
}

function urlForBytes(
  guid: string,
  bytes: Uint8Array | Blob,
  cache?: ResourceCache,
): string {
  if (cache) return cache.blobUrlFor(guid, bytes);
  const blob =
    bytes instanceof Blob ? bytes : new Blob([bytes], { type: "image/png" });
  return typeof URL !== "undefined" && URL.createObjectURL
    ? URL.createObjectURL(blob)
    : `blob:babylonslate/${guid}`;
}

function defaultSkyboxCubeTexture(
  scene: Scene,
  cache?: ResourceCache,
): CubeTexture {
  if (cache) {
    return createGeometricDaylightCubeTexture(scene, cache);
  }
  const engine = scene.getEngine();
  const existing = defaultCubeByEngine.get(engine);
  if (existing?.getInternalTexture()) return existing;
  const texture = createGeometricDaylightCubeTexture(scene);
  defaultCubeByEngine.set(engine, texture);
  return texture;
}

export function resolveSkyboxCubeTexture(
  scene: Scene,
  faces: SkyboxFaces = emptySkyboxFaces(),
  assets?: MeshAssetContext,
): CubeTexture {
  const parsed = parseSkyboxFaces(faces);
  const cache = assets?.resourceCache;
  if (skyboxFaceGuids(parsed).length === 0) {
    return defaultSkyboxCubeTexture(scene, cache);
  }
  const files = SKYBOX_FACE_KEYS.map((key) => {
    const guid = parsed[key];
    const bytes = guid ? assets?.textureBytes?.get(guid) : undefined;
    if (guid && bytes) {
      return urlForBytes(guid, bytes, cache);
    }
    return urlForBytes(
      `${ENGINE_DEFAULT_SKYBOX_GUID}:${key}`,
      defaultFacePng(key),
      cache,
    );
  });
  const cacheKey = `skybox:${SKYBOX_FACE_KEYS.map((key) => parsed[key] ?? "default").join(",")}`;
  if (cache) {
    return cache.getCubeTextureFromImages(cacheKey, scene, files);
  }
  return createEngineCubeTextureFromImages(scene.getEngine(), files);
}

export function createSkyboxMesh(
  scene: Scene,
  name: string,
  cubeTexture: CubeTexture,
  size = DEFAULT_SKYBOX_SIZE,
): Mesh {
  const mesh = MeshBuilder.CreateBox(name, { size: parseSkyboxSize(size) }, scene);
  const material = new PBRMaterial(`${name}:skybox`, scene);
  material.backFaceCulling = false;
  material.disableLighting = true;
  material.twoSidedLighting = true;
  cubeTexture.coordinatesMode = Texture.SKYBOX_MODE;
  material.reflectionTexture = cubeTexture;
  mesh.material = material;
  mesh.infiniteDistance = true;
  mesh.ignoreCameraMaxZ = true;
  mesh.receiveShadows = false;
  mesh.applyFog = false;
  mesh.isPickable = false;
  mesh.metadata = { ...(mesh.metadata ?? {}), skybox: true };
  return mesh;
}

export function createSkyboxMeshForFaces(
  scene: Scene,
  name: string,
  faces: unknown,
  size: unknown,
  assets?: MeshAssetContext,
): Mesh {
  return createSkyboxMesh(
    scene,
    name,
    resolveSkyboxCubeTexture(scene, parseSkyboxFaces(faces), assets),
    parseSkyboxSize(size),
  );
}
