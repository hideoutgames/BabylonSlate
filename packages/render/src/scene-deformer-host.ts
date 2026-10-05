import type { AbstractMesh, Scene } from "@babylonjs/core";
import type { DeformerBinding, SerializedScene } from "@babylonslate/core";
import {
  disposeMeshLatticeDeformer,
  refreshMeshLatticeDeformer,
  setMeshLatticeDeformer,
} from "./lattice-deformer";

type Target = { mesh: AbstractMesh; key: string; binding: DeformerBinding };

/** Live cage controls retain the scene's assets, effects and geometry topology. */
export function isDeformerOnlySceneEdit(previous: SerializedScene | null, next: SerializedScene): boolean {
  if (!previous || previous === next) return false;
  const otherState = (scene: SerializedScene) => ({ ...scene, actors: scene.actors.map((actor) => ({
    ...actor, components: actor.components.map((component) => component.classId === "DeformerComponent"
      ? { ...component, properties: {} } : component),
  })) });
  return JSON.stringify(otherState(previous)) === JSON.stringify(otherState(next));
}

/** Retains component identity across async model replacement, without touching geometry. */
export class SceneDeformerHost {
  private readonly scene: Scene;
  private readonly actors = new Map<string, Map<string, Target>>();
  private disposed = false;

  constructor(scene: Scene) { this.scene = scene; }

  setActor(
    actorId: string,
    bindings: readonly DeformerBinding[],
    resolve: (componentId: string) => AbstractMesh | null,
    refreshGeometry = false,
  ): void {
    if (this.disposed) return;
    const previous = this.actors.get(actorId) ?? new Map<string, Target>();
    const next = new Map<string, Target>();
    const changed = new Set<AbstractMesh>();
    try {
      for (const binding of bindings) {
        if (!binding.enabled || next.has(binding.targetMeshComponentId)) continue;
        const mesh = resolve(binding.targetMeshComponentId);
        if (!mesh || mesh.isDisposed() || mesh.getScene() !== this.scene) continue;
        const key = JSON.stringify(binding);
        const retained = previous.get(binding.targetMeshComponentId);
        if (retained?.mesh !== mesh || retained.key !== key) {
          changed.add(mesh);
          setMeshLatticeDeformer(mesh, binding);
        }
        if (refreshGeometry) refreshMeshLatticeDeformer(mesh);
        next.set(binding.targetMeshComponentId, { mesh, key, binding: structuredClone(binding) });
      }
    } catch (error) {
      // A rejected GPU allocation or material adapter must not leak a partial
      // actor update when the command owner retains its previous snapshot.
      const failures: unknown[] = [error];
      for (const mesh of changed) {
        const retained = [...previous.values()].find((target) => target.mesh === mesh);
        try { setMeshLatticeDeformer(mesh, retained?.binding ?? null); }
        catch (rollbackError) { failures.push(rollbackError); }
      }
      if (failures.length > 1) throw new AggregateError(failures, "Deformer update could not restore its previous bindings");
      throw error;
    }
    for (const [id, target] of previous) {
      if (next.get(id)?.mesh !== target.mesh) disposeMeshLatticeDeformer(target.mesh);
    }
    if (next.size) this.actors.set(actorId, next);
    else this.actors.delete(actorId);
  }

  retainActors(ids: ReadonlySet<string>): void {
    for (const id of this.actors.keys()) if (!ids.has(id)) this.removeActor(id);
  }

  removeActor(id: string): void {
    const actor = this.actors.get(id);
    if (!actor) return;
    for (const target of actor.values()) disposeMeshLatticeDeformer(target.mesh);
    this.actors.delete(id);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of this.actors.keys()) this.removeActor(id);
  }
}
