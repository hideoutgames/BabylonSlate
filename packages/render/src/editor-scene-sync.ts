import type { Mesh, Scene } from "@babylonjs/core";
import type { SerializedActor, SerializedScene } from "@babylonslate/core";
import type { RenderScheduler } from "./render-scheduler";
import {
  actorIdFromMeshName,
  applyActorTransform,
  createActorMesh,
} from "./scene-loader";

function meshKindOf(actor: SerializedActor): string | null {
  const component = actor.components.find(
    (entry) => entry.classId === "MeshComponent",
  );
  return typeof component?.properties.meshKind === "string"
    ? component.properties.meshKind
    : null;
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

  constructor(scene: Scene, scheduler?: Pick<RenderScheduler, "invalidate">) {
    this.scene = scene;
    this.scheduler = scheduler;
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
        mesh = createActorMesh(this.scene, actor);
        this.meshes.set(actor.id, mesh);
        this.meshKinds.set(actor.id, kind);
      }
      applyActorTransform(mesh, actor);
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
