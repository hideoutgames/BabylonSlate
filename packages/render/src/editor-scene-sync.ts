import { Mesh, type Camera, type Material, type Scene } from "@babylonjs/core";
import type {
  SerializedActor,
  SerializedComponent,
  SerializedScene,
} from "@babylonslate/core";
import type { RenderScheduler } from "./render-scheduler";
import {
  meshAssetFingerprint,
  meshAssetFingerprintWithoutModels,
  modelSlotFingerprint,
  type MeshAssetContext,
} from "./mesh-assets";
import { applyModelMaterialSlots } from "./model-preview";
import { beginSlotModelAnimLoad, isEditorModelPlaceholder, type ModelAnimLoadBinding } from "./glb-anim";
import { isGltfModelBytes } from "./model-mesh";
import {
  actorIdFromMeshName,
  actorVisualFingerprint,
  applyActorTransform,
  applyComponentChildTransforms,
  createActorMesh,
  editorComponentMeshName,
  editorModelLoadTarget,
  freezeStaticActorWorldMatrix,
  isEditorActorOrigin,
  visualMeshesOfActorRoot,
} from "./scene-loader";
import { syncAuthoredIllumination } from "./scene-illumination";
import { applyEditorBillboardFromActor } from "./editor-billboard";
import { applySortingToMesh, resolveSortingLayer } from "./sorting";
import {
  freezeEditorActiveMeshes,
  isStructuralEditorChange,
  unfreezeEditorActiveMeshes,
} from "./scene-perf";
import { isColliderVisualMesh } from "./collider-visual";
import { visualMeshes } from "./visual-meshes";

const DEFAULT_SORTING_LAYERS = ["Background", "Default", "Foreground", "UI"];

export type EditorSceneSyncOptions = {
  resolveMaterial?: (guid: string) => Material | null;
  /** Fired after meshes/materials are bound so overlays can re-apply. */
  onAfterApply?: () => void;
};

function spriteSortingOf(
  actor: SerializedActor,
): { layer: string; orderInLayer: number } | null {
  const component = actor.components.find(
    (entry) =>
      entry.classId === "SpriteComponent" ||
      entry.classId === "TilemapComponent",
  );
  if (!component) return null;
  const layer = component.properties.sortingLayer;
  const order = component.properties.orderInLayer;
  return {
    layer: typeof layer === "string" ? layer : "Default",
    orderInLayer: typeof order === "number" ? order : 0,
  };
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
  private readonly resolveMaterial?: (guid: string) => Material | null;
  private readonly onAfterApply?: () => void;
  private readonly constructionMaterials = new WeakMap<Mesh, Material | null>();
  private sortingLayers: string[] = [...DEFAULT_SORTING_LAYERS];
  private assets: MeshAssetContext | undefined;
  private lastAssetFingerprint: string | null = null;
  private lastModelSlotKey = "";
  private lastScene: SerializedScene | null = null;
  private stealActiveCamera = false;
  private restoreCamera: Camera | null = null;
  private shadowQuality = "1024";
  private modelLoadSlot = 0;
  private readonly modelLoadBinding: ModelAnimLoadBinding = {
    slotAnimEpoch: new Map<number, number>(),
    slotAnimationGroups: new Map(),
    slotAnimLoads: new Map<number, Promise<void>>(),
  };

  constructor(
    scene: Scene,
    scheduler?: Pick<RenderScheduler, "invalidate">,
    options?: EditorSceneSyncOptions,
  ) {
    this.scene = scene;
    this.scheduler = scheduler;
    this.resolveMaterial = options?.resolveMaterial;
    this.onAfterApply = options?.onAfterApply;
  }

  /** Ordered sorting layers from project settings, back to front. */
  setSortingLayers(layers: readonly string[]): void {
    this.sortingLayers =
      layers.length > 0 ? [...layers] : [...DEFAULT_SORTING_LAYERS];
  }

  /**
   * Swap sprite/tilemap/model bytes. Returns true when editor meshes were
   * disposed and rebuilt. Equivalent payloads (new Maps, same guids/sizes) are
   * a no-op so a gizmo transform commit does not drop selection.
   */
  setMeshAssets(assets: MeshAssetContext | undefined): boolean {
    const fingerprint = meshAssetFingerprint(assets);
    const slotKey = modelSlotFingerprint(assets?.modelPayloads);
    const previous = this.assets;
    const onlyModelsChanged =
      meshAssetFingerprintWithoutModels(previous) ===
        meshAssetFingerprintWithoutModels(assets) &&
      fingerprint !== this.lastAssetFingerprint;
    this.assets = assets;
    if (fingerprint === this.lastAssetFingerprint) {
      if (slotKey !== this.lastModelSlotKey) {
        this.lastModelSlotKey = slotKey;
        if (this.lastScene) this.apply(this.lastScene);
      }
      return false;
    }
    this.lastAssetFingerprint = fingerprint;
    this.lastModelSlotKey = slotKey;
    if (onlyModelsChanged && this.lastScene && this.meshes.size > 0) {
      this.apply(this.lastScene);
      return false;
    }
    for (const mesh of this.meshes.values()) mesh.dispose();
    this.meshes.clear();
    this.meshKinds.clear();
    if (this.lastScene) this.apply(this.lastScene);
    return true;
  }

  setGameCameraPreview(enabled: boolean, restoreCamera?: Camera | null): void {
    this.stealActiveCamera = enabled;
    if (restoreCamera !== undefined) this.restoreCamera = restoreCamera;
    if (this.lastScene) this.apply(this.lastScene);
  }

  setShadowQuality(level: string): void {
    this.shadowQuality = level;
    if (this.lastScene) this.apply(this.lastScene);
  }

  apply(sceneData: SerializedScene): void {
    if (isStructuralEditorChange(this.lastScene, sceneData)) {
      unfreezeEditorActiveMeshes(this.scene);
    }
    this.liveIds.clear();

    for (const actor of sceneData.actors) {
      this.liveIds.add(actor.id);
      const kind = actorVisualFingerprint(actor, this.assets, sceneData.actors);
      let mesh = this.meshes.get(actor.id);
      if (mesh && this.meshKinds.get(actor.id) !== kind) {
        mesh.dispose();
        mesh = undefined;
      }
      if (!mesh) {
        mesh = createActorMesh(this.scene, actor, this.assets, sceneData.actors);
        this.meshes.set(actor.id, mesh);
        this.meshKinds.set(actor.id, kind);
      }
      this.beginEditorModelLoad(actor, mesh);
      applyActorTransform(mesh, actor);
      applyComponentChildTransforms(mesh, actor);
      applyEditorBillboardFromActor(mesh, actor);
      for (const child of visualMeshesOfActorRoot(mesh)) {
        applyEditorBillboardFromActor(child, actor);
      }

      const sorting = spriteSortingOf(actor);
      if (sorting) {
        const layer = resolveSortingLayer(
          this.sortingLayers,
          sorting.layer,
          sorting.orderInLayer,
        );
        for (const target of visualMeshesOfActorRoot(mesh)) {
          applySortingToMesh(target, layer);
        }
      }
      this.restoreMeshComponentConstruction(actor, mesh);
      this.applyModelSlots(actor, mesh);
      this.bindActorMeshMaterials(actor, mesh);
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
    syncAuthoredIllumination(this.scene, sceneData, {
      stealActiveCamera: this.stealActiveCamera,
      restoreCamera: this.restoreCamera,
      applyClearColor:
        sceneData.viewportMode !== "2d" || sceneData.overlayEditor === true,
      shadowQuality: this.shadowQuality,
      assets: this.assets,
    });
    this.onAfterApply?.();
    for (const actor of sceneData.actors) {
      const mesh = this.meshes.get(actor.id);
      if (mesh) freezeStaticActorWorldMatrix(mesh);
    }
    freezeEditorActiveMeshes(this.scene);
  }

  serializedScene(): SerializedScene | null {
    return this.lastScene;
  }

  meshForActor(actorId: string): Mesh | null {
    return this.meshes.get(actorId) ?? null;
  }

  visualMeshesForActor(actorId: string): Mesh[] {
    const mesh = this.meshes.get(actorId);
    if (!mesh) return [];
    const roots = visualMeshesOfActorRoot(mesh);
    const drawn: Mesh[] = [];
    for (const root of roots) {
      if (isColliderVisualMesh(root)) continue;
      const parts = visualMeshes(root).filter(
        (part): part is Mesh => part instanceof Mesh,
      );
      if (parts.length > 0) {
        drawn.push(...parts);
        continue;
      }
      if (!isEditorModelPlaceholder(root)) {
        drawn.push(root);
      }
    }
    return drawn.length > 0 ? drawn : roots;
  }

  actorForMesh(meshName: string): string | null {
    const actorId = actorIdFromMeshName(meshName);
    return actorId && this.meshes.has(actorId) ? actorId : null;
  }

  actorCount(): number {
    return this.meshes.size;
  }

  whenEditorModelsReady(): Promise<void> {
    const loads = [...(this.modelLoadBinding.slotAnimLoads?.values() ?? [])];
    if (loads.length === 0) return Promise.resolve();
    return Promise.all(loads).then(() => undefined);
  }

  pendingModelLoadCount(): number {
    return this.modelLoadBinding.slotAnimLoads?.size ?? 0;
  }

  /**
   * Bind `MeshComponent.materialGuid` onto editor visuals every apply so a
   * Details edit or a late Material-document load does not need a mesh rebuild.
   * Pivot markers and non-mesh visuals stay on their construction materials.
   */
  private meshComponentAssetGuid(actor: SerializedActor): string | null {
    const component = actor.components.find(
      (entry) => entry.classId === "MeshComponent",
    );
    const guid = component?.properties.assetGuid;
    return typeof guid === "string" && guid.length > 0 ? guid : null;
  }

  private applyModelSlots(actor: SerializedActor, root: Mesh): void {
    const guid = this.meshComponentAssetGuid(actor);
    const payload = guid ? this.assets?.modelPayloads?.get(guid) : undefined;
    if (!payload) return;
    applyModelMaterialSlots(
      editorModelLoadTarget(root, actor),
      payload.materialSlots,
      (materialGuid) => this.resolveMaterial?.(materialGuid) ?? null,
    );
  }

  private beginEditorModelLoad(actor: SerializedActor, root: Mesh): void {
    const guid = this.meshComponentAssetGuid(actor);
    const bytes = guid ? this.assets?.modelBytes?.get(guid) : undefined;
    if (!guid || !bytes || !isGltfModelBytes(bytes)) return;
    const slotId = ++this.modelLoadSlot;
    this.modelLoadBinding.modelBytes = this.assets?.modelBytes;
    this.modelLoadBinding.modelPayloads = this.assets?.modelPayloads;
    this.modelLoadBinding.modelClipAnimationGuids =
      this.assets?.modelClipAnimationGuids;
    this.modelLoadBinding.retargetAnimationLoads =
      this.assets?.retargetAnimationLoads;
    this.modelLoadBinding.textureBytes = this.assets?.textureBytes;
    this.modelLoadBinding.materialTextureGuids =
      this.assets?.materialTextureGuids;
    this.modelLoadBinding.compiledMaterialGuids =
      this.assets?.compiledMaterialGuids;
    const placeholder = editorModelLoadTarget(root, actor);
    void beginSlotModelAnimLoad(
      this.scene,
      this.modelLoadBinding,
      slotId,
      guid,
      bytes,
      placeholder,
      () => {
        if (root.isDisposed() || placeholder.isDisposed()) return;
        const current =
          this.lastScene?.actors.find((entry) => entry.id === actor.id) ?? actor;
        applyActorTransform(root, current);
        this.restoreMeshComponentConstruction(current, root);
        this.applyModelSlots(current, root);
        this.bindActorMeshMaterials(current, root);
        freezeStaticActorWorldMatrix(root);
        freezeEditorActiveMeshes(this.scene);
        this.scheduler?.invalidate("asset");
        this.onAfterApply?.();
      },
    );
  }

  private restoreMeshComponentConstruction(
    actor: SerializedActor,
    root: Mesh,
  ): void {
    for (const component of actor.components) {
      if (component.classId !== "MeshComponent") continue;
      if (meshKindOf(component) === "pivot") continue;
      if (authoredMaterialGuid(component.properties.materialGuid)) continue;
      const visual = visualForMeshComponent(root, actor.id, component.id);
      if (!visual) continue;
      for (const target of meshAndDescendantMeshes(visual)) {
        if (!this.constructionMaterials.has(target)) continue;
        target.material = this.constructionMaterials.get(target) ?? null;
      }
    }
  }

  private bindActorMeshMaterials(actor: SerializedActor, root: Mesh): void {
    for (const component of actor.components) {
      if (component.classId !== "MeshComponent") continue;
      if (meshKindOf(component) === "pivot") continue;
      const visual = visualForMeshComponent(root, actor.id, component.id);
      if (!visual) continue;
      this.bindMaterialOverride(
        visual,
        authoredMaterialGuid(component.properties.materialGuid),
      );
    }
  }

  private bindMaterialOverride(visual: Mesh, guid: string | null): void {
    if (!guid) return;
    const targets = meshAndDescendantMeshes(visual);
    for (const target of targets) {
      if (!this.constructionMaterials.has(target)) {
        this.constructionMaterials.set(target, target.material);
      }
    }
    const material = this.resolveMaterial?.(guid) ?? null;
    if (!material) return;
    for (const target of targets) {
      target.material = material;
    }
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

function meshKindOf(component: SerializedComponent): string | null {
  return typeof component.properties.meshKind === "string"
    ? component.properties.meshKind
    : null;
}

function authoredMaterialGuid(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const guid = value.trim();
  return guid.length > 0 ? guid : null;
}

function visualForMeshComponent(
  root: Mesh,
  actorId: string,
  componentId: string,
): Mesh | null {
  if (!isEditorActorOrigin(root)) return root;
  const name = editorComponentMeshName(actorId, componentId);
  return visualMeshesOfActorRoot(root).find((mesh) => mesh.name === name) ?? null;
}

function meshAndDescendantMeshes(root: Mesh): Mesh[] {
  const children = root
    .getChildMeshes()
    .filter((child): child is Mesh => child instanceof Mesh);
  return [root, ...children];
}
