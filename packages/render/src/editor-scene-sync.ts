import { Mesh, type AbstractMesh, type Camera, type Material, type Node, type Scene } from "@babylonjs/core";
import { applyMaterialBounds } from "./material-bounds";
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
  applyActorComponentSorting,
  applyComponentChildTransforms,
  createActorMesh,
  editorComponentMeshName,
  editorModelLoadTarget,
  freezeStaticActorWorldMatrix,
  isEditorActorOrigin,
  syncMeshCollisionDashes,
  visualMeshesOfActorRoot,
} from "./scene-loader";
import { syncAuthoredIlluminationSteps } from "./scene-illumination";
import { runSceneWork, type SceneWorkOptions } from "./scene-work";
import { applyEditorBillboardFromActor } from "./editor-billboard";
import {
  freezeEditorActiveMeshes,
  isStructuralEditorChange,
  unfreezeEditorActiveMeshes,
} from "./scene-perf";
import { isColliderVisualMesh, isColliderVisualTree } from "./collider-visual";
import { visualMeshes } from "./visual-meshes";
import { isTilemapChunkMesh } from "./tilemap-mesh";

const DEFAULT_SORTING_LAYERS = ["Background", "Default", "Foreground", "UI"];

export type EditorSceneSyncOptions = {
  /** FrameGraph owns its camera-specific active queue; world matrices still freeze. */
  freezeActiveMeshes?: boolean;
  resolveMaterial?: (
    guid: string,
    options?: { scene?: Scene; unlit?: boolean },
  ) => Material | null;
  /** Fired after meshes/materials are bound so overlays can re-apply. */
  onAfterApply?: () => void;
};

/**
 * Applies scene document edits to the Babylon editor scene incrementally, so a
 * gizmo drag touches one mesh instead of rebuilding the scene, and marks the
 * viewport dirty for the render-on-demand loop (engineplan §2.4).
 */
export class EditorSceneSync {
  private readonly meshes = new Map<string, Mesh>();
  private readonly meshKinds = new Map<string, string | null>();
  private applyGeneration = 0;
  private pendingApply: AbortController | null = null;
  private realization: Promise<void> | null = null;
  private applyingScene: SerializedScene | null = null;
  private materialRefreshGeneration: number | null = null;
  private materialsRefreshable = false;
  private disposed = false;

  private readonly scene: Scene;
  private readonly scheduler?: Pick<RenderScheduler, "invalidate">;
  private readonly resolveMaterial?: (
    guid: string,
    options?: { scene?: Scene; unlit?: boolean },
  ) => Material | null;
  private readonly onAfterApply?: () => void;
  private readonly freezeActiveMeshes: boolean;
  private readonly constructionMaterials = new WeakMap<Mesh, Material | null>();
  private sortingLayers: string[] = [...DEFAULT_SORTING_LAYERS];
  private assets: MeshAssetContext | undefined;
  private lastAssetFingerprint: string | null = null;
  private lastModelSlotKey = "";
  private assetsNeedRebuild = false;
  private lastScene: SerializedScene | null = null;
  private stealActiveCamera = false;
  private restoreCamera: Camera | null = null;
  private drawMeshCollision = false;
  private selectedActorIds = new Set<string>();
  private selectedComponentIds = new Set<string>();
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
    this.freezeActiveMeshes = options?.freezeActiveMeshes !== false;
  }

  /** Ordered sorting layers from project settings, back to front. */
  setSortingLayers(layers: readonly string[]): void {
    const next = layers.length > 0 ? [...layers] : [...DEFAULT_SORTING_LAYERS];
    if (JSON.stringify(next) === JSON.stringify(this.sortingLayers)) return;
    this.sortingLayers = next;
    if (this.lastScene) this.apply(this.lastScene);
  }

  /**
   * Swap sprite/tilemap/model bytes. Returns true when editor meshes were
   * disposed and rebuilt. Equivalent payloads (new Maps, same guids/sizes) are
   * a no-op so a gizmo transform commit does not drop selection.
   */
  setMeshAssets(assets: MeshAssetContext | undefined): boolean {
    const change = this.installAssets(assets);
    if (change.rebuild) this.meshKinds.clear();
    if (change.reapply && this.lastScene) this.apply(this.lastScene);
    return change.rebuild;
  }

  private installAssets(assets: MeshAssetContext | undefined): { rebuild: boolean; reapply: boolean } {
    const fingerprint = meshAssetFingerprint(assets);
    const slotKey = modelSlotFingerprint(assets?.modelPayloads);
    const onlyModelsChanged = meshAssetFingerprintWithoutModels(this.assets) === meshAssetFingerprintWithoutModels(assets);
    const layers = assets?.sortingLayers
      ? [...(assets.sortingLayers.length > 0 ? assets.sortingLayers : DEFAULT_SORTING_LAYERS)]
      : this.sortingLayers;
    const reapply = fingerprint !== this.lastAssetFingerprint || slotKey !== this.lastModelSlotKey || JSON.stringify(layers) !== JSON.stringify(this.sortingLayers);
    const rebuild = fingerprint !== this.lastAssetFingerprint && !onlyModelsChanged;
    this.assetsNeedRebuild ||= rebuild;
    this.assets = assets;
    this.sortingLayers = layers;
    this.lastAssetFingerprint = fingerprint;
    this.lastModelSlotKey = slotKey;
    return { rebuild, reapply };
  }

  setGameCameraPreview(enabled: boolean, restoreCamera?: Camera | null): void {
    this.stealActiveCamera = enabled;
    if (restoreCamera !== undefined) this.restoreCamera = restoreCamera;
    if (this.lastScene) this.apply(this.lastScene);
  }

  /**
   * Session collision dashes (default off). 2D MeshComponent dashes stay off.
   * Toggling syncs existing actors without a full mesh rebuild.
   */
  setDrawMeshCollision(enabled: boolean): void {
    if (this.drawMeshCollision === enabled) return;
    this.drawMeshCollision = enabled;
    if (!this.applyingScene) this.syncExistingMeshCollisionDashes();
  }

  /** Collider helpers stay visible for the selected object and its children. */
  setCollisionSelection(options: {
    selectedActorIds: readonly string[];
    selectedComponentIds?: readonly string[];
  }): void {
    this.selectedActorIds = new Set(options.selectedActorIds);
    this.selectedComponentIds = new Set(options.selectedComponentIds ?? []);
    if (!this.applyingScene && this.lastScene && this.syncCollisionVisibility(this.lastScene)) {
      this.freezeActiveQueue();
      this.scheduler?.invalidate("selection");
    }
  }

  apply(sceneData: SerializedScene): void {
    this.pendingApply?.abort(new Error("Scene realization was superseded."));
    this.pendingApply = null;
    this.realization = null;
    const generation = ++this.applyGeneration;
    this.materialRefreshGeneration = null;
    this.materialsRefreshable = false;
    this.resetModelReadiness();
    this.applyingScene = sceneData;
    try {
      for (const _progress of this.applySteps(sceneData)) {
        // Gizmos and other immediate consumers retain synchronous behavior.
        void _progress;
      }
      while (this.materialRefreshGeneration === generation) {
        this.materialRefreshGeneration = null;
        for (const _progress of this.materialRefreshSteps(sceneData)) void _progress;
      }
      this.completeApply(sceneData, generation);
    } finally {
      if (generation === this.applyGeneration) this.applyingScene = null;
    }
  }

  async applyAsync(sceneData: SerializedScene, options: SceneWorkOptions & { assets?: MeshAssetContext }): Promise<void> {
    this.pendingApply?.abort(new Error("Scene realization was superseded."));
    const controller = new AbortController();
    const generation = ++this.applyGeneration;
    this.materialRefreshGeneration = null;
    this.materialsRefreshable = false;
    this.resetModelReadiness();
    this.pendingApply = controller;
    const abort = () => controller.abort(options.signal.reason);
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();
    this.applyingScene = sceneData;
    try {
      // Install the readiness latch before setup, progress callbacks or actor
      // work can fail. Even a pre-aborted replacement owns a failed latch.
      this.realization = Promise.resolve().then(async () => {
        controller.signal.throwIfAborted();
        const rebuild = options.assets ? this.installAssets(options.assets).rebuild : false;
        const work = { ...options, signal: controller.signal };
        await runSceneWork(this.applySteps(sceneData, rebuild, true), work);
        while (this.materialRefreshGeneration === generation) {
          this.materialRefreshGeneration = null;
          await runSceneWork(this.materialRefreshSteps(sceneData), work);
        }
        controller.signal.throwIfAborted();
        this.completeApply(sceneData, generation);
        controller.signal.throwIfAborted();
      });
      await this.realization;
    } finally {
      options.signal.removeEventListener("abort", abort);
      if (generation === this.applyGeneration) {
        this.pendingApply = null;
        this.applyingScene = null;
        this.materialRefreshGeneration = null;
      }
    }
  }

  private *applySteps(sceneData: SerializedScene, rebuild = false, cooperative = false): Generator<number, void, unknown> {
    rebuild ||= this.assetsNeedRebuild;
    // Blocking loads already require final readiness; skip the immediate path's
    // full-document structural pre-scan and unfreeze before phased planning.
    if (cooperative || rebuild || isStructuralEditorChange(this.lastScene, sceneData)) unfreezeEditorActiveMeshes(this.scene);
    const assets = this.meshAssetsForScene(sceneData);
    const liveIds = new Set<string>();
    const nextKinds = new Map<string, string | null>();
    const retired = new Set<string>();
    const oldMeshes = [...this.meshes];
    const actorCount = Math.max(1, sceneData.actors.length);
    let index = 0;
    for (const actor of sceneData.actors) {
      liveIds.add(actor.id);
      const kind = actorVisualFingerprint(actor, assets, sceneData.actors);
      nextKinds.set(actor.id, kind);
      if (rebuild || this.meshKinds.get(actor.id) !== kind) retired.add(actor.id);
      yield 0.1 * ++index / actorCount;
    }
    index = 0;
    for (const [actorId] of oldMeshes) {
      if (!liveIds.has(actorId)) retired.add(actorId);
      yield 0.1 + 0.05 * ++index / Math.max(1, oldMeshes.length);
    }
    // Babylon recursively disposes descendants. Detach surviving actor roots
    // before retiring a removed/replaced parent; component children stay owned.
    index = 0;
    for (const [, mesh] of oldMeshes) {
      const parentId = mesh.parent ? actorIdFromMeshName(mesh.parent.name) : null;
      if (parentId && retired.has(parentId)) mesh.parent = null;
      yield 0.15 + 0.05 * ++index / Math.max(1, oldMeshes.length);
    }
    index = 0;
    for (const actor of sceneData.actors) {
      let mesh = this.meshes.get(actor.id);
      if (mesh && (retired.has(actor.id) || mesh.isDisposed())) {
        mesh.dispose();
        this.meshes.delete(actor.id);
        this.meshKinds.delete(actor.id);
        mesh = undefined;
      }
      if (!mesh) {
        mesh = createActorMesh(this.scene, actor, assets, sceneData.actors);
        this.meshes.set(actor.id, mesh);
        this.meshKinds.set(actor.id, nextKinds.get(actor.id) ?? null);
      }
      this.beginEditorModelLoad(actor, mesh);
      applyActorTransform(mesh, actor);
      applyComponentChildTransforms(mesh, actor);
      applyEditorBillboardFromActor(mesh, actor);
      for (const child of visualMeshesOfActorRoot(mesh)) applyEditorBillboardFromActor(child, actor);
      applyActorComponentSorting(mesh, actor, this.sortingLayers);
      this.restoreMeshComponentConstruction(actor, mesh);
      this.applyModelSlots(actor, mesh);
      this.bindActorMeshMaterials(actor, mesh);
      yield 0.2 + 0.3 * ++index / actorCount;
    }
    index = 0;
    for (const [actorId, mesh] of oldMeshes) {
      if (!liveIds.has(actorId)) {
        mesh.dispose();
        this.meshes.delete(actorId);
        this.meshKinds.delete(actorId);
      }
      yield 0.5 + 0.1 * ++index / Math.max(1, oldMeshes.length);
    }
    index = 0;
    for (const actor of sceneData.actors) {
      const mesh = this.meshes.get(actor.id);
      if (mesh) {
        const parent = actor.parentId ? this.meshes.get(actor.parentId) ?? null : null;
        if (mesh.parent !== parent) mesh.parent = parent;
      }
      yield 0.6 + 0.1 * ++index / actorCount;
    }
    for (const progress of syncAuthoredIlluminationSteps(this.scene, sceneData, {
      stealActiveCamera: this.stealActiveCamera,
      restoreCamera: this.restoreCamera,
      applyClearColor: sceneData.viewportMode !== "2d" || sceneData.overlayEditor === true,
      assets: this.assets,
    })) yield 0.7 + 0.2 * progress;
    index = 0;
    for (const changed of this.collisionVisibilitySteps(sceneData)) {
      void changed;
      yield 0.9 + 0.04 * ++index / actorCount;
    }
    index = 0;
    for (const actor of sceneData.actors) {
      const mesh = this.meshes.get(actor.id);
      if (mesh) freezeStaticActorWorldMatrix(mesh);
      yield 0.94 + 0.05 * ++index / actorCount;
    }
  }

  private completeApply(sceneData: SerializedScene, generation: number): void {
    this.lastScene = sceneData;
    this.assetsNeedRebuild = false;
    this.onAfterApply?.();
    if (generation !== this.applyGeneration) return;
    this.freezeActiveQueue();
    this.applyingScene = null;
    this.materialsRefreshable = true;
    this.scheduler?.invalidate("asset");
  }

  /** A material publication belongs to the current load, not a new document edit. */
  refreshMaterials(): void {
    if (this.disposed || this.scene.isDisposed || this.pendingApply?.signal.aborted) return;
    if (this.applyingScene) {
      this.materialRefreshGeneration = this.applyGeneration;
      return;
    }
    // An aborted/failed apply retains partial roots for the next reconciliation.
    // Late material publication must not reactivate that partial generation.
    if (!this.materialsRefreshable || !this.lastScene) return;
    unfreezeEditorActiveMeshes(this.scene);
    for (const _progress of this.materialRefreshSteps(this.lastScene)) void _progress;
    this.onAfterApply?.();
    this.freezeActiveQueue();
    this.scheduler?.invalidate("asset");
  }

  private *materialRefreshSteps(sceneData: SerializedScene): Generator<number, void, unknown> {
    for (const actor of sceneData.actors) {
      const root = this.meshes.get(actor.id);
      if (root && !root.isDisposed()) {
        this.restoreMeshComponentConstruction(actor, root);
        this.applyModelSlots(actor, root);
        this.bindActorMeshMaterials(actor, root);
      }
      yield 0.99;
    }
  }

  private freezeActiveQueue(): void {
    if (this.freezeActiveMeshes) freezeEditorActiveMeshes(this.scene);
  }

  serializedScene(): SerializedScene | null {
    return this.lastScene;
  }

  meshForActor(actorId: string): Mesh | null {
    return this.meshes.get(actorId) ?? null;
  }

  /** Exact authored component visual; asset consumers never infer identity from mesh order. */
  meshForComponent(actorId: string, componentId: string): Mesh | null {
    const actor = this.lastScene?.actors.find((entry) => entry.id === actorId);
    const component = actor?.components.find((entry) => entry.id === componentId);
    const root = this.meshes.get(actorId);
    return root && component?.classId === "MeshComponent"
      ? visualForMeshComponent(root, actorId, componentId) : null;
  }

  visualMeshesForActor(actorId: string): AbstractMesh[] {
    const mesh = this.meshes.get(actorId);
    if (!mesh) return [];
    const roots = visualMeshesOfActorRoot(mesh);
    const drawn: AbstractMesh[] = [];
    for (const root of roots) {
      if (isColliderVisualMesh(root)) continue;
      const parts = visualMeshes(root).filter((part) => {
        // A child actor has its own authored identity even when its transform
        // parent is this actor. Imported model parts retain their actor root.
        for (let node: Node | null = part; node && node !== mesh; node = node.parent) {
          if (!(node instanceof Mesh)) continue;
          const owner = this.actorForMesh(node.name);
          if (owner && owner !== actorId && this.meshes.get(owner) === node) return false;
        }
        return true;
      });
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

  async whenEditorModelsReady(): Promise<void> {
    await this.realization;
    const loads = [...(this.modelLoadBinding.slotAnimLoads?.values() ?? [])];
    if (loads.length === 0) return Promise.resolve();
    return Promise.all(loads).then(() => undefined);
  }

  private resetModelReadiness(): void {
    // Prior waiters retain their promises, but a replacement waits only for its
    // own submissions. Generation ownership prevents obsolete adoption.
    this.modelLoadBinding.slotAnimLoads?.clear();
    this.modelLoadBinding.slotAnimEpoch?.clear();
  }

  pendingModelLoadCount(): number {
    return this.modelLoadBinding.slotAnimLoads?.size ?? 0;
  }

  /**
   * Bind `MeshComponent.materialGuid` onto editor visuals every apply so a
   * Details edit or a late Material-document load does not need a mesh rebuild.
   * Pivot markers and non-mesh visuals stay on their construction materials.
   */
  private meshAssetsForScene(sceneData: SerializedScene): MeshAssetContext {
    return {
      ...(this.assets ?? {}),
      drawMeshCollision:
        this.drawMeshCollision && sceneData.settings.physicsWorld !== "2d",
      resolveMaterial: (guid, options) =>
        this.resolveMaterial?.(guid, options) ??
        this.assets?.resolveMaterial?.(guid, options) ??
        null,
    };
  }

  private syncExistingMeshCollisionDashes(): void {
    const sceneData = this.lastScene;
    if (!sceneData) return;
    const assets = this.meshAssetsForScene(sceneData);
    for (const actor of sceneData.actors) {
      const root = this.meshes.get(actor.id);
      if (!root) continue;
      for (const component of actor.components) {
        if (component.classId !== "MeshComponent") continue;
        const visual =
          visualForMeshComponent(root, actor.id, component.id) ?? root;
        syncMeshCollisionDashes(visual, component, assets);
      }
    }
    this.syncCollisionVisibility(sceneData);
    // New and newly revealed dashes must enter the frozen active mesh list.
    this.freezeActiveQueue();
    this.scheduler?.invalidate("asset");
  }

  private syncCollisionVisibility(sceneData: SerializedScene): boolean {
    let changed = false;
    for (const actorChanged of this.collisionVisibilitySteps(sceneData)) changed ||= actorChanged;
    return changed;
  }

  private *collisionVisibilitySteps(sceneData: SerializedScene): Generator<boolean, void, unknown> {
    const actors = new Map(sceneData.actors.map((actor) => [actor.id, actor]));
    let changed = false;
    for (const actor of sceneData.actors) {
      const root = this.meshes.get(actor.id);
      if (!root) { yield false; continue; }
      const actorSelected = hasSelectedAncestor(
        actor.id,
        this.selectedActorIds,
        (id) => actors.get(id)?.parentId,
      );
      const components = new Map(
        actor.components.map((component) => [component.id, component]),
      );
      for (const component of actor.components) {
        if (component.classId === "MeshComponent") {
          const visual = visualForMeshComponent(root, actor.id, component.id);
          for (const collision of visual?.getChildMeshes(true) ?? []) {
            if (!(collision.metadata as { meshCollisionDash?: boolean } | null)?.meshCollisionDash) {
              continue;
            }
            if (collision.isEnabled(false) === actor.visible) continue;
            collision.setEnabled(actor.visible);
            changed = true;
          }
        }
        if (component.classId !== "ColliderComponent") continue;
        const visual = visualForMeshComponent(root, actor.id, component.id);
        if (!visual) continue;
        const enabled =
          actor.visible &&
          (this.drawMeshCollision ||
            actorSelected ||
            hasSelectedAncestor(
              component.id,
              this.selectedComponentIds,
              (id) => components.get(id)?.parentId,
            ));
        // Component visuals may be parented below the collider. Only its own
        // dash segments are helpers; disabling the root hides those meshes too.
        for (const dash of visual.getChildMeshes(true)) {
          if (!dash.name.startsWith(`${visual.name}:dash:`)) continue;
          if (dash.isEnabled(false) === enabled) continue;
          dash.setEnabled(enabled);
          changed = true;
        }
      }
      yield changed;
    }
  }

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
    const generation = this.applyGeneration;
    const signal = this.pendingApply?.signal;
    const ownsLoad = () => generation === this.applyGeneration && !signal?.aborted &&
      !root.isDisposed() && !placeholder.isDisposed() && this.meshes.get(actor.id) === root;
    void beginSlotModelAnimLoad(
      this.scene,
      this.modelLoadBinding,
      slotId,
      guid,
      bytes,
      placeholder,
      () => {
        if (!ownsLoad()) return;
        const current = (this.applyingScene ?? this.lastScene)?.actors.find((entry) => entry.id === actor.id);
        if (!current) return;
        const wasFrozen = root.isWorldMatrixFrozen;
        applyActorTransform(root, current);
        this.restoreMeshComponentConstruction(current, root);
        this.applyModelSlots(current, root);
        this.bindActorMeshMaterials(current, root);
        // Adoption may land at a yield after this actor's final freeze step.
        // Restore that matrix without announcing a partially realized scene.
        if (wasFrozen || !this.applyingScene) freezeStaticActorWorldMatrix(root);
        if (!this.applyingScene) {
          this.freezeActiveQueue();
          this.scheduler?.invalidate("asset");
          this.onAfterApply?.();
        }
      },
      ownsLoad,
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
        if (isColliderVisualTree(target) || isTilemapChunkMesh(target)) continue;
        if (!this.constructionMaterials.has(target)) continue;
        target.material = this.constructionMaterials.get(target) ?? null;
        applyMaterialBounds(target);
      }
    }
  }

  private bindActorMeshMaterials(actor: SerializedActor, root: Mesh): void {
    for (const component of actor.components) {
      if (component.classId === "2DMaterialComponent") {
        this.bindMaterialOverride(
          root,
          authoredMaterialGuid(component.properties.materialGuid),
          { unlit: true },
        );
        continue;
      }
      if (component.classId === "2DPanelComponent") {
        const source = component.properties.source;
        if (source === "material") {
          this.bindMaterialOverride(
            root,
            authoredMaterialGuid(component.properties.materialGuid),
            { unlit: true },
          );
        }
        continue;
      }
      if (component.classId !== "MeshComponent") continue;
      if (meshKindOf(component) === "pivot") continue;
      const visual = visualForMeshComponent(root, actor.id, component.id);
      if (!visual) continue;
      if (
        component.properties.materialSource === "override" &&
        !authoredMaterialGuid(component.properties.materialGuid)
      ) {
        for (const target of meshAndDescendantMeshes(visual)) {
          if (isColliderVisualTree(target) || isTilemapChunkMesh(target)) continue;
          target.material = null;
          applyMaterialBounds(target);
        }
        continue;
      }
      this.bindMaterialOverride(
        visual,
        authoredMaterialGuid(component.properties.materialGuid),
      );
    }
  }

  private bindMaterialOverride(
    visual: Mesh,
    guid: string | null,
    options?: { unlit?: boolean },
  ): void {
    if (!guid) return;
    const targets = meshAndDescendantMeshes(visual).filter(
      (target) => !isTilemapChunkMesh(target),
    );
    for (const target of targets) {
      if (isColliderVisualTree(target)) continue;
      if (!this.constructionMaterials.has(target)) {
        this.constructionMaterials.set(target, target.material);
      }
    }
    const material =
      this.resolveMaterial?.(guid, { ...options, scene: this.scene }) ?? null;
    if (!material) return;
    for (const target of targets) {
      if (isColliderVisualTree(target)) continue;
      target.material = material;
      applyMaterialBounds(target);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.materialsRefreshable = false;
    this.materialRefreshGeneration = null;
    this.pendingApply?.abort(new Error("Scene realization was disposed."));
    this.pendingApply = null;
    this.realization = null;
    ++this.applyGeneration;
    this.applyingScene = null;
    for (const mesh of this.meshes.values()) {
      mesh.dispose();
    }
    this.meshes.clear();
    this.meshKinds.clear();
  }
}

function hasSelectedAncestor(
  id: string,
  selected: ReadonlySet<string>,
  parentOf: (id: string) => string | null | undefined,
): boolean {
  const seen = new Set<string>();
  let current: string | null | undefined = id;
  while (current && !seen.has(current)) {
    if (selected.has(current)) return true;
    seen.add(current);
    current = parentOf(current);
  }
  return false;
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
