import {
  CubeTexture,
  Mesh,
  MeshBuilder,
  PBRMaterial,
  Texture,
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
  resourceCacheForEngine,
  type TextureResources,
  type ResourceLease,
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


export function isSkyboxMesh(mesh: AbstractMesh): boolean {
  return Boolean((mesh.metadata as { skybox?: boolean } | null)?.skybox);
}

export function createEngineDefaultCubeTexture(scene: Scene, cache: TextureResources = resourceCacheForEngine(scene.getEngine())): ResourceLease<CubeTexture> {
  return cache.acquireCubeTextureFromImages(ENGINE_DEFAULT_SKYBOX_GUID, scene, SKYBOX_FACE_KEYS.map(engineDefaultSkyboxFaceUrl));
}

export function resolveSkyboxCubeTexture(scene: Scene, faces: SkyboxFaces = emptySkyboxFaces(), assets?: MeshAssetContext): ResourceLease<CubeTexture> {
  const parsed = parseSkyboxFaces(faces);
  const cache = assets?.resourceCache ?? resourceCacheForEngine(scene.getEngine());
  if (skyboxFaceGuids(parsed).length === 0) return createEngineDefaultCubeTexture(scene, cache);
  const sources: ResourceLease<string>[] = [];
  const pendingSources: ResourceLease<string>[] = [];
  try {
    const files = SKYBOX_FACE_KEYS.map((key) => {
      const guid = parsed[key];
      const bytes = guid ? assets?.textureBytes?.get(guid) : undefined;
      if (!guid || !bytes) return engineDefaultSkyboxFaceUrl(key);
      const lease = cache.acquireBlobUrl(guid, bytes);
      sources.push(lease);
      // Native cube upload may outlive a handle's outstanding-lease safety net.
      pendingSources.push(cache.acquireExisting(lease.resource));
      return lease.resource;
    });
    const cube = cache.acquireCubeTextureFromImages(skyboxCubeCacheGuid(parsed), scene, files);
    const finishPreparation = () => { for (const source of pendingSources) source.release(); };
    if (cube.ready) void cube.ready.then(finishPreparation, finishPreparation); else finishPreparation();
    let released = false;
    return { resource: cube.resource, key: cube.key, ready: cube.ready, release() {
      if (released) return;
      released = true;
      cube.release();
      for (const source of sources) source.release();
    } };
  } catch (error) {
    for (const source of pendingSources) source.release();
    for (const source of sources) source.release();
    throw error;
  }
}

export function createSkyboxMesh(
  scene: Scene,
  name: string,
  cubeLease: ResourceLease<CubeTexture>,
  size = DEFAULT_SKYBOX_SIZE,
): Mesh {
  const cubeTexture = cubeLease.resource;
  const mesh = MeshBuilder.CreateBox(name, { size: parseSkyboxSize(size) }, scene);
  const material = new PBRMaterial(`${name}:skybox`, scene);
  material.backFaceCulling = false;
  material.disableLighting = true;
  material.twoSidedLighting = true;
  // Infinite-far sky depth is not comparable with ordinary camera depth.
  material.disableDepthWrite = true;
  cubeTexture.coordinatesMode = Texture.SKYBOX_MODE;
  material.reflectionTexture = cubeTexture;
  material.onDisposeObservable.add(() => {
    if (material.reflectionTexture === cubeTexture) {
      material.reflectionTexture = null;
    }
  });
  mesh.material = material;
  mesh.onDisposeObservable.addOnce(() => { material.dispose(false, false); cubeLease.release(); });
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
