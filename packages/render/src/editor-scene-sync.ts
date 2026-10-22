import { refreshJoystick2DMaterials } from "./joystick2d-mesh";
import { Mesh, type AbstractMesh, type Camera, type Material, type Node, type Scene } from "@babylonjs/core";
import { applyMaterialBounds } from "./material-bounds";
import { withNetMaterialChanges } from "./material-change-batch";
import { DEFAULT_SORTING_LAYERS, isSceneLayerAnchorActor, resolveOverlayLayout } from "@haptic/core";
import { applyEditorLayoutClips } from "./overlay-layout-render";
import type {
  SerializedActor,
  SerializedComponent,
  SerializedScene,
} from "@haptic/core";
import type { RenderScheduler } from "./render-scheduler";
import {
  meshAssetFingerprint,
  ownedVisualTexturePreparation,
  installModelSources,
  installTextureBytes,
  meshAssetFingerprintWithoutModels,
  modelSlotFingerprint,
  PayloadFingerprints,
  refreshAlbedoTextures,
  type MeshAssetContext,
} from "./mesh-assets";
import { applyModelMaterialSlots } from "./model-preview";
import { beginSlotModelAnimLoad, isEditorModelPlaceholder, type ModelAnimLoadBinding } from "./glb-anim";
import {
  actorIdFromMeshName,
  actorVisualFingerprint,
  applyActorTransform,
  applyActorComponentSorting,
  applyAuthoredActorMaterialInstances,
  applyComponentChildTransforms,
  createActorMesh,
  editorComponentMeshName,
  editorActorParentId,
  editorModelLoadTarget,
  freezeStaticActorWorldMatrix,
  isEditorActorOrigin,
  SceneActorIndex,
  syncMeshCollisionDashes,
  syncEditorCablePreviews,
  visualMeshesOfActorRoot,
} from "./scene-loader";
import { syncAuthoredIlluminationSteps } from "./scene-illumination";
import { runSceneWork, type SceneWorkOptions } from "./scene-work";
import { applyEditorBillboardFromActor } from "./editor-billboard";
import { isColliderVisualMesh, isColliderVisualTree } from "./collider-visual";
import { visualMeshes } from "./visual-meshes";
import { isTilemapChunkMesh } from "./tilemap-mesh";
import { BitmapAllocationLimitError } from "./text2d-bitmap";
import { refreshText2DMaterials, text2DBitmapBytes } from "./text2d-mesh";
import { pruneEditorCables } from "./cable-mesh";
import { authoredMaterialInstancePreparation } from "./authored-material-instance";
import type { NativePreparationPriority } from "./native-preparation";

export type EditorSceneSyncOptions = {
  resolveMaterial?: MeshAssetContext["resolveMaterial"];
  releaseMaterialInstance?: MeshAssetContext["releaseMaterialInstance"];
  validateMaterialParameter?: MeshAssetContext["validateMaterialParameter"];
  /** Preview maintenance yields native model preparation to active gameplay. */
  preparationPriority?: NativePreparationPriority;
  /** Fired after meshes/materials are bound so overlays can re-apply. */
  onAfterApply?: () => void;
};

/** The Materials a refresh covers: the actors using these guids, or every actor (`null`). */
type MaterialScope = ReadonlySet<string> | null;

function mergeMaterialScopes(current: MaterialScope | undefined, next: MaterialScope): MaterialScope {
  if (current === undefined) return next;
  if (current === null || next === null) return null;
  return new Set([...current, ...next]);
}

/**
 * Applies scene document edits to the Babylon editor scene incrementally, so a
 * gizmo drag touches one mesh instead of rebuilding the scene, and marks the
 * viewport dirty for the render-on-demand loop (engineplan §2.4).
 */
export class EditorSceneSync {
  private readonly meshes = new Map<string, Mesh>();
  /**
   * Each registered actor root with its actor id and its place in `meshes`'
   * insertion order, so a root's child actors are found through Babylon's own
   * child list rather than by visiting every root. See `registerActorMesh`.
   */
  private readonly rootEntries = new Map<Mesh, { actorId: string; rank: number }>();
  private nextRootRank = 0;
  private readonly meshKinds = new Map<string, string | null>();
  private readonly rejectedVisuals = new Map<string, string>();
  private readonly pendingVisuals = new Map<string, Mesh>();
  private readonly pendingTextureLoads = new Set<Promise<void>>();
  private applyGeneration = 0;
  private pendingApply: AbortController | null = null;
  private realization: Promise<void> | null = null;
  private applyingScene: SerializedScene | null = null;
  private materialRefreshGeneration: number | null = null;
  /** What the refresh owed once the running apply completes covers (see `refreshMaterialScope`). */
  private owedMaterialRefresh: MaterialScope | undefined;
  private materialsRefreshable = false;
  private materialRefreshTurn = false;
  /** What the publications after a turn's first cover, refreshed together once the turn ends. */
  private deferredMaterialRefresh: MaterialScope | undefined;
  /**
   * The Material guids each actor's last binding resolved, and the actors that
   * resolved each guid, so a Material that finished compiling rebinds only its
   * users (see `actorsToRefresh`). Maintained by `recordMaterialUses`.
   */
  private readonly actorMaterials = new Map<string, Set<string>>();
  private readonly materialActors = new Map<string, Set<string>>();
  private materialSession: { actorId: string; found: Set<string> } | null = null;
  private disposed = false;

  private readonly scene: Scene;
  private readonly scheduler?: Pick<RenderScheduler, "invalidate">;
  private readonly resolveMaterial?: MeshAssetContext["resolveMaterial"];
  private readonly releaseMaterialInstance?: MeshAssetContext["releaseMaterialInstance"];
  private readonly validateMaterialParameter?: MeshAssetContext["validateMaterialParameter"];
  private readonly onAfterApply?: () => void;
  private readonly preparationPriority?: NativePreparationPriority;
  private readonly constructionMaterials = new WeakMap<Mesh, Material | null>();
  private sortingLayers: string[] = [...DEFAULT_SORTING_LAYERS];
  private assets: MeshAssetContext | undefined;
  private lastAssetFingerprint: string | null = null;
  /** Remembers the serialized Tilemap, Tileset and Water payloads by revision, across installs. */
  private readonly payloadFingerprints = new PayloadFingerprints();
  /** `meshAssetFingerprintWithoutModels(this.assets)`, kept with the assets. */
  private lastAssetContentFingerprint = meshAssetFingerprintWithoutModels(undefined);
  private lastModelSlotKey = "";
  private assetsNeedRebuild = false;
  private lastScene: SerializedScene | null = null;
  private lastSceneActors: { actors: SerializedActor[]; length: number; byId: Map<string, SerializedActor> } | null = null;
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
    reuseFullDetailInstance: true,
  };

  constructor(
    scene: Scene,
    scheduler?: Pick<RenderScheduler, "invalidate">,
    options?: EditorSceneSyncOptions,
  ) {
    this.scene = scene;
    this.scheduler = scheduler;
    this.resolveMaterial = options?.resolveMaterial;
    this.releaseMaterialInstance = options?.releaseMaterialInstance;
    this.validateMaterialParameter = options?.validateMaterialParameter;
    this.onAfterApply = options?.onAfterApply;
    this.preparationPriority = options?.preparationPriority;
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

  /**
   * Swap the stored encoding (PNG to KTX2) of installed Textures whose pixels,
   * sampler and settings did not change, without rebuilding any mesh. Owned
   * albedo bindings take a successor lease that replaces the working one once
   * ready, and Materials re-resolve through the library, which keeps the
   * previous generation until its replacement compiles. `textureBytes` is the
   * complete installed map: later `setMeshAssets` calls compare against it, so
   * an install carrying the same bytes stays a no-op.
   */
  replaceTextureEncodings(textureBytes: NonNullable<MeshAssetContext["textureBytes"]>, guids: readonly string[]): void {
    if (this.disposed || !this.assets) return;
    const assets: MeshAssetContext = { ...this.assets, textureBytes };
    this.assets = assets;
    this.lastAssetContentFingerprint = meshAssetFingerprintWithoutModels(assets, this.payloadFingerprints);
    this.lastAssetFingerprint = meshAssetFingerprint(assets, this.lastAssetContentFingerprint);
    const changed = new Set(guids);
    const pending: Promise<void>[] = [];
    for (const root of this.meshes.values()) {
      if (!root.isDisposed()) pending.push(...refreshAlbedoTextures(root, assets, changed));
    }
    this.refreshMaterials();
    this.scheduler?.invalidate("asset");
    // A successor publishes when its upload is ready, which no scene event announces.
    if (pending.length > 0) {
      void Promise.allSettled(pending).then(() => {
        if (!this.disposed && !this.scene.isDisposed) this.scheduler?.invalidate("asset");
      });
    }
  }

  private installAssets(assets: MeshAssetContext | undefined): { rebuild: boolean; reapply: boolean } {
    if (assets) assets = {
      ...assets,
      modelSources: installModelSources(assets),
      textureBytes: installTextureBytes(assets.textureBytes),
      fontMsdfPng: installTextureBytes(assets.fontMsdfPng),
    };
    // Serialize the tilemap, tileset and water payloads once per install, and
    // not at all when the host reports their revisions unchanged.
    const contentFingerprint = meshAssetFingerprintWithoutModels(assets, this.payloadFingerprints);
    const fingerprint = meshAssetFingerprint(assets, contentFingerprint);
    const slotKey = modelSlotFingerprint(assets?.modelPayloads);
    const onlyModelsChanged = contentFingerprint === this.lastAssetContentFingerprint;
    const layers = assets?.sortingLayers
      ? [...(assets.sortingLayers.length > 0 ? assets.sortingLayers : DEFAULT_SORTING_LAYERS)]
      : this.sortingLayers;
    const reapply = fingerprint !== this.lastAssetFingerprint || slotKey !== this.lastModelSlotKey || JSON.stringify(layers) !== JSON.stringify(this.sortingLayers);
    const rebuild = fingerprint !== this.lastAssetFingerprint && !onlyModelsChanged;
    this.assetsNeedRebuild ||= rebuild;
    this.assets = assets;
    this.sortingLayers = layers;
    this.lastAssetFingerprint = fingerprint;
    this.lastAssetContentFingerprint = contentFingerprint;
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
      this.scheduler?.invalidate("selection");
    }
  }

  apply(sceneData: SerializedScene): void {
    this.pendingApply?.abort(new Error("Scene realization was superseded."));
    this.pendingApply = null;
    this.realization = null;
    const generation = ++this.applyGeneration;
    this.materialRefreshGeneration = null;
    this.owedMaterialRefresh = undefined;
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
        for (const _progress of this.materialRefreshSteps(sceneData, this.takeOwedMaterialRefresh())) void _progress;
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
    this.owedMaterialRefresh = undefined;
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
        await runSceneWork(this.applySteps(sceneData, rebuild), work);
        while (this.materialRefreshGeneration === generation) {
          this.materialRefreshGeneration = null;
          await runSceneWork(this.materialRefreshSteps(sceneData, this.takeOwedMaterialRefresh()), work);
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
        this.owedMaterialRefresh = undefined;
      }
    }
  }

  private *applySteps(sceneData: SerializedScene, rebuild = false): Generator<number, void, unknown> {
    const layout = resolveOverlayLayout(sceneData.actors, { pixelsPerUnit: this.assets?.pixelsPerUnit, textureSize: guid => this.assets?.texturePixelSizes?.get(guid) });
    sceneData = { ...sceneData, actors: layout.actors };
    // One lazily built lookup answers the per-actor visual rules (streaming
    // labels, 2D buttons) instead of each actor scanning the Scene's actors.
    const actorIndex = new SceneActorIndex(sceneData.actors);
    rebuild ||= this.assetsNeedRebuild;
    const assets = this.meshAssetsForScene(sceneData);
    const liveIds = new Set<string>();
    const nextKinds = new Map<string, string | null>();
    const retired = new Set<string>();
    const oldMeshes = [...this.meshes];
    const actorCount = Math.max(1, sceneData.actors.length);
    let index = 0;
    for (const actor of sceneData.actors) {
      if (isSceneLayerAnchorActor(actor)) continue;
      liveIds.add(actor.id);
      const kind = actorVisualFingerprint(actor, assets, actorIndex);
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
      if (!liveIds.has(actor.id)) continue;
      let mesh = this.meshes.get(actor.id);
      let prepared = false;
      const descriptor = `${nextKinds.get(actor.id)}|${this.lastAssetFingerprint}|${this.scene.getEngine().getCaps().maxTextureSize}`;
      if ((!mesh || retired.has(actor.id) || mesh.isDisposed()) && this.rejectedVisuals.get(actor.id) !== descriptor) {
        let replacement: Mesh | undefined;
        try {
          replacement = createActorMesh(this.scene, actor, {
            ...assets, retainedTextBitmapBytes: text2DBitmapBytes(mesh),
          }, actorIndex);
          const previous = mesh;
          this.prepareActorVisual(actor, replacement);
          const modelGuid = this.meshComponentAssetGuid(actor);
          const textureReady = ownedVisualTexturePreparation(replacement);
          if (previous && !previous.isDisposed() && (modelGuid || textureReady)) {
            // Exact texture preparation includes upload and budget admission.
            // Models keep their existing material/animation transaction too.
            replacement.setEnabled(false);
            const candidate = replacement;
            const generation = this.applyGeneration;
            const signal = this.pendingApply?.signal;
            if (modelGuid && !this.assets?.modelSources?.has(modelGuid)) {
              candidate.dispose();
              void textureReady?.catch(() => {});
            } else {
              this.pendingVisuals.set(actor.id, candidate);
              const ownsLoad = () => generation === this.applyGeneration && !signal?.aborted &&
                !this.disposed && !this.scene.isDisposed && !candidate.isDisposed() &&
                this.pendingVisuals.get(actor.id) === candidate && this.meshes.get(actor.id) === previous;
              const onAdopted = () => {
                if (!ownsLoad()) return;
                // Ownership pins this load to the current apply generation.
                // Its actor is already arranged; the stored document keeps the
                // authored pose and must not undo that arrangement on adoption.
                this.prepareActorVisual(actor, candidate);
                candidate.parent = previous.parent;
                this.moveChildActors(previous, candidate);
                this.registerActorMesh(actor.id, candidate);
                this.meshKinds.set(actor.id, nextKinds.get(actor.id) ?? null);
                this.rejectedVisuals.delete(actor.id);
                this.pendingVisuals.delete(actor.id);
                candidate.setEnabled(true);
                previous.dispose();
                applyEditorLayoutClips(this.scene, layout.entries);
                freezeStaticActorWorldMatrix(candidate);
                if (!this.applyingScene) {
                  this.scheduler?.invalidate("asset");
                  this.onAfterApply?.();
                }
              };
              let failedFoliage = false;
              const load = (textureReady ?? Promise.resolve()).then(async () => {
                if (!ownsLoad()) return;
                if (modelGuid) await this.beginEditorModelLoad(actor, candidate, { ownsLoad, onAdopted });
                else onAdopted();
              }, (error: unknown) => {
                if (ownsLoad()) this.rejectedVisuals.set(actor.id, descriptor);
                if (actor.components.some((component) => component.classId === "FoliageComponent") && ownsLoad()) {
                  failedFoliage = true;
                  throw error;
                }
                // The exact texture owner reports preparation failure once.
              }).finally(() => {
                if (this.pendingVisuals.get(actor.id) === candidate) this.pendingVisuals.delete(actor.id);
                if (this.meshes.get(actor.id) !== candidate) candidate.dispose();
                // Keep a settled rejection observable until the next scene generation.
                if (!failedFoliage) this.pendingTextureLoads.delete(load);
              });
              this.pendingTextureLoads.add(load);
              void load.catch((error: unknown) => console.warn(`[render] Visual publication failed: ${String(error)}`));
            }
            applyActorTransform(previous, actor);
            yield 0.2 + 0.3 * ++index / actorCount;
            continue;
          }
          // Initial creation retains the existing immediate placeholder path.
          // Factories own failure cleanup; this observer prevents an abandoned aggregate.
          void textureReady?.catch(() => {});
          mesh = replacement;
          prepared = true;
          this.registerActorMesh(actor.id, mesh);
          this.meshKinds.set(actor.id, nextKinds.get(actor.id) ?? null);
          this.rejectedVisuals.delete(actor.id);
          previous?.dispose();
        } catch (error) {
          if (replacement && replacement !== this.meshes.get(actor.id)) replacement.dispose();
          const ownsTexture = actor.components.some((component) =>
            component.classId === "SkyboxComponent" || component.classId === "SpriteComponent" || component.classId === "TilemapComponent");
          if ((!ownsTexture && !(error instanceof BitmapAllocationLimitError)) || !mesh || mesh.isDisposed()) throw error;
          this.rejectedVisuals.set(actor.id, descriptor);
          console.warn(error instanceof BitmapAllocationLimitError
            ? `[render] ${error.code}: ${error.message}`
            : `[render] Visual replacement failed: ${String(error)}`);
        }
      }
      if (!mesh) continue;
      this.beginEditorModelLoad(actor, mesh);
      this.trackFoliagePreparation(actor, mesh);
      if (!prepared) this.prepareActorVisual(actor, mesh);
      yield 0.2 + 0.3 * ++index / actorCount;
    }
    index = 0;
    for (const [actorId, mesh] of oldMeshes) {
      if (!liveIds.has(actorId)) {
        mesh.dispose();
        this.unregisterActorMesh(actorId);
        this.forgetMaterialUses(actorId);
        this.meshKinds.delete(actorId);
        this.rejectedVisuals.delete(actorId);
      }
      yield 0.5 + 0.1 * ++index / Math.max(1, oldMeshes.length);
    }
    index = 0;
    const actorsById = new Map(sceneData.actors.map((actor) => [actor.id, actor]));
    for (const actor of sceneData.actors) {
      const mesh = this.meshes.get(actor.id);
      if (mesh) {
        const parentId = editorActorParentId(actor, actorsById);
        const parent = parentId ? this.meshes.get(parentId) ?? null : null;
        if (mesh.parent !== parent) mesh.parent = parent;
      }
      yield 0.6 + 0.1 * ++index / actorCount;
    }
    // Editor cables simulate per frame from the live actor roots (no collision).
    syncEditorCablePreviews(this.scene, sceneData.actors, {
      rootForActor: (actorId) => this.meshes.get(actorId) ?? null,
      gravity: sceneData.settings.gravity,
      simulate: true,
    });
    applyEditorLayoutClips(this.scene, layout.entries);
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
    this.lastSceneActors = null;
    this.assetsNeedRebuild = false;
    this.onAfterApply?.();
    if (generation !== this.applyGeneration) return;
    this.applyingScene = null;
    this.materialsRefreshable = true;
    this.scheduler?.invalidate("asset");
  }

  /**
   * Rebinds the Materials of every actor. A material publication belongs to the
   * current load, not a new document edit.
   */
  refreshMaterials(): void {
    this.refreshMaterialScope(null);
  }

  /**
   * `refreshMaterials` for Material publications, which arrive one at a time and
   * each used to cost a pass over every actor. A publication names the Material
   * that finished compiling, and only the actors that resolved it are rebound.
   * The first publication of a microtask turn refreshes at once; those settling
   * in the same turn share one more pass, run after them, so the last
   * publication's binding still lands. Without a guid every actor is rebound.
   */
  refreshMaterialsCoalesced(guid?: string): void {
    const scope: MaterialScope = guid === undefined ? null : new Set([guid]);
    if (this.materialRefreshTurn) {
      this.deferredMaterialRefresh = mergeMaterialScopes(this.deferredMaterialRefresh, scope);
      return;
    }
    this.materialRefreshTurn = true;
    queueMicrotask(() => {
      this.materialRefreshTurn = false;
      const deferred = this.deferredMaterialRefresh;
      if (deferred === undefined) return;
      this.deferredMaterialRefresh = undefined;
      this.refreshMaterialScope(deferred);
    });
    this.refreshMaterialScope(scope);
  }

  private refreshMaterialScope(scope: MaterialScope): void {
    if (this.disposed || this.scene.isDisposed || this.pendingApply?.signal.aborted) return;
    if (this.applyingScene) {
      this.materialRefreshGeneration = this.applyGeneration;
      this.owedMaterialRefresh = mergeMaterialScopes(this.owedMaterialRefresh, scope);
      return;
    }
    // An aborted/failed apply retains partial roots for the next reconciliation.
    // Late material publication must not reactivate that partial generation.
    if (!this.materialsRefreshable || !this.lastScene) return;
    for (const _progress of this.materialRefreshSteps(this.lastScene, scope)) void _progress;
    this.onAfterApply?.();
    this.scheduler?.invalidate("asset");
  }

  private takeOwedMaterialRefresh(): MaterialScope {
    const owed = this.owedMaterialRefresh ?? null;
    this.owedMaterialRefresh = undefined;
    return owed;
  }

  private *materialRefreshSteps(sceneData: SerializedScene, scope: MaterialScope): Generator<number, void, unknown> {
    const only = scope && this.actorsToRefresh(scope);
    for (const actor of sceneData.actors) {
      if (only && !only.has(actor.id)) continue;
      const root = this.meshes.get(actor.id);
      if (root && !root.isDisposed()) {
        this.recordMaterialUses(actor.id, () => {
          this.refreshEnvironmentComponents(actor, root, () => this.meshAssetsForScene(sceneData));
          this.bindActorMaterials(actor, root);
        });
      }
      yield 0.99;
    }
  }

  /**
   * The actors to rebind when these Materials finished compiling: those whose
   * last binding resolved one, plus every actor in the same tree of roots.
   *
   * A binding assigns Materials to every mesh beneath the visual it binds, and
   * that can include a child actor's meshes (a parent that is its own single
   * visual). A full pass puts a child's Materials back when the child, bound
   * after its parent in Scene order, restores or overrides them. A refresh that
   * rebound the parent alone would leave the child with the parent's Material,
   * so a user's whole tree (the topmost registered ancestor and everything
   * beneath it) is rebound, in Scene order like a full pass.
   */
  private actorsToRefresh(guids: ReadonlySet<string>): Set<string> {
    const actors = new Set<string>();
    const walked = new Set<Mesh>();
    for (const guid of guids) {
      for (const actorId of this.materialActors.get(guid) ?? []) {
        let top = this.meshes.get(actorId);
        if (!top || top.isDisposed()) continue;
        for (let node = top.parent; node; node = node.parent) {
          if (node instanceof Mesh && this.rootEntries.has(node)) top = node;
        }
        if (walked.has(top)) continue;
        walked.add(top);
        for (const root of [top, ...top.getChildMeshes(false)]) {
          const entry = root instanceof Mesh ? this.rootEntries.get(root) : undefined;
          if (entry) actors.add(entry.actorId);
        }
      }
    }
    return actors;
  }

  /**
   * Runs one actor's binding and records the Material guids it resolved,
   * replacing what the actor's previous binding recorded. A guid resolved after
   * the binding returned (an asynchronous continuation of it) is added to the
   * record as it happens.
   */
  private recordMaterialUses(actorId: string, bind: () => void): void {
    const outer = this.materialSession;
    const session = { actorId, found: new Set<string>() };
    this.materialSession = session;
    try {
      bind();
    } finally {
      this.materialSession = outer;
      const previous = this.actorMaterials.get(actorId);
      if (previous) for (const guid of previous) if (!session.found.has(guid)) this.unindexMaterialUse(guid, actorId);
      for (const guid of session.found) if (!previous?.has(guid)) this.indexMaterialUse(guid, actorId);
      this.actorMaterials.set(actorId, session.found);
    }
  }

  private noteMaterialUse(actorId: string, guid: string): void {
    if (this.materialSession?.actorId === actorId) {
      this.materialSession.found.add(guid);
      return;
    }
    const known = this.actorMaterials.get(actorId);
    if (known && !known.has(guid)) {
      known.add(guid);
      this.indexMaterialUse(guid, actorId);
    }
  }

  private indexMaterialUse(guid: string, actorId: string): void {
    const actors = this.materialActors.get(guid);
    if (actors) actors.add(actorId);
    else this.materialActors.set(guid, new Set([actorId]));
  }

  private unindexMaterialUse(guid: string, actorId: string): void {
    const actors = this.materialActors.get(guid);
    if (!actors?.delete(actorId) || actors.size > 0) return;
    this.materialActors.delete(guid);
  }

  private forgetMaterialUses(actorId: string): void {
    const guids = this.actorMaterials.get(actorId);
    if (!guids) return;
    for (const guid of guids) this.unindexMaterialUse(guid, actorId);
    this.actorMaterials.delete(actorId);
  }

  /** `resolve`, noting each guid it is asked for as one `actorId` resolved. */
  private notingUses(actorId: string, resolve: MeshAssetContext["resolveMaterial"]): MeshAssetContext["resolveMaterial"] {
    return resolve && ((guid, options) => {
      this.noteMaterialUse(actorId, guid);
      return resolve(guid, options);
    });
  }

  /** This sync's resolver, then the installed assets', noting each guid as one `actorId` resolved. */
  private resolverFor(actorId: string): NonNullable<MeshAssetContext["resolveMaterial"]> {
    return (guid, options) => {
      this.noteMaterialUse(actorId, guid);
      return this.resolveMaterial?.(guid, options) ?? this.assets?.resolveMaterial?.(guid, options) ?? null;
    };
  }

  serializedScene(): SerializedScene | null {
    return this.lastScene;
  }

  meshForActor(actorId: string): Mesh | null {
    return this.meshes.get(actorId) ?? null;
  }

  /**
   * `lastScene.actors.find` for an id, through an index built once per applied
   * Scene so per-actor consumers (deformers, brushes) do not scan every actor.
   * Applying drops the index, so a document edited in place between applies is
   * read again; the actors array identity and length also guard it. The first
   * actor with an id wins, like `find`.
   */
  private lastSceneActor(actorId: string): SerializedActor | undefined {
    const actors = this.lastScene?.actors;
    if (!actors) return undefined;
    let index = this.lastSceneActors;
    if (index?.actors !== actors || index.length !== actors.length) {
      const byId = new Map<string, SerializedActor>();
      for (const actor of actors) if (!byId.has(actor.id)) byId.set(actor.id, actor);
      index = this.lastSceneActors = { actors, length: actors.length, byId };
    }
    return index.byId.get(actorId);
  }

  /** Exact authored component visual; asset consumers never infer identity from mesh order. */
  meshForComponent(actorId: string, componentId: string): Mesh | null {
    const actor = this.lastSceneActor(actorId);
    const component = actor?.components.find((entry) => entry.id === componentId);
    const root = this.meshes.get(actorId);
    return root && component && ["MeshComponent", "LandscapeComponent", "FoliageComponent"].includes(component.classId)
      ? visualForMeshComponent(root, actorId, componentId) : null;
  }

  /** Authored visual boundaries, including attached non-Mesh components.
   * Imported subparts and another actor's visuals retain their own ownership. */
  visualComponentRootsForActor(actorId: string): Mesh[] {
    const actor = this.lastSceneActor(actorId);
    const root = this.meshes.get(actorId);
    if (!actor || !root) return [];
    if (!isEditorActorOrigin(root)) return [root];
    const names = new Set(actor.components.map((component) => editorComponentMeshName(actorId, component.id)));
    return visualMeshesOfActorRoot(root).filter((mesh) => names.has(mesh.name));
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

  /**
   * Registers an actor's root. A replacement keeps the id's place in `meshes`
   * (a `Map` keeps a key's position when its value changes), and so its rank.
   */
  private registerActorMesh(actorId: string, mesh: Mesh): void {
    const previous = this.meshes.get(actorId);
    const rank = (previous ? this.rootEntries.get(previous)?.rank : undefined) ?? this.nextRootRank++;
    if (previous) this.rootEntries.delete(previous);
    this.rootEntries.set(mesh, { actorId, rank });
    this.meshes.set(actorId, mesh);
  }

  private unregisterActorMesh(actorId: string): void {
    const mesh = this.meshes.get(actorId);
    if (mesh) this.rootEntries.delete(mesh);
    this.meshes.delete(actorId);
  }

  /**
   * Re-parents every registered actor root beneath `from` onto `to`, in the
   * order the roots were registered, as a pass over all roots would. The
   * children come from Babylon's own child list, which the `parent` setter keeps
   * current, so the cost follows the number of children, not of actors.
   */
  private moveChildActors(from: Mesh, to: Mesh): void {
    const children: Array<{ mesh: Mesh; rank: number }> = [];
    for (const child of from.getChildren(undefined, true)) {
      if (!(child instanceof Mesh)) continue;
      const entry = this.rootEntries.get(child);
      if (entry) children.push({ mesh: child, rank: entry.rank });
    }
    children.sort((a, b) => a.rank - b.rank);
    for (const { mesh } of children) mesh.parent = to;
  }

  async whenEditorModelsReady(): Promise<void> {
    await this.realization;
    const loads = [...(this.modelLoadBinding.slotAnimLoads?.values() ?? []), ...this.pendingTextureLoads];
    for (const root of this.meshes.values()) for (const mesh of [root, ...root.getChildMeshes()]) {
      const preparation = authoredMaterialInstancePreparation(mesh as Mesh);
      if (preparation) loads.push(preparation);
    }
    if (loads.length === 0) return Promise.resolve();
    return Promise.all(loads).then(() => undefined);
  }

  private resetModelReadiness(): void {
    // Prior waiters retain their promises, but a replacement waits only for its
    // own submissions. Generation ownership prevents obsolete adoption.
    this.modelLoadBinding.slotAnimLoads?.clear();
    this.modelLoadBinding.slotAnimEpoch?.clear();
    for (const candidate of this.pendingVisuals.values()) candidate.dispose();
    this.pendingVisuals.clear();
    this.pendingTextureLoads.clear();
  }

  private trackFoliagePreparation(actor: SerializedActor, root: Mesh): void {
    if (!actor.components.some((component) => component.classId === "FoliageComponent")) return;
    const ready = ownedVisualTexturePreparation(root);
    if (!ready) return;
    const generation = this.applyGeneration;
    const signal = this.pendingApply?.signal;
    const load = ready.then(() => {
      if (generation !== this.applyGeneration || signal?.aborted || this.disposed || root.isDisposed() || this.meshes.get(actor.id) !== root) return;
      // This generation's actor includes the resolved layout pose. The stored
      // scene remains authored and must not overwrite it after preparation.
      this.prepareActorVisual(actor, root);
      freezeStaticActorWorldMatrix(root);
      if (!this.applyingScene) {
        this.scheduler?.invalidate("asset");
        this.onAfterApply?.();
      }
    });
    // Retain failures in the generation's readiness set for the loading dialog.
    this.pendingTextureLoads.add(load);
    void load.catch((error: unknown) => console.warn(`[render] Foliage preparation failed: ${String(error)}`));
  }

  private refreshEnvironmentComponents(actor: SerializedActor, root: Mesh, assets: () => MeshAssetContext | undefined): void {
    for (const component of actor.components) {
      const visual = visualForMeshComponent(root, actor.id, component.id);
      if (!visual) continue;
      if (component.classId !== "LandscapeComponent" && component.classId !== "FoliageComponent") continue;
      const installed = assets();
      const context = { ...installed, resolveMaterial: this.notingUses(actor.id, this.resolveMaterial ?? installed?.resolveMaterial) };
      if (component.classId === "LandscapeComponent") updateLandscapeMesh(visual, component.properties, context);
      else refreshFoliageMaterials(visual, context);
    }
  }

  private prepareActorVisual(actor: SerializedActor, mesh: Mesh): void {
    this.recordMaterialUses(actor.id, () => {
      this.refreshEnvironmentComponents(actor, mesh, () => this.assets);
      applyActorTransform(mesh, actor);
      applyComponentChildTransforms(mesh, actor);
      applyEditorBillboardFromActor(mesh, actor);
      for (const child of visualMeshesOfActorRoot(mesh)) applyEditorBillboardFromActor(child, actor);
      applyActorComponentSorting(mesh, actor, this.sortingLayers);
      this.bindActorMaterials(actor, mesh);
    });
  }

  /**
   * Construction, model slot, override and saved-instance Materials assign in
   * turn; observers hear only the net result, so an unchanged actor announces
   * nothing and does not make the renderer re-probe its shader variants.
   */
  private bindActorMaterials(actor: SerializedActor, root: Mesh): void {
    this.noteDeclaredMaterials(actor);
    withNetMaterialChanges([root, ...root.getChildMeshes(false)], () => {
      this.restoreMeshComponentConstruction(actor, root);
      this.applyModelSlots(actor, root);
      this.bindActorMeshMaterials(actor, root);
    });
  }

  /**
   * The Materials the actor's document names, noted even where the binding does
   * not get as far as resolving them (a visual or model not built yet, a saved
   * instance still preparing), so a Material that finishes compiling in the
   * meantime still reaches the actor.
   */
  private noteDeclaredMaterials(actor: SerializedActor): void {
    for (const component of actor.components) {
      const guid = authoredMaterialGuid(component.properties.materialGuid);
      if (guid) this.noteMaterialUse(actor.id, guid);
    }
    const model = this.meshComponentAssetGuid(actor);
    for (const slot of (model ? this.assets?.modelPayloads?.get(model)?.materialSlots : undefined) ?? []) {
      if (slot.materialGuid) this.noteMaterialUse(actor.id, slot.materialGuid);
    }
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
      releaseMaterialInstance: this.releaseMaterialInstance ?? this.assets?.releaseMaterialInstance,
      validateMaterialParameter: this.validateMaterialParameter ?? this.assets?.validateMaterialParameter,
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
    const resolve = this.notingUses(actor.id, this.resolveMaterial);
    applyModelMaterialSlots(
      editorModelLoadTarget(root, actor),
      payload.materialSlots,
      (materialGuid) => resolve?.(materialGuid) ?? null,
    );
  }

  private beginEditorModelLoad(actor: SerializedActor, root: Mesh, publication?: {
    ownsLoad: () => boolean;
    onAdopted: () => void;
  }): Promise<void> | undefined {
    const guid = this.meshComponentAssetGuid(actor);
    const bytes = guid ? this.assets?.modelSources?.get(guid) : undefined;
    if (!guid || !bytes) return;
    const slotId = ++this.modelLoadSlot;
    this.modelLoadBinding.modelBytes = this.assets?.modelBytes;
    this.modelLoadBinding.modelSources = this.assets?.modelSources;
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
      !root.isDisposed() && !placeholder.isDisposed() && (publication ? publication.ownsLoad() : this.meshes.get(actor.id) === root);
    return beginSlotModelAnimLoad(
      this.scene,
      this.modelLoadBinding,
      slotId,
      guid,
      bytes,
      placeholder,
      () => {
        if (!ownsLoad()) return;
        publication?.onAdopted();
        const wasFrozen = root.isWorldMatrixFrozen;
        applyActorTransform(root, actor);
        // Adoption may land at a yield after this actor's final freeze step.
        // Restore that matrix without announcing a partially realized scene.
        if (wasFrozen || !this.applyingScene) freezeStaticActorWorldMatrix(root);
        if (!this.applyingScene) {
          this.scheduler?.invalidate("asset");
          this.onAfterApply?.();
        }
      },
      ownsLoad,
      (prepared) => {
        if (!ownsLoad()) return;
        this.bindActorMaterials(actor, prepared);
      },
      this.preparationPriority,
    );
  }

  private restoreMeshComponentConstruction(
    actor: SerializedActor,
    root: Mesh,
  ): void {
    for (const component of actor.components) {
      if (component.classId !== "MeshComponent" && component.classId !== "CableComponent") continue;
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
    const resolveMaterial = this.resolverFor(actor.id);
    refreshJoystick2DMaterials(root, { resolveMaterial });
    refreshText2DMaterials(root, { resolveMaterial });
    for (const component of actor.components) {
      if (component.classId === "2DMaterialComponent") {
        this.bindMaterialOverride(
          actor.id,
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
            actor.id,
            root,
            authoredMaterialGuid(component.properties.materialGuid),
            { unlit: true },
          );
        }
        continue;
      }
      if (component.classId !== "MeshComponent" && component.classId !== "CableComponent") continue;
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
        actor.id,
        visual,
        authoredMaterialGuid(component.properties.materialGuid),
      );
    }
    applyAuthoredActorMaterialInstances(root, actor, {
      ...this.assets,
      resolveMaterial,
      releaseMaterialInstance: this.releaseMaterialInstance ?? this.assets?.releaseMaterialInstance,
      validateMaterialParameter: this.validateMaterialParameter ?? this.assets?.validateMaterialParameter,
    }, () => {
      this.scheduler?.invalidate("asset");
      this.onAfterApply?.();
    });
  }

  private bindMaterialOverride(
    actorId: string,
    visual: Mesh,
    guid: string | null,
    options?: { unlit?: boolean },
  ): void {
    if (!guid) return;
    const targets = meshAndDescendantMeshes(visual).filter(
      (target) => !isTilemapChunkMesh(target) && !target.metadata?.text2d && !target.metadata?.text2dGlyph && !target.metadata?.overlayJoystickMeshName && !target.metadata?.joystick2DThumb,
    );
    for (const target of targets) {
      if (isColliderVisualTree(target)) continue;
      if (!this.constructionMaterials.has(target)) {
        this.constructionMaterials.set(target, target.material);
      }
    }
    this.noteMaterialUse(actorId, guid);
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
    this.owedMaterialRefresh = undefined;
    this.pendingApply?.abort(new Error("Scene realization was disposed."));
    this.pendingApply = null;
    this.realization = null;
    ++this.applyGeneration;
    this.applyingScene = null;
    this.resetModelReadiness();
    for (const mesh of this.meshes.values()) {
      mesh.dispose();
    }
    this.meshes.clear();
    this.rootEntries.clear();
    this.actorMaterials.clear();
    this.materialActors.clear();
    this.meshKinds.clear();
    pruneEditorCables(this.scene);
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
  // Automatic LOD levels are blocked meshes that mirror their master's material.
  const children = root
    .getChildMeshes()
    .filter((child): child is Mesh => child instanceof Mesh && !child.isBlocked);
  return [root, ...children];
}
import { updateLandscapeMesh } from "./landscape-mesh";
import { refreshFoliageMaterials } from "./foliage-mesh";
