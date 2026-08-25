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
  type SkyboxFaces,
} from "@babylonslate/core";
import { engineDefaultSkyboxFaceUrl } from "./default-skybox/faces";
import type { MeshAssetContext } from "./mesh-assets";
import {
  createEngineCubeTextureFromImages,
  type ResourceCache,
} from "./resource-cache";
import { RENDERING_GROUP } from "./sorting";

export { encodePngRgba } from "./default-skybox/png";

export const ENGINE_DEFAULT_SKYBOX_GUID = "engine-default-skybox";

/** ResourceCache key for a skybox cubemap (not a project Texture guid). */
export function skyboxCubeCacheGuid(faces?: SkyboxFaces | null): string {
  const parsed = parseSkyboxFaces(faces);
  if (skyboxFaceGuids(parsed).length === 0) return ENGINE_DEFAULT_SKYBOX_GUID;
  return `skybox:${SKYBOX_FACE_KEYS.map((key) => parsed[key] ?? "default").join(",")}`;
}

export function skyboxCubeCacheGuidsFromScene(
  scene:
    | {
        actors: ReadonlyArray<{
          components: ReadonlyArray<{
            classId: string;
            properties: Record<string, unknown>;
          }>;
        }>;
      }
    | null
    | undefined,
): string[] {
  const guids = new Set<string>();
  for (const actor of scene?.actors ?? []) {
    for (const component of actor.components) {
      if (component.classId !== "SkyboxComponent") continue;
      guids.add(skyboxCubeCacheGuid(parseSkyboxFaces(component.properties.faces)));
    }
  }
  return [...guids];
}

const defaultCubeByEngine = new WeakMap<AbstractEngine, CubeTexture>();

export function isSkyboxMesh(mesh: AbstractMesh): boolean {
  return Boolean((mesh.metadata as { skybox?: boolean } | null)?.skybox);
}

export function createEngineDefaultCubeTexture(
  scene: Scene,
  cache?: ResourceCache,
): CubeTexture {
  const files = SKYBOX_FACE_KEYS.map((key) => engineDefaultSkyboxFaceUrl(key));
  if (cache) {
    return cache.getCubeTextureFromImages(ENGINE_DEFAULT_SKYBOX_GUID, scene, files);
  }
  return createEngineCubeTextureFromImages(scene.getEngine(), files);
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
    return createEngineDefaultCubeTexture(scene, cache);
  }
  const engine = scene.getEngine();
  const existing = defaultCubeByEngine.get(engine);
  if (existing?.getInternalTexture()) return existing;
  const texture = createEngineDefaultCubeTexture(scene);
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
    return engineDefaultSkyboxFaceUrl(key);
  });
  const cacheKey = skyboxCubeCacheGuid(parsed);
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
  material.onDisposeObservable.add(() => {
    if (material.reflectionTexture === cubeTexture) {
      material.reflectionTexture = null;
    }
  });
  mesh.material = material;
  mesh.ignoreCameraMaxZ = true;
  mesh.receiveShadows = false;
  mesh.applyFog = false;
  mesh.isPickable = false;
  mesh.renderingGroupId = RENDERING_GROUP.background;
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
