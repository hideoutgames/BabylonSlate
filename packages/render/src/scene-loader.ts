import { MeshBuilder, Quaternion, Scene, Vector3 } from "@babylonjs/core";
import type { Mesh } from "@babylonjs/core";
import type { SerializedActor, SerializedScene } from "@babylonslate/core";
import { applyAlbedoTexture, type MeshAssetContext } from "./mesh-assets";
import { createMeshFromModelBytes } from "./model-mesh";
import { syncAuthoredIllumination } from "./scene-illumination";
import { createSpriteQuad } from "./sprite-quad";
import { createTilemapMeshes, worldTileSize } from "./tilemap-mesh";

/** Editor meshes are named so picking can map a hit back to an actor id. */
export const EDITOR_ACTOR_MESH_PREFIX = "editorActor:";

export function editorMeshName(actorId: string): string {
  return `${EDITOR_ACTOR_MESH_PREFIX}${actorId}`;
}

export function actorIdFromMeshName(meshName: string): string | null {
  return meshName.startsWith(EDITOR_ACTOR_MESH_PREFIX)
    ? meshName.slice(EDITOR_ACTOR_MESH_PREFIX.length)
    : null;
}

export function clearSceneMeshes(scene: Scene): void {
  scene.meshes.slice().forEach((mesh) => {
    if (mesh.name !== "__root__") {
      mesh.dispose();
    }
  });
}

/** Build a primitive mesh for editor or Play from a MeshComponent kind. */
export function createPrimitiveMesh(
  scene: Scene,
  name: string,
  meshKind: string | null | undefined,
): Mesh {
  switch (meshKind) {
    case "sphere":
      return MeshBuilder.CreateSphere(name, { diameter: 1.5 }, scene);
    case "cylinder":
      return MeshBuilder.CreateCylinder(name, { height: 1.5, diameter: 1 }, scene);
    case "plane":
    case "quad":
      return MeshBuilder.CreatePlane(name, { size: 1.5 }, scene);
    case "ground":
      return MeshBuilder.CreateGround(name, { width: 10, height: 10 }, scene);
    case "box":
      return MeshBuilder.CreateBox(name, { size: 1.5 }, scene);
    case "sprite":
      return createSpriteQuad(scene, name, {
        name: "idle",
        u: 0,
        v: 0,
        uSize: 1,
        vSize: 1,
        durationMs: 100,
        pivot: { x: 0.5, y: 0.5 },
        width: 100,
        height: 100,
      });
    case "tilemap":
      return MeshBuilder.CreatePlane(name, { size: 1 }, scene);
    default:
      // Actors without a renderable component still need a pickable proxy so
      // they can be selected and transformed in the viewport.
      return MeshBuilder.CreateBox(name, { size: 0.25 }, scene);
  }
}

function stringProp(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function createSpriteActorMesh(
  scene: Scene,
  name: string,
  actor: SerializedActor,
  assets?: MeshAssetContext,
): Mesh {
  const spriteComponent = actor.components.find(
    (component) => component.classId === "SpriteComponent",
  );
  const spriteGuid = stringProp(spriteComponent?.properties.assetGuid);
  const payload = spriteGuid ? assets?.spritePayloads?.get(spriteGuid) : undefined;
  const frame = payload?.frames[0];
  const mesh = frame
    ? createSpriteQuad(scene, name, frame, payload?.pixelsPerUnit ?? assets?.pixelsPerUnit)
    : createPrimitiveMesh(scene, name, "sprite");
  applyAlbedoTexture(mesh, scene, payload?.textureGuid, assets);
  return mesh;
}

function createTilemapActorMesh(
  scene: Scene,
  name: string,
  actor: SerializedActor,
  assets?: MeshAssetContext,
): Mesh {
  const tilemapComponent = actor.components.find(
    (component) => component.classId === "TilemapComponent",
  );
  const mapGuid = stringProp(tilemapComponent?.properties.assetGuid);
  const tilemap = mapGuid ? assets?.tilemaps?.get(mapGuid) : undefined;
  const tileset = tilemap?.tilesetGuid
    ? assets?.tilesets?.get(tilemap.tilesetGuid)
    : undefined;
  if (tilemap && tileset) {
    const size = worldTileSize(tilemap, assets?.pixelsPerUnit ?? 100);
    const mesh = createTilemapMeshes(
      scene,
      name,
      tilemap,
      tileset,
      size.width,
      size.height,
    );
    applyAlbedoTexture(mesh, scene, tileset.textureGuid, assets);
    return mesh;
  }
  return createPrimitiveMesh(scene, name, "tilemap");
}

/** Build the Babylon mesh for an actor's first renderable component. */
export function createActorMesh(
  scene: Scene,
  actor: SerializedActor,
  assets?: MeshAssetContext,
): Mesh {
  const name = editorMeshName(actor.id);
  const meshComponent = actor.components.find(
    (component) => component.classId === "MeshComponent",
  );
  const spriteComponent = actor.components.find(
    (component) => component.classId === "SpriteComponent",
  );
  const tilemapComponent = actor.components.find(
    (component) => component.classId === "TilemapComponent",
  );
  if (!meshComponent && spriteComponent) {
    return createSpriteActorMesh(scene, name, actor, assets);
  }
  if (!meshComponent && !spriteComponent && tilemapComponent) {
    return createTilemapActorMesh(scene, name, actor, assets);
  }
  const assetGuid = stringProp(meshComponent?.properties.assetGuid);
  if (assetGuid && assets?.modelBytes?.has(assetGuid)) {
    const loaded = createMeshFromModelBytes(
      scene,
      name,
      assets.modelBytes.get(assetGuid)!,
    );
    if (loaded) return loaded;
  }
  const meshKind =
    typeof meshComponent?.properties.meshKind === "string"
      ? meshComponent.properties.meshKind
      : null;
  return createPrimitiveMesh(scene, name, meshKind);
}

export function applyActorTransform(mesh: Mesh, actor: SerializedActor): void {
  const [px, py, pz] = actor.transform.position;
  const [rx, ry, rz, rw] = actor.transform.rotation;
  const [sx, sy, sz] = actor.transform.scale;
  mesh.position.set(px, py, pz);
  if (!mesh.rotationQuaternion) {
    mesh.rotationQuaternion = new Quaternion(rx, ry, rz, rw);
  } else {
    mesh.rotationQuaternion.set(rx, ry, rz, rw);
  }
  mesh.scaling.set(sx, sy, sz);
  mesh.isVisible = actor.visible;
  mesh.isPickable = !actor.locked;
}

/** Full rebuild of the editor scene; `EditorSceneSync` does incremental work. */
export function applySceneToBabylonScene(
  scene: Scene,
  sceneData: SerializedScene,
  assets?: MeshAssetContext,
): void {
  clearSceneMeshes(scene);

  const meshes = new Map<string, Mesh>();
  for (const actor of sceneData.actors) {
    const mesh = createActorMesh(scene, actor, assets);
    applyActorTransform(mesh, actor);
    meshes.set(actor.id, mesh);
  }

  for (const actor of sceneData.actors) {
    if (!actor.parentId) continue;
    const mesh = meshes.get(actor.id);
    const parent = meshes.get(actor.parentId);
    if (mesh && parent) {
      mesh.parent = parent;
    }
  }

  syncAuthoredIllumination(scene, sceneData);
}

export function countSceneMeshes(scene: Scene): number {
  return scene.meshes.filter((mesh) => mesh.name !== "__root__").length;
}

export function toVector3(value: [number, number, number]): Vector3 {
  return new Vector3(value[0], value[1], value[2]);
}
