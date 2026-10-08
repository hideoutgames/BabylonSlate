import type { CommandMessage } from "@babylonslate/bridge";
import { assertUniqueSceneActorIds, type SerializedActor, type SerializedScene } from "@babylonslate/core";
import { initNavigation } from "@babylonslate/navigation";
import { hydrateScenePropertyReferences, type Actor, type Scene, type SceneLayer, type World } from "@babylonslate/object-model";
import { isInfiniteLoopError } from "@babylonslate/debugger";
import type { OwnerAdmission } from "./owner-admission";
import type { RuntimeNavigation } from "./runtime-navigation";
import type { RuntimePhysicsWorlds } from "./runtime-physics-worlds";
import type { RuntimeSubsystem } from "./runtime-subsystems";
import type { SceneLayers } from "./scene-layers";
import { runSceneRealizationWork, sceneRealizationCancelled, waitForSceneWork, type CooperativeSceneLoadingOptions } from "./scene-realization-work";
import type { AcquireRuntimeScene, RuntimeSceneSource } from "./scene-source";
import type { ScriptHost } from "./script-host";

interface SceneDeparture {
  guid: string;
  sceneInstance: Scene | null;
  actors: Actor[];
  layers: SceneLayer[];
  sources?: RuntimeSceneSource[];
}

interface SceneRealization {
  controller: AbortController;
  scene: SerializedScene | undefined;
  guid: string;
  loadId: number;
  actors: Actor[];
  layers: SceneLayer[];
  sceneInstance: Scene | null;
  promise: Promise<void> | null;
  finished: boolean;
  departure: SceneDeparture | null;
  painted: (() => void) | null;
  refreshNavigation: boolean;
}

interface SceneRealizerHost {
  world(): World;
  stopped(): boolean;
  frameId(): number;
  /** The main Scene document and guid the next realization loads. */
  playScene(): SerializedScene | undefined;
  playSceneGuid(): string;
  /** Change Scene commits: adopt the next Scene document, its scalability settings and guid, and drop camera possession. */
  enterScene(scene: SerializedScene, guid: string): void;
  /** The Play scene library's Scene documents, by key. */
  sceneLibrary(): ReadonlyMap<string, SerializedScene>;
  sceneGuid(key: string): string;
  acquireScene(): AcquireRuntimeScene | undefined;
  cooperativeLoading(): CooperativeSceneLoadingOptions | null;
  /** Play boot loading holds a realized Scene until it finishes. */
  bootLoading(): boolean;
  /** The host acknowledges model readiness itself (`notifyModelsReady`). */
  deferModelsReady(): boolean;
  /** The host acknowledges the loading paint itself (`notifyLoadingPainted`). */
  deferLoadingPaint(): boolean;
  physics(): Pick<RuntimePhysicsWorlds, "kind" | "gravity" | "main" | "syncLayers" | "replacesNative" | "acquireNative" | "installScene" | "prepareScene">;
  navigation(): Pick<RuntimeNavigation, "needsInitialization" | "markInitialized" | "prepareScene" | "registerAgents" | "registerObstacles">;
  layers(): Pick<SceneLayers, "createSteps" | "ownedReady">;
  scripts(): Pick<ScriptHost, "bindInterfaceHandlers">;
  /** Restart tile animation time and the infinite-loop guard, then start the World. */
  startWorld(): void;
  setWorldGravity(gravity: { x: number; y: number; z: number }): void;
  /** A Simulation records the first realized Scene as its starting scene. */
  recordSimulationStart(start: { sceneAssetGuid: string; sceneInstanceId: string; sceneLoadId: number }): void;
  /** Simulation Keep cannot retain a scene transition. */
  markSceneTransition(): void;
  createActor(serialized: SerializedActor): Actor | null;
  realizeActor(actor: Actor, checkpoint: () => void): void;
  breakParentCycles(actors: Iterable<Actor>): void;
  /** The authored opt-in camera possession, after every actor has spawned. */
  possessViewTarget(): void;
  publishSnapshot(): void;
  /** Remove an actor instance the way the driver removes any owned actor. */
  removeActor(actor: Actor): void;
  removeSceneLayer(layerGuid: string): void;
  releaseAssets(ownerGuid: string): void;
  /** Run every registered subsystem's `resetForSceneLoad`. */
  resetForSceneLoad(): void;
  /** Run teardown with the main Scene's SceneSubsystem notifications muted. */
  duringSceneTeardown(teardown: () => void): void;
  retireStreams(): void;
  /** A committed scene change refreshes the navigation and behaviour-tree debug views. */
  emitSceneDebug(): void;
  reportError(error: unknown): void;
  emit(command: CommandMessage): void;
}

/**
 * Main Scene realization and Change Scene: the in-flight realization (its
 * abort controller, acquired actors and layers, and the departing Scene's
 * objects and sources), immediate or cooperative steps (loading paint,
 * retirement, native physics and navigation preparation, then actors and
 * owned layers), failure and cancellation cleanup, the readiness latch until
 * the host presents the Scene, prepared Scene source ownership and the load id.
 * Registered last so Stop cancels the realization after every other subsystem.
 */
export class SceneRealizer implements RuntimeSubsystem {
  private activeSceneSource?: RuntimeSceneSource;
  private pendingSceneSource?: AbortController;
  private playWorldRealized = false;
  private sceneLoadingProgress = 1;
  private sceneLoadId = 0;
  private realization: SceneRealization | null = null;
  private sceneWorkBlocked = false;
  private preparedBootScene: { work: SceneRealization; name: string } | null = null;
  private sceneChangeId = 0;
  private pendingSceneFinish: {
    name: string;
    guid: string;
    sceneLoadId: number;
    presented: boolean;
  } | null = null;
  /** The realization Stop cancelled; its departing sources release with the session's. */
  private retiring: SceneRealization | null = null;
  private readonly admission: OwnerAdmission;
  private readonly host: SceneRealizerHost;

  constructor(admission: OwnerAdmission, host: SceneRealizerHost) {
    this.admission = admission;
    this.host = host;
  }

  /** Advances with every realization and on Stop. */
  get loadId(): number { return this.sceneLoadId; }
  /** Main Scene work holds the Scene's owners until the host presents it. */
  get blocked(): boolean { return this.sceneWorkBlocked; }
  get loadingProgress(): number { return this.sceneLoadingProgress; }
  /** The current main Scene began realizing. */
  get realized(): boolean { return this.playWorldRealized; }
  /** A realization is in flight and has not finished its steps. */
  get realizing(): boolean { return this.realization !== null && !this.realization.finished; }
  /** The current realization finished its steps. */
  get realizationFinished(): boolean { return this.realization?.finished === true; }

  /** Stop begins: later scene changes are stale and a pending Scene source acquisition is aborted. */
  cancelSceneChange(): void {
    this.sceneChangeId++;
    this.pendingSceneSource?.abort(sceneRealizationCancelled());
    this.pendingSceneSource = undefined;
  }

  /** Stop, phase 1: cancel the realization and clean up what it acquired. */
  cancelPending(): void {
    this.retiring = this.cancelRealization();
    this.sceneLoadId++;
    this.pendingSceneFinish = null;
  }

  /** Stop, after the World and scripts end: release the cancelled departure's and the active Scene's sources. */
  releaseSceneSources(): void {
    for (const source of this.retiring?.departure?.sources ?? []) source.release();
    this.retiring = null;
    this.activeSceneSource?.release();
    this.activeSceneSource = undefined;
  }

  /** Play boot loading finished: complete the Scene it held. */
  finishBootLoading(): void {
    const prepared = this.preparedBootScene;
    this.preparedBootScene = null;
    if (!prepared || this.realization !== prepared.work) return;
    this.checkRealization(prepared.work);
    // Game Instance may have changed poses or created actors during native boot.
    this.host.publishSnapshot();
    this.checkRealization(prepared.work);
    this.finishOrDeferSceneLoad(prepared.name, prepared.work.guid, prepared.work.loadId);
  }

  private *spawnOwnedSceneLayers(work: SceneRealization): Generator<void, void, unknown> {
    const owned = { check: () => this.checkRealization(work), layers: work.layers, actors: work.actors };
    for (const entry of work.scene?.settings.sceneLayers ?? []) {
      this.checkRealization(work);
      if (entry.enabled) {
        yield* this.host.layers().createSteps(entry.assetGuid, entry.zOrder, work.guid, owned);
      }
      yield;
    }
  }

  private checkRealization(work: SceneRealization): void {
    work.controller.signal.throwIfAborted();
    if (this.host.stopped() || this.realization !== work) throw sceneRealizationCancelled();
  }

  /** Clean up only objects acquired by this preparation, including unspawned actors. */
  private cancelRealization(cleanup = true): SceneRealization | null {
    const work = this.realization;
    if (!work) return null;
    this.realization = null;
    if (this.preparedBootScene?.work === work) this.preparedBootScene = null;
    work.controller.abort(sceneRealizationCancelled());
    if (work.finished || !cleanup) return work;
    const world = this.host.world();
    for (const actor of work.departure?.actors ?? []) this.host.removeActor(actor);
    for (const layer of work.departure?.layers ?? []) {
      if (world.findSceneLayer(layer.guid) === layer) this.host.removeSceneLayer(layer.guid);
    }
    for (const actor of work.actors) this.host.removeActor(actor);
    for (const layer of work.layers) {
      if (world.findSceneLayer(layer.guid) === layer) this.host.removeSceneLayer(layer.guid);
    }
    world.flushPending();
    return work;
  }

  realizePlayWorld(): void | Promise<void> {
    if (this.host.stopped()) {
      if (this.host.cooperativeLoading()) return Promise.reject(sceneRealizationCancelled());
      return;
    }
    if (!this.playWorldRealized) this.beginSceneRealization();
    if (this.host.cooperativeLoading() || this.realization?.promise) return this.waitForSceneRealization();
  }

  /** Follow a replacement begun by Game Instance while the boot caller awaits. */
  private async waitForSceneRealization(): Promise<void> {
    while (true) {
      const work = this.realization;
      if (!work || this.host.stopped()) throw sceneRealizationCancelled();
      try {
        await work.promise;
      } catch (error) {
        if (this.realization === work || this.host.stopped()) throw error;
        continue;
      }
      if (this.realization === work) return;
    }
  }

  private beginSceneRealization(departure: SceneDeparture | null = null): void {
    const changeId = this.sceneChangeId;
    const previous = this.cancelRealization(false);
    if (this.host.stopped() || this.sceneChangeId !== changeId) return;
    if (previous && !previous.finished) {
      departure ??= { guid: previous.guid, sceneInstance: previous.sceneInstance, actors: [], layers: [] };
      departure.actors = [...new Set([...departure.actors, ...previous.actors, ...(previous.departure?.actors ?? [])])];
      departure.layers = [...new Set([...departure.layers, ...previous.layers, ...(previous.departure?.layers ?? [])])];
      departure.sources = [...new Set([...(departure.sources ?? []), ...(previous.departure?.sources ?? [])])];
    }
    this.playWorldRealized = true;
    this.sceneWorkBlocked = true;
    this.pendingSceneFinish = null;
    const work: SceneRealization = {
      controller: new AbortController(), scene: this.host.playScene(), guid: this.host.playSceneGuid(),
      loadId: ++this.sceneLoadId, actors: [], layers: [], sceneInstance: null,
      promise: null, finished: false, departure, painted: null,
      refreshNavigation: departure !== null,
    };
    this.realization = work;
    this.sceneLoadingProgress = 0;
    const steps = this.realizeSceneSteps(work);
    const retirement = this.retireSceneSteps(work);
    const nextKind = work.scene?.settings.physicsWorld ?? this.host.physics().kind;
    const replaceNative = this.host.physics().replacesNative(nextKind);
    const initializeNavigation = this.host.navigation().needsInitialization(work.guid);
    if (this.host.cooperativeLoading() || replaceNative || initializeNavigation) {
      work.promise = Promise.resolve().then(async () => {
        await this.prepareSceneLoading(work);
        await runSceneRealizationWork(retirement, work.controller.signal, this.host.cooperativeLoading() ?? {});
        if (this.host.physics().replacesNative(nextKind)) {
          const gravity = work.scene?.settings.gravity ?? this.host.physics().gravity;
          const acquisition = this.host.physics().acquireNative(nextKind, gravity).then((backend) => {
            try { this.checkRealization(work); } catch (error) { backend.dispose(); throw error; }
            return backend;
          });
          const backend = await waitForSceneWork(acquisition, work.controller.signal);
          this.host.physics().installScene(backend, () => this.checkRealization(work));
        }
        if (initializeNavigation) {
          await waitForSceneWork(initNavigation(), work.controller.signal);
          this.host.navigation().markInitialized();
        }
        this.prepareSceneBackends(work);
        await runSceneRealizationWork(steps, work.controller.signal, this.host.cooperativeLoading() ?? {});
      }).catch((error: unknown) => {
        this.failRealization(work);
        throw error;
      });
      // Scene changes from scripts have no awaiting caller. Keep the failure
      // observable to boot waiters and report it once when it is still current.
      void work.promise.catch((error: unknown) => {
        if (this.realization === work && !work.controller.signal.aborted) {
          this.host.emit({ type: "sceneLoadFailed", sceneAssetGuid: work.guid, sceneLoadId: work.loadId,
            message: error instanceof Error ? error.message : String(error) });
          this.host.reportError(error);
        }
      });
      return;
    }
    try {
      while (!retirement.next().done) { /* Retire before replacing native ownership. */ }
      this.prepareSceneBackends(work);
      while (!steps.next().done) { /* Immediate consumers retain synchronous ordering. */ }
    } catch (error) {
      this.failRealization(work);
      if (!isInfiniteLoopError(error) && !work.controller.signal.aborted) throw error;
    } finally {
      retirement.return();
      steps.return();
    }
  }

  private prepareSceneBackends(work: SceneRealization): void {
    this.checkRealization(work);
    this.host.physics().prepareScene(work.scene?.settings, () => this.checkRealization(work));
    this.host.navigation().prepareScene(work.guid, work.refreshNavigation);
  }

  private async prepareSceneLoading(work: SceneRealization): Promise<void> {
    this.checkRealization(work);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const painted = this.host.deferLoadingPaint() ? new Promise<void>((resolve, reject) => {
      work.painted = resolve;
      timer = setTimeout(() => reject(new Error("Scene Loading did not paint before the loading deadline.")), 30_000);
    }) : Promise.resolve();
    try {
      // Install the latch before emitting: the in-process host can acknowledge immediately.
      this.host.emit({ type: "sceneLoading", sceneAssetGuid: work.guid, sceneLoadId: work.loadId });
      await waitForSceneWork(painted, work.controller.signal);
      this.checkRealization(work);
    } finally {
      clearTimeout(timer);
      work.painted = null;
    }
  }

  notifyLoadingPainted(sceneAssetGuid: string, sceneLoadId: number): void {
    const work = this.realization;
    if (this.host.stopped() || !work || work.controller.signal.aborted || work.guid !== sceneAssetGuid || work.loadId !== sceneLoadId) return;
    work.painted?.();
  }

  private *retireSceneSteps(work: SceneRealization): Generator<void, void, unknown> {
    const departure = work.departure;
    if (!departure) return;
    if (departure.sceneInstance) this.host.releaseAssets(departure.sceneInstance.guid);
    const checkpoint = () => this.checkRealization(work);
    checkpoint();
    const world = this.host.world();
    if (world.currentScene === departure.sceneInstance) world.exitActiveScene();
    checkpoint();
    // Exit hooks can add objects to the departing Scene. Retain exact identities
    // so cancellation and a reentrant same-guid replacement cannot erase each other.
    departure.layers = [...new Set([...departure.layers, ...world.getSceneLayers().filter((layer) => layer.ownerSceneGuid === departure.guid)])];
    const departingLayers = new Set(departure.layers.map((layer) => layer.guid));
    departure.actors = [...new Set([...departure.actors, ...world.getActors().filter((actor) => !actor.sceneLayerId || departingLayers.has(actor.sceneLayerId))])];
    for (const actor of departure.actors) {
      checkpoint();
      this.host.removeActor(actor);
      world.flushPending();
      checkpoint();
      yield;
    }
    for (const layer of departure.layers) {
      checkpoint();
      if (world.findSceneLayer(layer.guid) === layer) this.host.removeSceneLayer(layer.guid);
      checkpoint();
      yield;
    }
    // Prune native bodies before new objects can reuse a departing guid. Global
    // SceneLayers remain in the World, retaining their bodies and motion.
    this.host.physics().main.syncFromWorld(world);
    checkpoint();
    this.host.physics().syncLayers();
    checkpoint();
    // Actor removal releases only departing animation/BT state. Retained layers
    // continue from their existing graph state while the world is replaced.
    this.host.resetForSceneLoad();
    for (const source of departure.sources ?? []) source.release();
    departure.sources = undefined;
    work.departure = null;
  }

  private failRealization(work: SceneRealization): void {
    if (this.realization !== work) return;
    // Keep the failed promise/gate attached: a later ready acknowledgement must
    // never turn a partial scene into a successful load.
    this.pendingSceneFinish = null;
    const world = this.host.world();
    // Objects leave before the Scene exits (its SceneSubsystems' On End), silently.
    this.host.duringSceneTeardown(() => {
      for (const actor of work.departure?.actors ?? []) this.host.removeActor(actor);
      for (const layer of work.departure?.layers ?? []) {
        if (world.findSceneLayer(layer.guid) === layer) this.host.removeSceneLayer(layer.guid);
      }
      for (const actor of work.actors) this.host.removeActor(actor);
      for (const layer of work.layers) {
        if (world.findSceneLayer(layer.guid) === layer) this.host.removeSceneLayer(layer.guid);
      }
      world.flushPending();
    });
    if (world.currentScene === work.sceneInstance) world.exitActiveScene();
    for (const source of work.departure?.sources ?? []) source.release();
    if (work.departure) work.departure.sources = undefined;
    this.activeSceneSource?.release();
    this.activeSceneSource = undefined;
  }

  private *realizeSceneSteps(work: SceneRealization): Generator<void, void, unknown> {
    const checkpoint = () => this.checkRealization(work);
    checkpoint();
    this.host.startWorld();
    checkpoint();
    const world = this.host.world();
    const { scene, guid, loadId } = work;
    const name = typeof scene?.name === "string" && scene.name.trim() ? scene.name : guid;
    if (scene) {
      // Scene actor ids become live guids; a repeated id is rejected before any object exists.
      assertUniqueSceneActorIds(scene.actors, name);
      this.sceneLoadingProgress = 0;
      world.beginSceneLoad(name);
      checkpoint();
      const authoredGravity = scene.settings?.gravity;
      const gravity = {
        x: Number(authoredGravity?.[0] ?? this.host.physics().gravity[0]),
        y: Number(authoredGravity?.[1] ?? this.host.physics().gravity[1]),
        z: Number(authoredGravity?.[2] ?? this.host.physics().gravity[2]),
      };
      this.host.setWorldGravity(gravity);
      work.sceneInstance = world.createScene({ assetGuid: guid, sceneName: name,
        postProcessStack: scene.settings.postProcessStack, variables: { gravity } });
      this.host.recordSimulationStart({ sceneAssetGuid: guid, sceneInstanceId: work.sceneInstance.guid, sceneLoadId: loadId });
      checkpoint();
      this.host.emit({ type: "activeScene", sceneAssetGuid: guid, sceneLoadId: loadId });
      checkpoint();
      for (const serialized of scene.actors) {
        checkpoint();
        const actor = this.host.createActor(serialized);
        if (actor) work.actors.push(actor);
        yield;
      }
      hydrateScenePropertyReferences(work.actors);
      let realized = 0;
      for (const actor of work.actors) {
        checkpoint();
        this.host.scripts().bindInterfaceHandlers(actor);
        this.host.realizeActor(actor, checkpoint);
        checkpoint();
        this.sceneLoadingProgress = (++realized / work.actors.length) * 0.5;
        yield;
      }
      this.host.breakParentCycles(work.actors);
      this.sceneLoadingProgress = 0.5;
    }
    checkpoint();
    this.host.navigation().registerAgents();
    this.host.navigation().registerObstacles();
    this.host.possessViewTarget();
    checkpoint();
    yield* this.spawnOwnedSceneLayers(work);
    checkpoint();
    // All actors, anchors, and renderer assignments precede the readiness latch.
    world.flushPending();
    checkpoint();
    this.host.publishSnapshot();
    checkpoint();
    work.finished = true;
    if (scene) {
      if (this.host.bootLoading()) this.preparedBootScene = { work, name };
      else this.finishOrDeferSceneLoad(name, guid, loadId);
    } else this.sceneWorkBlocked = false;
  }

  /** Change Scene (scripts and console): false when no loaded scene matches, so the console can report it. */
  change(sceneKey: string): boolean {
    if (this.host.acquireScene()) {
      // Prepared transitions resolve asynchronously and report their own failures.
      void this.changeAsync(sceneKey).catch((error: unknown) => {
        if (!this.host.stopped() && (error as { name?: string })?.name !== "AbortError") this.host.reportError(error);
      });
      return true;
    }
    return this.commitSceneChange(sceneKey);
  }

  async changeAsync(sceneKey: string): Promise<void> {
    const key = String(sceneKey ?? "").trim();
    if (this.host.stopped()) throw sceneRealizationCancelled();
    if (!key) throw new Error("Select a Scene before changing scenes.");
    if (!this.host.acquireScene()) {
      if (!this.host.sceneLibrary().has(key)) throw new Error(`The target scene is not available: ${key}.`);
      this.commitSceneChange(key);
      await this.waitForSceneRealization();
      return;
    }
    this.pendingSceneSource?.abort(sceneRealizationCancelled());
    const controller = new AbortController();
    this.pendingSceneSource = controller;
    let acquired: RuntimeSceneSource | undefined;
    const acquisition = Promise.resolve().then(() => this.host.acquireScene()!(this.host.sceneGuid(key), {
      consumer: `Scene transition from ${this.host.playSceneGuid()}`, signal: controller.signal,
    })).then((source) => {
      if (this.host.stopped() || controller.signal.aborted || this.pendingSceneSource !== controller) {
        source.release();
        throw sceneRealizationCancelled();
      }
      acquired = source;
      return source;
    });
    try {
      const source = await waitForSceneWork(acquisition, controller.signal);
      controller.signal.throwIfAborted();
      this.pendingSceneSource = undefined;
      this.commitSceneChange(key, source.scene, source);
      acquired = undefined;
      await this.waitForSceneRealization();
    } finally {
      acquired?.release();
      if (this.pendingSceneSource === controller) this.pendingSceneSource = undefined;
    }
  }

  private commitSceneChange(sceneKey: string, prepared?: SerializedScene, source?: RuntimeSceneSource): boolean {
    const key = String(sceneKey ?? "").trim();
    const next = prepared ?? this.host.sceneLibrary().get(key);
    if (!next) {
      this.host.emit({
        type: "log",
        severity: "warning",
        category: "scene",
        message: `changeScene: no scene asset loaded for ${key}`,
        frameId: this.host.frameId(),
      });
      return false;
    }
    if (this.host.stopped()) { source?.release(); return true; }
    this.host.markSceneTransition();
    // The departing Scene's teardown starts here; its SceneSubsystems End at the exit.
    this.host.duringSceneTeardown(() => {
      this.host.retireStreams();
    });
    const changeId = ++this.sceneChangeId;
    const current = () => !this.host.stopped() && this.sceneChangeId === changeId;
    this.sceneWorkBlocked = true;
    this.pendingSceneFinish = null;
    const world = this.host.world();
    const departingSceneGuid = this.host.playSceneGuid();
    const departure: SceneDeparture = {
      guid: departingSceneGuid, sceneInstance: world.currentScene,
      actors: world.getActors().filter((actor) => !actor.sceneLayerId),
      layers: world.getSceneLayers().filter((layer) => layer.ownerSceneGuid === departingSceneGuid),
      sources: this.activeSceneSource ? [this.activeSceneSource] : undefined,
    };
    this.activeSceneSource = source;
    this.host.enterScene(next, this.host.sceneGuid(key));
    this.playWorldRealized = false;
    // The realization owns its rejection and diagnostics; script commands remain synchronous.
    this.beginSceneRealization(departure);
    if (!current()) return true;
    if (this.admission.canTickScene()) this.host.emitSceneDebug();
    return true;
  }

  private finishOrDeferSceneLoad(
    name: string,
    guid: string,
    sceneLoadId: number,
  ): void {
    // Install the latch first: an in-process host may acknowledge synchronously
    // from sceneRealized, after the full world and owned-layer assignment batch.
    this.pendingSceneFinish = { name, guid, sceneLoadId, presented: !this.host.deferModelsReady() };
    this.host.emit({ type: "sceneRealized", sceneAssetGuid: guid, sceneLoadId });
    if (
      !this.host.deferModelsReady() &&
      this.pendingSceneFinish?.sceneLoadId === sceneLoadId
    )
      this.tryCompleteSceneLoad();
  }

  /** Finish the main Scene's load once the host presented it and its owned layers are ready. */
  tryCompleteSceneLoad(): void {
    const pending = this.pendingSceneFinish;
    if (this.host.stopped() || !pending?.presented || !this.host.layers().ownedReady(pending.guid)) return;
    this.sceneLoadingProgress = 1;
    this.sceneWorkBlocked = false;
    this.pendingSceneFinish = null;
    this.admission.flush();
    // Authored creation may immediately replace this Scene or stop Play.
    const world = this.host.world();
    const owner = world.currentScene;
    if (!this.host.stopped() && owner && this.sceneLoadId === pending.sceneLoadId) this.admission.run(owner, () => {
      if (world.currentScene === owner && this.sceneLoadId === pending.sceneLoadId) world.finishSceneLoad(pending.name);
    });
  }

  notifyModelsReady(sceneAssetGuid: string, sceneLoadId: number): void {
    const pending = this.pendingSceneFinish;
    if (!pending) return;
    if (sceneAssetGuid !== pending.guid || sceneLoadId !== pending.sceneLoadId)
      return;
    pending.presented = true;
    this.tryCompleteSceneLoad();
  }
}
