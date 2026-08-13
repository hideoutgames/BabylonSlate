import type { Mesh, Scene } from "@babylonjs/core";
import type { SerializedActor, SerializedScene } from "@babylonslate/core";
import type { RenderScheduler } from "./render-scheduler";
import type { MeshAssetContext } from "./mesh-assets";
import {
  actorIdFromMeshName,
  applyActorTransform,
  createActorMesh,
} from "./scene-loader";
import { syncAuthoredIllumination } from "./scene-illumination";
import { applySortingToMesh, resolveSortingLayer } from "./sorting";

const DEFAULT_SORTING_LAYERS = ["Background", "Default", "Foreground", "UI"];

function spriteSortingOf(
  actor: SerializedActor,
): { layer: string; orderInLayer: number } | null {
  const component = actor.components.find(
    (entry) => entry.classId === "SpriteComponent",
  );
  if (!component) return null;
  const layer = component.properties.sortingLayer;
  const order = component.properties.orderInLayer;
  return {
    layer: typeof layer === "string" ? layer : "Default",
    orderInLayer: typeof order === "number" ? order : 0,
  };
}

function meshKindOf(actor: SerializedActor): string | null {
  const meshComponent = actor.components.find(
    (entry) => entry.classId === "MeshComponent",
  );
  const spriteComponent = actor.components.find(
    (entry) => entry.classId === "SpriteComponent",
  );
  const tilemapComponent = actor.components.find(
    (entry) => entry.classId === "TilemapComponent",
  );
  const lightComponent = actor.components.find(
    (entry) => entry.classId === "LightComponent",
  );
  const cameraComponent = actor.components.find(
    (entry) => entry.classId === "CameraComponent",
  );
  const asset =
    (typeof meshComponent?.properties.assetGuid === "string" &&
      meshComponent.properties.assetGuid) ||
    (typeof spriteComponent?.properties.assetGuid === "string" &&
      spriteComponent.properties.assetGuid) ||
    (typeof tilemapComponent?.properties.assetGuid === "string" &&
      tilemapComponent.properties.assetGuid) ||
    "";
  if (typeof meshComponent?.properties.meshKind === "string") {
    return `${meshComponent.properties.meshKind}:${asset}`;
  }
  if (spriteComponent) return `sprite:${asset}`;
  if (tilemapComponent) return `tilemap:${asset}`;
  if (lightComponent) {
    return `light:${String(lightComponent.properties.lightKind ?? "point")}`;
  }
  if (cameraComponent) return "camera";
  return null;
}

/**
 * Applies scene document edits to the Babylon editor scene incrementally, so a
 * gizmo drag touches one mesh instead of rebuilding the scene, and marks the
 * viewport dirty for the render-on-demand loop (engineplan §2.4).
 */
export class EditorSceneSync {
  private readonly meshes = new Map<string, Mesh>();
  private readonly meshKinds = new Map<string, string | null>();
  private readonly liveIds = new Set<string>();

  private readonly scene: Scene;
  private readonly scheduler?: Pick<RenderScheduler, "invalidate">;
  private sortingLayers: string[] = [...DEFAULT_SORTING_LAYERS];
  private assets: MeshAssetContext | undefined;
  private lastScene: SerializedScene | null = null;

  constructor(scene: Scene, scheduler?: Pick<RenderScheduler, "invalidate">) {
    this.scene = scene;
    this.scheduler = scheduler;
  }

  /** Ordered sorting layers from project settings, back to front. */
  setSortingLayers(layers: readonly string[]): void {
    this.sortingLayers =
      layers.length > 0 ? [...layers] : [...DEFAULT_SORTING_LAYERS];
  }

  setMeshAssets(assets: MeshAssetContext | undefined): void {
    this.assets = assets;
    for (const mesh of this.meshes.values()) mesh.dispose();
    this.meshes.clear();
    this.meshKinds.clear();
    if (this.lastScene) this.apply(this.lastScene);
  }

  apply(sceneData: SerializedScene): void {
    this.liveIds.clear();

    for (const actor of sceneData.actors) {
      this.liveIds.add(actor.id);
      const kind = meshKindOf(actor);
      let mesh = this.meshes.get(actor.id);
      if (mesh && this.meshKinds.get(actor.id) !== kind) {
        mesh.dispose();
        mesh = undefined;
      }
      if (!mesh) {
        mesh = createActorMesh(this.scene, actor, this.assets);
        this.meshes.set(actor.id, mesh);
        this.meshKinds.set(actor.id, kind);
      }
      applyActorTransform(mesh, actor);

      const sorting = spriteSortingOf(actor);
      if (sorting) {
        applySortingToMesh(
          mesh,
          resolveSortingLayer(
            this.sortingLayers,
            sorting.layer,
            sorting.orderInLayer,
          ),
        );
      }
    }

    for (const [actorId, mesh] of this.meshes) {
      if (!this.liveIds.has(actorId)) {
        mesh.dispose();
        this.meshes.delete(actorId);
        this.meshKinds.delete(actorId);
      }
    }

    for (const actor of sceneData.actors) {
      const mesh = this.meshes.get(actor.id);
      if (!mesh) continue;
      const parent = actor.parentId
        ? (this.meshes.get(actor.parentId) ?? null)
        : null;
      if (mesh.parent !== parent) {
        mesh.parent = parent;
      }
    }

    this.scheduler?.invalidate("asset");
    this.lastScene = sceneData;
    syncAuthoredIllumination(this.scene, sceneData, { stealActiveCamera: false });
  }

  meshForActor(actorId: string): Mesh | null {
    return this.meshes.get(actorId) ?? null;
  }

  actorForMesh(meshName: string): string | null {
    const actorId = actorIdFromMeshName(meshName);
    return actorId && this.meshes.has(actorId) ? actorId : null;
  }

  actorCount(): number {
    return this.meshes.size;
  }

  dispose(): void {
    for (const mesh of this.meshes.values()) {
      mesh.dispose();
    }
    this.meshes.clear();
    this.meshKinds.clear();
    this.liveIds.clear();
  }
}
