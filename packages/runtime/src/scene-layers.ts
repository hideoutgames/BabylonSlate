import type { CommandMessage } from "@babylonslate/bridge";
import { newGuid, normalizeSceneLayer, remapSceneStreamingReferences, type SerializedActor, type SerializedSceneLayer } from "@babylonslate/core";
import { hydrateScenePropertyReferences, type Actor, type BObject, type SceneLayer, type World } from "@babylonslate/object-model";
import type { RuntimeAssetPreloads } from "./asset-preloads";
import type { OwnerAdmission } from "./owner-admission";
import type { RuntimeSubsystem } from "./runtime-subsystems";
import type { SceneLayerOverlay } from "./scene-layer-overlay";
import { runSceneRealizationWork, sceneRealizationCancelled, waitForSceneWork, type CooperativeSceneLoadingOptions } from "./scene-realization-work";
import type { ScriptHostServices } from "./script-host";

interface SceneLayerLoad {
  readonly layer: SceneLayer;
  readonly loadId: number;
  /** Its actors are created, spawned and assigned. */
  realized: boolean;
  /** The host acknowledged it (or no acknowledgement was deferred). */
  presented: boolean;
  /** Presented outside Play boot loading: its owners may run. */
  ready: boolean;
}

/** A Scene Layer's load identity and readiness. */
export type SceneLayerLoadState = Readonly<SceneLayerLoad>;

/** The main Scene realization that creates its owned layers: its cancellation check and acquired objects. */
export interface SceneLayerRealization {
  check(): void;
  readonly layers: SceneLayer[];
  readonly actors: Actor[];
}

interface IndependentLayerWork {
  layer: SceneLayer;
  loadId: number;
  controller: AbortController;
  painted: () => void;
}

interface SceneLayersHost {
  world(): World;
  stopped(): boolean;
  frameId(): number;
  /** Play boot loading holds a presented layer until it finishes. */
  bootLoading(): boolean;
  cooperativeLoading(): CooperativeSceneLoadingOptions | null;
  /** The host acknowledges model readiness itself (`notifyReady`). */
  deferModelsReady(): boolean;
  /** The host acknowledges the loading paint itself (`notifyLoadingPainted`). */
  deferLoadingPaint(): boolean;
  /** The Scene Layer document of an asset guid, when loaded. */
  document(assetGuid: string): SerializedSceneLayer | undefined;
  /** Script-created layers prepare their asset on demand first. */
  demandAssets(): boolean;
  assetPreloads(): Pick<RuntimeAssetPreloads, "acquire" | "transferOwner" | "release" | "releaseOwner">;
  continueSimulation(owner: BObject | null): Promise<void> | undefined;
  /** A layer instance with Enable Physics gets its own physics world with its gravity. */
  addLayerPhysics(
    layerGuid: string,
    assetGuid: string,
    settings: Pick<SerializedSceneLayer["settings"], "gravity" | "physicsEnabled">,
    actors: readonly SerializedActor[],
  ): void;
  /** A removed layer instance releases its physics world. */
  removeLayerPhysics(layerGuid: string): void;
  /** Simulation Keep cannot retain this independent layer instance. */
  markUnsupportedInstance(layerGuid: string): void;
  createActor(serialized: SerializedActor, layerGuid: string): Actor | null;
  publishSnapshot(): void;
  syncOverlayPhysics(): void;
  /** A layer became ready; the main Scene's load may be waiting for it. */
  tryCompleteSceneLoad(): void;
  /** Remove an actor instance the way the driver removes any owned actor. */
  removeActor(actor: Actor): void;
  cancelInvalidTweens(): void;
  reportError(error: unknown): void;
  emit(command: CommandMessage): void;
}

/**
 * Scene Layer lifecycle: the load table keyed by layer guid, creation (immediate,
 * cooperative after the host's loading paint, or a script's latent create that
 * waits for readiness), host readiness, removal and clearing, and the layer
 * post-process stack. The overlay realizes a layer's created actors and owns
 * its layout, anchors, focus and pointer input.
 */
export class SceneLayers implements RuntimeSubsystem {
  private loadId = 0;
  private readonly loads = new Map<string, SceneLayerLoad>();
  private readonly independentWork = new Map<string, IndependentLayerWork>();
  private readonly readinessWaiters = new Map<string, { resolve: () => void; reject: (error: unknown) => void }>();
  private readonly admission: OwnerAdmission;
  private readonly overlay: Pick<SceneLayerOverlay, "realizeActors" | "forget">;
  private readonly host: SceneLayersHost;

  constructor(admission: OwnerAdmission, overlay: Pick<SceneLayerOverlay, "realizeActors" | "forget">, host: SceneLayersHost) {
    this.admission = admission;
    this.overlay = overlay;
    this.host = host;
  }

  /** Stop, phase 1: cancel independent creation and remove its layers before Stop returns. */
  cancelPending(): void {
    for (const work of [...this.independentWork.values()]) {
      work.controller.abort(sceneRealizationCancelled());
      // Finish live ownership cleanup before Stop returns; a later rejected
      // paint/yield continuation must not emit commands into a disposed host.
      if (this.host.world().findSceneLayer(work.layer.guid) === work.layer) this.remove(work.layer.guid);
    }
    this.independentWork.clear();
  }

  /** Stop begins: latent creates waiting for readiness are cancelled. */
  rejectWaiters(): void {
    for (const waiter of this.readinessWaiters.values()) waiter.reject(sceneRealizationCancelled());
    this.readinessWaiters.clear();
  }

  /** Stop ends: forget every load. */
  clear(): void {
    this.loads.clear();
  }

  get(layerGuid: string): SceneLayerLoadState | undefined {
    return this.loads.get(layerGuid);
  }

  /** Some live layer is ready. */
  anyReady(): boolean {
    for (const load of this.loads.values()) if (load.ready && !load.layer.destroyed) return true;
    return false;
  }

  /** Some layer has realized its actors. */
  anyRealized(): boolean {
    return [...this.loads.values()].some((load) => load.realized);
  }

  /** Every layer the Scene owns is ready. */
  ownedReady(sceneGuid: string): boolean {
    for (const load of this.loads.values()) {
      if (load.layer.ownerSceneGuid === sceneGuid && !load.ready) return false;
    }
    return true;
  }

  /** Play boot loading finished: layers presented meanwhile become ready. */
  readyPresented(): void {
    for (const load of [...this.loads.values()]) {
      if (load.presented && !load.ready) this.notifyReady(load.layer.guid, load.loadId);
    }
  }

  async createAsync(assetGuid: string, zOrder: number, owner: BObject | null): Promise<SceneLayer | null> {
    if (this.host.stopped() || owner?.destroyed) throw sceneRealizationCancelled();
    const preloads = this.host.assetPreloads();
    const preload = this.host.demandAssets()
      ? await preloads.acquire([assetGuid], owner?.guid ?? this.host.world().currentScene?.guid ?? "session") : null;
    let layer: SceneLayer | null = null;
    try {
      { const pending = this.host.continueSimulation(owner); if (pending) await pending; }
      if (preload && !preload.success) throw new Error(`Cannot create SceneLayer ${assetGuid}: ${preload.errorMessage}`);
      if (this.host.stopped() || owner?.destroyed) throw sceneRealizationCancelled();
      layer = this.create(assetGuid, zOrder);
      if (!layer || layer.destroyed) throw new Error(`SceneLayer ${assetGuid} could not be prepared`);
      if (preload) preloads.transferOwner(preload.preloadId, layer.guid);
      if (!this.loads.get(layer.guid)?.ready) {
        const layerId = layer.guid;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            this.readinessWaiters.delete(layerId);
            reject(new Error(`SceneLayer ${assetGuid} did not become ready before the loading deadline`));
          }, 30_000);
          this.readinessWaiters.set(layerId, {
            resolve: () => { clearTimeout(timer); resolve(); },
            reject: error => { clearTimeout(timer); reject(error); },
          });
        });
      }
      { const pending = this.host.continueSimulation(owner); if (pending) await pending; }
      return layer;
    } catch (error) {
      if (layer) this.remove(layer.guid);
      if (preload) preloads.release(preload.preloadId);
      throw error;
    }
  }

  create(
    assetGuid: string,
    zOrder = 0,
    ownerSceneGuid: string | null = null,
  ): SceneLayer | null {
    if (this.host.stopped()) return null;
    const cooperative = this.host.cooperativeLoading();
    if (!cooperative) {
      const steps = this.steps(assetGuid, zOrder, ownerSceneGuid);
      let next = steps.next();
      while (!next.done) next = steps.next();
      return next.value;
    }
    const controller = new AbortController();
    const created: SceneLayer[] = [];
    let paint!: () => void;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const painted = this.host.deferLoadingPaint() ? new Promise<void>((resolve, reject) => {
      paint = resolve;
      timer = setTimeout(() => reject(new Error("SceneLayer Loading did not paint before the loading deadline.")), 30_000);
    }) : Promise.resolve();
    const fail = (error: unknown) => {
      const layer = created[0];
      const work = layer && this.independentWork.get(layer.guid);
      if (!layer || !work || work.controller !== controller || controller.signal.aborted || this.host.stopped()) return;
      this.host.emit({ type: "sceneLayerLoadFailed", layerId: layer.guid, layerLoadId: work.loadId,
        message: error instanceof Error ? error.message : String(error) });
      this.host.reportError(error);
    };
    const steps = this.steps(assetGuid, zOrder, ownerSceneGuid, undefined, {
      signal: controller.signal,
      created: (layer, loadId) => {
        created.push(layer);
        // The in-process host can acknowledge inside sceneLayerLoading emission.
        this.independentWork.set(layer.guid, { layer, loadId, controller, painted: () => paint?.() });
      },
      failed: fail,
    });
    try {
      const first = steps.next();
      const layer = created[0];
      if (first.done === true || !layer) {
        clearTimeout(timer);
        return first.done === true ? first.value : null;
      }
      void (async () => {
        try {
          await waitForSceneWork(painted, controller.signal);
          clearTimeout(timer);
          const remaining = function* () { yield* steps; };
          await runSceneRealizationWork(remaining(), controller.signal, cooperative);
        } catch (error) { fail(error); }
        finally {
          clearTimeout(timer);
          try { steps.return(null); }
          finally { if (this.independentWork.get(layer.guid)?.controller === controller) this.independentWork.delete(layer.guid); }
        }
      })().catch((error: unknown) => { if (!this.host.stopped()) this.host.reportError(error); });
      return layer;
    } catch (error) {
      clearTimeout(timer);
      steps.return(null);
      throw error;
    }
  }

  /** A main Scene realization's owned layer, created within its bounded steps. */
  createSteps(
    assetGuid: string,
    zOrder: number,
    ownerSceneGuid: string | null,
    work: SceneLayerRealization,
  ): Generator<void, SceneLayer | null, unknown> {
    return this.steps(assetGuid, zOrder, ownerSceneGuid, work);
  }

  notifyLoadingPainted(layerId: string, layerLoadId: number): void {
    const work = this.independentWork.get(layerId);
    if (this.host.stopped() || !work || work.loadId !== layerLoadId || work.controller.signal.aborted || this.host.world().findSceneLayer(layerId) !== work.layer) return;
    work.painted();
  }

  notifyReady(layerId: string, layerLoadId: number): void {
    const load = this.loads.get(layerId);
    if (this.host.stopped() || !load || load.loadId !== layerLoadId || !load.realized || load.ready ||
      this.host.world().findSceneLayer(layerId) !== load.layer) return;
    load.presented = true;
    if (this.host.bootLoading()) return;
    load.ready = true;
    this.readinessWaiters.get(layerId)?.resolve();
    this.readinessWaiters.delete(layerId);
    this.host.syncOverlayPhysics();
    this.admission.flush();
    this.host.tryCompleteSceneLoad();
  }

  remove(layerGuid: string): void {
    this.readinessWaiters.get(layerGuid)?.reject(sceneRealizationCancelled());
    this.readinessWaiters.delete(layerGuid);
    this.host.assetPreloads().releaseOwner(layerGuid);
    const world = this.host.world();
    const layer = world.findSceneLayer(layerGuid);
    if (!layer) return;
    this.loads.delete(layerGuid);
    this.host.removeLayerPhysics(layerGuid);
    this.overlay.forget(layerGuid);
    const work = this.independentWork.get(layerGuid);
    if (work?.layer === layer) {
      this.independentWork.delete(layerGuid);
      work.controller.abort(sceneRealizationCancelled());
    }
    for (const actor of [...world.getActors()]) {
      if (actor.sceneLayerId !== layer.guid) continue;
      if (world.findSceneLayer(layer.guid) !== layer) return;
      this.host.removeActor(actor);
    }
    if (world.findSceneLayer(layer.guid) !== layer) return;
    this.host.emit({ type: "sceneLayerRemove", layerId: layer.guid });
    if (world.findSceneLayer(layer.guid) === layer) world.destroySceneLayer(layer.guid);
    this.host.cancelInvalidTweens();
  }

  clearAll(): void {
    for (const layer of [...this.host.world().getSceneLayers()]) {
      this.remove(layer.guid);
    }
    this.host.emit({ type: "sceneLayerClear" });
  }

  registerPostProcess(layerGuid: string, materialGuid: string): void {
    const layer = this.host.world().findSceneLayer(layerGuid);
    const guid = String(materialGuid ?? "").trim();
    if (!layer || !guid) return;
    layer.postProcessStack.push({ id: newGuid(), materialGuid: guid, enabled: true });
    this.emitPostProcess(layer);
  }

  unregisterPostProcess(layerGuid: string, materialGuid: string): void {
    const layer = this.host.world().findSceneLayer(layerGuid);
    const guid = String(materialGuid ?? "").trim();
    if (!layer || !guid) return;
    const index = layer.postProcessStack.findIndex(
      (entry) => entry.materialGuid === guid,
    );
    if (index < 0) {
      this.host.emit({
        type: "log",
        severity: "error",
        category: "scene-layer",
        message: `SceneLayer post-process ${guid} is not registered on layer ${layer.guid}`,
        frameId: this.host.frameId(),
      });
      return;
    }
    layer.postProcessStack.splice(index, 1);
    this.emitPostProcess(layer);
  }

  private emitPostProcess(layer: SceneLayer): void {
    this.host.emit({
      type: "sceneLayerPostProcess",
      layerId: layer.guid,
      postProcessStack: layer.postProcessStack.map((entry) => ({ ...entry })),
    });
  }

  private *steps(
    assetGuid: string,
    zOrder = 0,
    ownerSceneGuid: string | null = null,
    work?: SceneLayerRealization,
    independent?: { signal: AbortSignal; created: (layer: SceneLayer, loadId: number) => void; failed: (error: unknown) => void },
  ): Generator<void, SceneLayer | null, unknown> {
    const world = this.host.world();
    let ownedLayer: SceneLayer | null = null;
    const checkpoint = () => {
      work?.check();
      independent?.signal.throwIfAborted();
      if (ownedLayer && world.findSceneLayer(ownedLayer.guid) !== ownedLayer) throw sceneRealizationCancelled();
    };
    checkpoint();
    const guid = String(assetGuid ?? "").trim();
    const raw = this.host.document(guid);
    if (!raw) {
      this.host.emit({
        type: "log",
        severity: "warning",
        category: "scene-layer",
        message: `createSceneLayer: no SceneLayer asset loaded for ${guid}`,
        frameId: this.host.frameId(),
      });
      return null;
    }
    const document = normalizeSceneLayer({ ...raw, actors: [], folders: [] });
    const layer = world.createSceneLayer({
      assetGuid: guid,
      zOrder: Math.trunc(Number(zOrder) || 0),
      ownerSceneGuid,
      postProcessStack: document.settings.postProcessStack.map((entry) => ({
        ...entry,
      })),
      layerBounds: document.settings.layerBounds,
    });
    this.host.markUnsupportedInstance(layer.guid);
    this.host.addLayerPhysics(layer.guid, guid, document.settings, Array.isArray(raw.actors) ? raw.actors : []);
    ownedLayer = layer;
    work?.layers.push(layer);
    const layerLoad: SceneLayerLoad = { layer, loadId: ++this.loadId, realized: false, presented: false, ready: false };
    this.loads.set(layer.guid, layerLoad);
    const actors: Actor[] = [];
    let completed = false;
    try {
      independent?.created(layer, layerLoad.loadId);
      this.host.emit({ type: "sceneLayerLoading", layerId: layer.guid, assetGuid: guid, layerLoadId: layerLoad.loadId });
      checkpoint();
      this.host.emit({
        type: "sceneLayerCreate",
        layerId: layer.guid,
        assetGuid: guid,
        zOrder: layer.zOrder,
        ownerSceneGuid: layer.ownerSceneGuid,
        postProcessStack: layer.postProcessStack.map((entry) => ({ ...entry })),
        layerBounds: { ...layer.layerBounds },
      });
      checkpoint();
      // Return the live loading identity before actor remapping or realization.
      yield;
      checkpoint();
      const serializedActors = normalizeSceneLayer(raw).actors;
      yield;
      checkpoint();
      const remapped = yield* remapLayerActors(serializedActors, layer.guid);
      for (const serialized of remapped) {
        checkpoint();
        const actor = this.host.createActor(serialized, layer.guid);
        if (actor) {
          actors.push(actor);
          work?.actors.push(actor);
        }
        yield;
      }
      hydrateScenePropertyReferences(actors);
      yield* this.overlay.realizeActors(actors, checkpoint);
      layerLoad.realized = true;
      this.host.publishSnapshot();
      this.host.emit({ type: "sceneLayerRealized", layerId: layer.guid, layerLoadId: layerLoad.loadId });
      if (!this.host.deferModelsReady()) this.notifyReady(layer.guid, layerLoad.loadId);
      completed = true;
      return layer;
    } catch (error) {
      independent?.failed(error);
      throw error;
    } finally {
      if (!completed) {
        // Creation and spawn are separate passes. An aborted creation pass can
        // own Actors which never entered the World or received a render slot.
        for (const actor of actors) if (!actor.destroyed && !actor.world) this.host.removeActor(actor);
        if (world.findSceneLayer(layer.guid) === layer) this.remove(layer.guid);
      }
    }
  }
}

/** Component ids stay authored; only actor identities are scoped to the layer instance. */
const authoredComponentIds = { get: (id: string) => id };

/**
 * Every layer actor id is scoped to its layer instance (`<layer guid>:<id>`),
 * as streamed Scene ids are scoped to their stream, so no live actor (another
 * instance of the same layer, the main Scene a global layer outlives, or a
 * Save Game actor) can share its guid. Parent, focus and actor references follow.
 */
function* remapLayerActors(
  actors: readonly SerializedActor[],
  layerId: string,
): Generator<void, SerializedActor[], unknown> {
  const idMap = new Map(actors.map((actor) => [actor.id, `${layerId}:${actor.id}`]));
  const remapped: SerializedActor[] = [];
  for (const actor of actors) {
    remapped.push({
      ...actor,
      id: idMap.get(actor.id)!,
      parentId: actor.parentId
        ? (idMap.get(actor.parentId) ?? actor.parentId)
        : null,
      ...(actor.properties ? { properties: remapSceneStreamingReferences(actor.properties, idMap, authoredComponentIds) as Record<string, unknown> } : {}),
      components: actor.components.map((component) => ({
        ...component,
        properties: Object.fromEntries(Object.entries(remapSceneStreamingReferences(component.properties, idMap, authoredComponentIds) as Record<string, unknown>)
          .map(([key, value]) => [
            key,
            ["focusUp", "focusDown", "focusLeft", "focusRight"].includes(key) && typeof value === "string"
              ? idMap.get(value) ?? value : value,
          ])),
      })),
    });
    yield;
  }
  return remapped;
}

interface SceneLayerHostDeps {
  layers: SceneLayers;
}

/** Script Scene Layer calls: create (immediate or latent), remove, clear and the layer post-process stack. */
export function createSceneLayerHostBindings(deps: SceneLayerHostDeps): Pick<ScriptHostServices,
  "createSceneLayer" | "createSceneLayerAsync" | "removeSceneLayer" | "clearSceneLayers" |
  "registerSceneLayerPostProcess" | "unregisterSceneLayerPostProcess"> {
  const { layers } = deps;
  return {
    createSceneLayer: (assetGuid, zOrder) => layers.create(assetGuid, zOrder),
    createSceneLayerAsync: (assetGuid, zOrder, owner) => layers.createAsync(assetGuid, zOrder, owner),
    removeSceneLayer: (layerGuid) => { layers.remove(layerGuid); },
    clearSceneLayers: () => { layers.clearAll(); },
    registerSceneLayerPostProcess: (layerGuid, materialGuid) => { layers.registerPostProcess(layerGuid, materialGuid); },
    unregisterSceneLayerPostProcess: (layerGuid, materialGuid) => { layers.unregisterPostProcess(layerGuid, materialGuid); },
  };
}
