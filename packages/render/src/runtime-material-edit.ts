import { Mesh, type Material, type NodeMaterial } from "@babylonjs/core";
import type { CommandMessage, MaterialParameterValue, RuntimeMaterialEditPreparation } from "@babylonslate/bridge";
import { MaterialLibrary, ownedMaterialPreparation } from "./material-library";
import { prewarmMaterial } from "./material-compiler";
import { applyMaterialBounds } from "./material-bounds";
import { applyMaterialToActorMeshes, componentIdForPlayMesh, meshForPlayComponent, wantsOverlayUnlitMaterial,
  type SnapshotSceneBinding } from "./snapshot-apply";

export type RuntimeMaterialPreparationRequest = RuntimeMaterialEditPreparation;
export type RuntimeMaterialCommitCommand = Extract<CommandMessage, { type: "assignMaterial" | "setMaterialParameter" }> & { preparedEditToken?: string };
type Stage = {
  request: RuntimeMaterialPreparationRequest; key: string; targetKey: string;
  root: Mesh; component: Mesh; targets: Mesh[]; before: string; unlit: boolean;
  values: Map<string, MaterialParameterValue>; material?: NodeMaterial;
  ready: boolean;
};

/** Explicit live-edit preparation. Never attaches a candidate before exact texture,
 * shader and lifetime admission; ordinary gameplay assignment stays on its existing path. */
export class RuntimeMaterialEditOwner {
  private readonly binding: SnapshotSceneBinding;
  private readonly library: MaterialLibrary;
  private readonly stages = new Map<string, Stage>();
  private disposed = false;
  constructor(binding: SnapshotSceneBinding, library: MaterialLibrary) { this.binding = binding; this.library = library; }

  async prepare(request: RuntimeMaterialPreparationRequest): Promise<void> {
    if (this.disposed) throw new Error("The material edit owner has stopped.");
    if (!request.editToken || request.editToken.length > 256 || this.stages.has(request.editToken) || this.stages.size >= 8)
      throw new Error("Material preparation token is invalid or the pending limit was reached.");
    const binding = this.binding;
    const root = binding.meshes.get(request.slotId);
    const component = meshForPlayComponent(binding, request.slotId, request.componentId);
    if (!root || !component || binding.meshSorting.get(request.slotId)?.actorGuid !== request.actorGuid)
      throw new Error("The material target no longer belongs to this runtime actor.");
    const targets = [root, ...root.getChildMeshes().filter((mesh): mesh is Mesh => mesh instanceof Mesh)]
      .filter((mesh) => componentIdForPlayMesh(mesh, request.slotId, binding) === request.componentId);
    if (!targets.length || targets.some(mesh => mesh.metadata?.text2d || mesh.metadata?.text2dGlyph || mesh.metadata?.tilemapChunk))
      throw new Error("This visual owner requires a rebuilt material assignment; live material editing is unavailable.");
    const targetKey = `${request.slotId}|${request.componentId}`;
    if ([...this.stages.values()].some(stage => stage.targetKey === targetKey))
      throw new Error("This component already has a material edit pending.");
    const values = request.parameterName !== undefined ? new Map(binding.materialParameters.get(targetKey)?.values) : new Map<string, MaterialParameterValue>();
    if (request.parameterName !== undefined) {
      if (!request.materialGuid || !request.parameter || binding.validateMaterialParameter?.(request.materialGuid, request.parameterName, request.parameter) !== true)
        throw new Error("The material parameter or typed value is unsupported.");
      if (this.assigned(request) !== request.materialGuid) throw new Error("The material assignment changed before preparation.");
      values.set(request.parameterName, request.parameter);
    }
    const stage: Stage = { request, targetKey, key: `runtime-edit:${request.editToken}`, root, component, targets,
      before: this.signature(request), unlit: wantsOverlayUnlitMaterial(binding, request.slotId), values, ready: false };
    this.stages.set(request.editToken, stage);
    try {
      if (request.materialGuid) {
        const material = binding.resolveMaterial?.(request.materialGuid, { scene: component.getScene(), unlit: stage.unlit, instanceKey: stage.key, parameters: values });
        if (!material) throw new Error("The requested material is unavailable for this visual.");
        stage.material = material as NodeMaterial;
        const diagnostics = await ownedMaterialPreparation(material);
        if (diagnostics?.length) throw new Error(diagnostics.map(entry => entry.message).join("; "));
        for (const mesh of targets) {
          this.validate(stage);
          if (mesh.getTotalVertices()) await prewarmMaterial(stage.material, mesh);
        }
      }
      this.validate(stage);
      stage.ready = true;
    } catch (error) { this.release(request.editToken); throw error; }
  }

  commit(command: RuntimeMaterialCommitCommand): { success: boolean; reason?: string } {
    const stage = command.preparedEditToken ? this.stages.get(command.preparedEditToken) : undefined;
    if (!stage?.ready) return { success: false, reason: "The prepared material edit is unavailable." };
    const { request, targetKey, root } = stage;
    if (command.slotId !== request.slotId || command.componentId !== request.componentId || command.materialAssetGuid !== request.materialGuid ||
      (command.type === "setMaterialParameter" ? command.parameterName !== request.parameterName || JSON.stringify(command.parameter) !== JSON.stringify(request.parameter) : request.parameterName !== undefined))
      return { success: false, reason: "The material commit does not match its prepared request." };
    const binding = this.binding;
    let adoption: ReturnType<MaterialLibrary["adoptPreparedInstance"]> | undefined;
    const previousGuid = binding.componentMaterialGuids.get(targetKey);
    const hadGuid = binding.componentMaterialGuids.has(targetKey);
    const previousParameters = binding.materialParameters.get(targetKey);
    const previousMaterials = new Map<Mesh, Material | null>(stage.targets.map(mesh => [mesh, mesh.material]));
    try {
      this.validate(stage);
      if (request.materialGuid && stage.material) adoption = this.library.adoptPreparedInstance(stage.component.getScene(), request.materialGuid,
        stage.key, targetKey, stage.material, { unlit: stage.unlit });
      binding.componentMaterialGuids.set(targetKey, request.materialGuid);
      if (request.materialGuid) binding.materialParameters.set(targetKey, { materialAssetGuid: request.materialGuid, values: stage.values });
      else binding.materialParameters.delete(targetKey);
      applyMaterialToActorMeshes(binding, request.slotId, root);
      for (const mesh of stage.targets) if (stage.material && mesh.material !== stage.material)
        throw new Error("The visual owner did not accept its prepared material.");
      adoption?.commit();
      if (previousParameters && previousParameters.materialAssetGuid !== request.materialGuid)
        binding.releaseMaterialInstance?.(targetKey, previousParameters.materialAssetGuid);
      return { success: true };
    } catch (error) {
      if (hadGuid) binding.componentMaterialGuids.set(targetKey, previousGuid!); else binding.componentMaterialGuids.delete(targetKey);
      if (previousParameters) binding.materialParameters.set(targetKey, previousParameters); else binding.materialParameters.delete(targetKey);
      for (const [mesh, material] of previousMaterials) if (!mesh.isDisposed()) { mesh.material = material; applyMaterialBounds(mesh); }
      adoption?.rollback();
      return { success: false, reason: error instanceof Error ? error.message : "Material commit failed." };
    }
  }

  release(editToken: string): void {
    const stage = this.stages.get(editToken);
    if (!stage) return;
    this.stages.delete(editToken);
    // Adopted resources now belong to the normal component key, never the temporary token.
    this.library.releaseInstance(stage.key, stage.request.materialGuid ?? undefined);
  }
  cancelAll(): void { for (const token of this.stages.keys()) this.release(token); }
  dispose(): void { this.disposed = true; this.cancelAll(); }
  private assigned(request: RuntimeMaterialPreparationRequest): string | null | undefined {
    const key = `${request.slotId}|${request.componentId}`;
    return this.binding.componentMaterialGuids.has(key) ? this.binding.componentMaterialGuids.get(key) : this.binding.materialAssetGuids.get(request.slotId);
  }
  private signature(request: RuntimeMaterialPreparationRequest): string {
    return JSON.stringify([this.assigned(request), [...(this.binding.materialParameters.get(`${request.slotId}|${request.componentId}`)?.values ?? [])]]);
  }
  private validate(stage: Stage): void {
    const { request } = stage;
    if (this.disposed || this.stages.get(request.editToken) !== stage || stage.root.isDisposed() || stage.component.isDisposed() ||
      this.binding.meshes.get(request.slotId) !== stage.root || meshForPlayComponent(this.binding, request.slotId, request.componentId) !== stage.component ||
      this.binding.meshSorting.get(request.slotId)?.actorGuid !== request.actorGuid || stage.before !== this.signature(request))
      throw new Error("The material target changed or preparation was cancelled.");
  }
}
