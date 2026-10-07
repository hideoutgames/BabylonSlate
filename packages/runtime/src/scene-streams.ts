import type { CommandMessage } from "@babylonslate/bridge";
import {
  cloneSceneStreamingActorsSteps,
  type SceneStreamingState,
  type SerializedActor,
  type SerializedScene,
  type Transform,
} from "@babylonslate/core";
import {
  Actor,
  ActorComponent,
  Scene,
  SceneStreamingActor,
  hydrateScenePropertyReferences,
  sceneAssetClassId,
  type BObject,
  type LifecycleHooks,
  type World,
} from "@babylonslate/object-model";
import type { PhysicsWorldKind } from "@babylonslate/physics";
import { composeParentChildTransform } from "./actor-world-transform";
import type { OwnerAdmission } from "./owner-admission";
import type { RuntimeNavigation } from "./runtime-navigation";
import type { RuntimeSubsystem } from "./runtime-subsystems";
import { runSceneRealizationWork, sceneRealizationCancelled, waitForSceneWork, type CooperativeSceneLoadingOptions } from "./scene-realization-work";
import type { AcquireRuntimeScene, RuntimeSceneSource } from "./scene-source";
import type { ScriptHost, ScriptHostServices } from "./script-host";

interface SceneStream {
  actor: Actor;
  loadId: number;
  assetGuid: string;
  state: Exclude<SceneStreamingState, "Unloaded">;
  progress: number;
  actors: Set<Actor>;
  idMap: ReadonlyMap<string, string>;
  scene: Scene;
  controller: AbortController;
  realized: boolean;
  notified: boolean;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
  unloadPromise?: Promise<void>;
  navObstacles: string[];
  origin?: Transform;
  source?: RuntimeSceneSource;
}

/** The streamed Scene instance an actor belongs to: its streaming actor and load id. */
export type SceneStreamInstance = Readonly<Pick<SceneStream, "actor" | "loadId">>;

interface SceneStreamsHost {
  world(): World;
  stopped(): boolean;
  physicsWorldKind(): PhysicsWorldKind;
  /** The Scene document a streaming component's `sceneGuid` key names, when loaded. */
  sceneDocument(key: string): SerializedScene | undefined;
  /** The Scene asset guid a `sceneGuid` key resolves to. */
  sceneGuid(key: string): string;
  acquireScene(): AcquireRuntimeScene | undefined;
  cooperativeLoading(): CooperativeSceneLoadingOptions;
  /** The host acknowledges model readiness itself (`notifyReady`). */
  deferModelsReady(): boolean;
  scripts(): Pick<ScriptHost, "hooksFor" | "bindInterfaceHandlers">;
  createActor(serialized: SerializedActor): Actor | null;
  realizeActor(actor: Actor, checkpoint: () => void): void;
  /** Break parent cycles in a loaded batch; `detach` reparents a broken child. */
  breakParentCycles(actors: Iterable<Actor>, detach: (child: Actor) => void): void;
  publishSnapshot(): void;
  slot(actor: Actor): number | undefined;
  syncPhysics(): void;
  navigation(): Pick<RuntimeNavigation, "registerAgents" | "registerObstacles" | "removeObstacle" | "removeActor">;
  /** Remove an actor instance the way the driver removes any owned actor. */
  removeActor(actor: Actor): void;
  cancelInvalidTweens(): void;
  releaseAssets(ownerGuid: string): void;
  /** Simulation Keep cannot retain this independent streamed Scene instance. */
  markUnsupportedInstance(sceneGuid: string): void;
  /** A blocking load or unload has settled (the count is already decremented). */
  blockSettled(): void;
  emit(command: CommandMessage): void;
}

/**
 * Scene streaming: the table of streamed Scene instances keyed by their
 * SceneStreamingActor, load and unload (blocking or not), cooperative
 * realization, host readiness, retirement and the stream-ownership queries
 * the driver gates ticks and scripts on.
 */
export class SceneStreams implements RuntimeSubsystem {
  private blockingCount = 0;
  private loadId = 0;
  private readonly streams = new Map<string, SceneStream>();
  private readonly actorStream = new WeakMap<Actor, SceneStream>();
  private readonly streamScenes = new WeakMap<Scene, SceneStream>();
  /** Streams announced as Streamed Scene Loaded; only these report Unloaded. */
  private readonly announced = new WeakSet<SceneStream>();
  private readonly admission: OwnerAdmission;
  private readonly host: SceneStreamsHost;

  constructor(admission: OwnerAdmission, host: SceneStreamsHost) {
    this.admission = admission;
    this.host = host;
  }

  /** Stop, phase 1: every stream is retired. */
  cancelPending(): void {
    this.retireAll();
  }

  /** Removing a streaming actor retires the stream it owns, with its actors. */
  retireActor(actor: Actor): void {
    const stream = this.streams.get(actor.guid);
    if (stream) this.retire(stream);
  }

  /** A blocking load or unload is in progress; the simulation waits. */
  get blocking(): boolean {
    return this.blockingCount > 0;
  }

  isStreamActor(actor: Actor): boolean {
    return this.actorStream.has(actor);
  }

  /** The streamed Scene instance this actor belongs to. */
  actorInstance(actor: Actor): SceneStreamInstance | undefined {
    return this.actorStream.get(actor);
  }

  /** The actor is not streamed, or every stream containing it is Loaded. */
  actorReady(actor: Actor): boolean {
    return this.ready(this.actorStream.get(actor));
  }

  /** As `actorReady`, for the stream owning a Scene, actor or component. */
  ownerReady(owner?: BObject | null): boolean {
    return this.ready(this.streamFor(owner));
  }

  /** The Scene is a streamed instance and it is ready. */
  sceneReady(scene: Scene): boolean {
    const stream = this.streamFor(scene);
    return stream !== undefined && this.ready(stream);
  }

  /** The streamed Scene a Scene, actor or component belongs to. */
  sceneFor(owner?: BObject | null): Scene | undefined {
    return this.streamFor(owner)?.scene;
  }

  resolveInstanceId(owner: BObject | null | undefined, id: string): string {
    return this.streamFor(owner)?.idMap.get(id) ?? id;
  }

  /** Scenes of all live streams, in load order. */
  scenes(): Scene[] {
    return [...this.streams.values()].map((stream) => stream.scene);
  }

  /** A script spawn on behalf of `owner` is refused while its stream is not ready. */
  canSpawnFor(owner?: BObject | null): boolean {
    const stream = this.streamFor(owner);
    return !(stream && (owner?.destroyed || !this.ready(stream)));
  }

  /** A script-spawned actor joins the stream of the owner that spawned it. */
  adoptSpawned(owner: BObject | null | undefined, actor: Actor): void {
    const stream = this.streamFor(owner);
    if (!stream) return;
    stream.actors.add(actor);
    this.actorStream.set(actor, stream);
    actor.setVariable("parentId", stream.actor.guid);
    if (stream.origin) actor.transform = composeParentChildTransform(stream.origin, actor.transform);
  }

  /** Each ready streamed Scene's Tick, while the main Scene may still tick. */
  tickScenes(dt: number, canTick: () => boolean): void {
    for (const stream of this.streams.values()) {
      if (!canTick()) break;
      if (this.ready(stream)) {
        const world = this.host.world();
        this.host.scripts().hooksFor(stream.scene.classId)?.onTick?.(stream.scene, { dt, tickIndex: world.clock.tickIndex, world });
      }
    }
  }

  targetSceneName(target: unknown): string {
    const actor = this.streamingActor(target);
    const component = actor && this.streamingComponent(actor);
    if (!component) return "";
    const guid = String(component.getVariable("sceneGuid") ?? "");
    return this.host.sceneDocument(guid)?.name ?? String(component.getVariable("sceneName") ?? "");
  }

  state(target: unknown): SceneStreamingState {
    const actor = this.streamingActor(target);
    return actor ? this.streams.get(actor.guid)?.state ?? "Unloaded" : "Unloaded";
  }

  progress(target: unknown): number {
    const actor = this.streamingActor(target);
    return actor ? this.streams.get(actor.guid)?.progress ?? 0 : 0;
  }

  load(target: unknown, blocking = false): Promise<void> {
    const actor = this.streamingActor(target);
    if (this.host.stopped() || !actor) return Promise.reject(new Error("Scene streaming requires a live SceneStreamingActor Target."));
    const existing = this.streams.get(actor.guid);
    if (existing) {
      if (existing.state === "Unloading") return Promise.reject(new Error("The target scene is unloading."));
      if (existing.state === "Loaded") return Promise.resolve();
      return this.withBlock(existing.promise, blocking);
    }
    const component = this.streamingComponent(actor);
    const key = String(component?.getVariable("sceneGuid") ?? "");
    const document = this.host.sceneDocument(key);
    if (!document && (!key || !this.host.acquireScene())) return Promise.reject(new Error(`The target scene is not available: ${key || "No Scene Selected"}.`));
    if (document && document.settings.physicsWorld !== this.host.physicsWorldKind())
      return Promise.reject(new Error("Streamed scenes must use the parent scene's Physics World."));
    const guid = this.host.sceneGuid(key);
    for (let ancestor = this.actorStream.get(actor); ancestor; ancestor = this.actorStream.get(ancestor.actor)) {
      if (ancestor.state === "Unloading" || this.streams.get(ancestor.actor.guid) !== ancestor)
        return Promise.reject(new Error("The containing scene is unloading."));
      if (ancestor.assetGuid === guid) return Promise.reject(new Error("Recursive scene streaming is not supported."));
    }
    const loadId = ++this.loadId;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    // Cancellation may happen before a graph attaches its awaited continuation.
    void promise.catch(() => {});
    const scene = new Scene({ guid: `stream:${actor.guid}:${loadId}`, assetGuid: guid, sceneName: document?.name ?? String(component?.getVariable("sceneName") ?? guid),
      hooks: this.sceneHooks(sceneAssetClassId(guid)) });
    const stream: SceneStream = { actor, loadId, assetGuid: guid, state: "Loading", progress: 0,
      actors: new Set(), idMap: new Map(), scene, controller: new AbortController(), realized: false, notified: false,
      promise, resolve, reject, navObstacles: [] };
    this.streams.set(actor.guid, stream);
    this.host.markUnsupportedInstance(scene.guid);
    this.streamScenes.set(scene, stream);
    const operation = this.withBlock(promise, blocking);
    this.host.emit({ type: "sceneStreamLoading", actorGuid: actor.guid, streamLoadId: loadId });
    void Promise.resolve().then(async () => {
      let prepared = document;
      const acquireScene = this.host.acquireScene();
      if (acquireScene) {
        const acquisition = acquireScene(guid, { consumer: `SceneStreamingActor ${actor.guid} (${loadId})`, signal: stream.controller.signal,
          stream: { actorGuid: actor.guid, streamLoadId: loadId } }).then((source) => {
          if (stream.controller.signal.aborted || this.streams.get(actor.guid) !== stream) {
            source.release();
            throw sceneRealizationCancelled();
          }
          stream.source = source;
          return source.scene;
        });
        prepared = await waitForSceneWork(acquisition, stream.controller.signal);
      }
      stream.controller.signal.throwIfAborted();
      if (!prepared) throw new Error(`The target scene is not available: ${guid}.`);
      if (prepared.settings.physicsWorld !== this.host.physicsWorldKind())
        throw new Error("Streamed scenes must use the parent scene's Physics World.");
      stream.scene.setVariable("sceneName", prepared.name);
      await runSceneRealizationWork(this.realize(stream, prepared, component!), stream.controller.signal,
        this.host.cooperativeLoading());
    }).catch((error: unknown) => {
      if (this.streams.get(actor.guid) !== stream || stream.state === "Unloading") return;
      this.retire(stream, error);
    });
    return operation;
  }

  notifyProgress(actorGuid: string, streamLoadId: number, progress: number): void {
    const stream = this.streams.get(actorGuid);
    if (!stream || stream.loadId !== streamLoadId || stream.state !== "Loading" || !Number.isFinite(progress)) return;
    stream.progress = Math.max(stream.progress, 0.5 + Math.min(0.999, Math.max(0, progress)) * 0.5);
  }

  notifyReady(actorGuid: string, streamLoadId: number): void {
    const stream = this.streams.get(actorGuid);
    if (this.host.stopped() || !stream || stream.loadId !== streamLoadId || stream.state !== "Loading" || !stream.notified || !this.actorReady(stream.actor)) return;
    try {
      stream.state = "Loaded";
      this.host.syncPhysics();
      this.host.navigation().registerAgents();
      this.host.navigation().registerObstacles([...stream.actors], stream.navObstacles);
      stream.progress = 1;
      stream.resolve();
      for (const pending of [...this.streams.values()]) this.publishRealized(pending);
      this.admission.flush();
      // After the streamed actors' Begin Play, as Scene Loaded follows the main
      // scene's: the stream's Scene is admitted with its actors (not while paused).
      this.admission.run(stream.scene, () => {
        if (this.streams.get(actorGuid) !== stream || stream.state !== "Loaded" ||
          !(stream.actor instanceof SceneStreamingActor)) return;
        this.announced.add(stream);
        this.host.world().notifyStreamedSceneLoaded(stream.actor, stream.scene);
      });
    } catch (error) {
      this.retire(stream, error);
    }
  }

  notifyFailed(actorGuid: string, streamLoadId: number, message: string): void {
    const stream = this.streams.get(actorGuid);
    if (stream?.loadId === streamLoadId) this.retire(stream, new Error(message));
  }

  unload(target: unknown, blocking = false): Promise<void> {
    const actor = this.streamingActor(target);
    if (!actor) return Promise.reject(new Error("Scene streaming requires a live SceneStreamingActor Target."));
    const stream = this.streams.get(actor.guid);
    if (!stream) return Promise.resolve();
    if (stream.unloadPromise) return this.withBlock(stream.unloadPromise, blocking);
    stream.state = "Unloading";
    stream.progress = 0;
    stream.controller.abort(sceneRealizationCancelled());
    const controller = new AbortController();
    const operation = Promise.resolve().then(async () => {
      await runSceneRealizationWork(this.removeActors(stream), controller.signal, this.host.cooperativeLoading());
      this.retire(stream);
      if (!this.host.stopped()) this.host.publishSnapshot();
    });
    stream.unloadPromise = operation;
    return this.withBlock(operation, blocking);
  }

  /** Retire every stream (Stop, or the main Scene's replacement). */
  retireAll(): void {
    for (const stream of [...this.streams.values()]) this.retire(stream);
  }

  /** Retire streams whose streaming actor has left the World. */
  retireDetached(): void {
    for (const stream of this.streams.values()) {
      if (!this.detached(stream)) continue;
      // Retirement can reenter and change the table; retire from a stable copy.
      for (const candidate of [...this.streams.values()]) {
        if (this.detached(candidate)) this.retire(candidate);
      }
      break;
    }
  }

  /** Lifecycle hooks of a streamed Scene of this class, when it has a script. */
  private sceneHooks(classId: string): LifecycleHooks | undefined {
    const hooks = this.host.scripts().hooksFor(classId);
    return hooks ? {
      onCreation: (self) => this.admission.runCreation(self, () => hooks.onCreation?.(self)),
      onTick: (self, context) => this.admission.guard(() => hooks.onTick?.(self, context)),
      onDestroyed: (self) => this.admission.runDestroyed(self, () => hooks.onDestroyed?.(self)),
    } : undefined;
  }

  private streamFor(owner?: BObject | null): SceneStream | undefined {
    if (owner instanceof Scene) return this.streamScenes.get(owner);
    const actor = owner instanceof Actor ? owner : owner instanceof ActorComponent ? owner.owner : null;
    return actor ? this.actorStream.get(actor) : undefined;
  }

  private ready(stream: SceneStream | undefined): boolean {
    for (let owner = stream; owner; owner = this.actorStream.get(owner.actor)) {
      if (owner.state !== "Loaded" || this.streams.get(owner.actor.guid) !== owner) return false;
    }
    return true;
  }

  private detached(stream: SceneStream): boolean {
    return stream.actor.destroyed || stream.actor.world !== this.host.world();
  }

  private streamingActor(target: unknown): Actor | null {
    const world = this.host.world();
    return target instanceof Actor && !target.destroyed && target.world === world &&
      world.classRegistry.isA(target.classId, "SceneStreamingActor") ? target : null;
  }

  private streamingComponent(actor: Actor): ActorComponent | undefined {
    return actor.components.find((component) => !component.destroyed && component.classId === "SceneStreamingComponent");
  }

  private withBlock(operation: Promise<void>, blocking: boolean): Promise<void> {
    if (!blocking) return operation;
    this.blockingCount++;
    if (this.blockingCount === 1) this.host.emit({ type: "sceneStreamBlocking", blocking: true });
    return operation.finally(() => {
      this.blockingCount--;
      if (this.blockingCount === 0 && !this.host.stopped()) this.host.emit({ type: "sceneStreamBlocking", blocking: false });
      this.host.blockSettled();
    });
  }

  private *realize(stream: SceneStream, document: SerializedScene, component: ActorComponent): Generator<void, void, unknown> {
    const world = this.host.world();
    const checkpoint = () => {
      stream.controller.signal.throwIfAborted();
      if (this.host.stopped() || stream.actor.destroyed || stream.actor.world !== world) throw sceneRealizationCancelled();
    };
    checkpoint();
    const cloned = yield* cloneSceneStreamingActorsSteps(document.actors, { instanceId: stream.scene.guid, parentActorId: stream.actor.guid });
    stream.idMap = cloned.idMap;
    let origin = component.transform;
    let parentId = component.parentId;
    const visited = new Set([component.guid]);
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = stream.actor.components.find((entry) => entry.guid === parentId);
      if (!parent) break;
      origin = composeParentChildTransform(parent.transform, origin);
      parentId = parent.parentId;
    }
    stream.origin = origin;
    for (const serialized of cloned.actors) {
      checkpoint();
      const actor = this.host.createActor(serialized);
      if (actor) {
        if (serialized.parentId === stream.actor.guid) actor.transform = composeParentChildTransform(origin, actor.transform);
        stream.actors.add(actor);
        this.actorStream.set(actor, stream);
      }
      yield;
    }
    hydrateScenePropertyReferences([...stream.actors]);
    let realized = 0;
    for (const actor of stream.actors) {
      checkpoint();
      this.host.scripts().bindInterfaceHandlers(actor);
      this.host.realizeActor(actor, checkpoint);
      stream.progress = ++realized / Math.max(1, stream.actors.size) * 0.5;
      yield;
    }
    checkpoint();
    // A streamed actor without a scene parent is a root of its instance.
    this.host.breakParentCycles(stream.actors, (actor) => {
      actor.setVariable("parentId", stream.actor.guid);
      actor.transform = composeParentChildTransform(origin, actor.transform);
    });
    this.host.scripts().bindInterfaceHandlers(stream.scene);
    stream.scene.callOnCreation();
    world.flushPending();
    stream.realized = true;
    stream.progress = 0.5;
    this.publishRealized(stream);
  }

  private publishRealized(stream: SceneStream): void {
    if (!stream.realized || stream.notified || stream.state !== "Loading" || !this.actorReady(stream.actor)) return;
    stream.notified = true;
    this.host.publishSnapshot();
    if (this.streams.get(stream.actor.guid) !== stream) return;
    this.host.emit({ type: "sceneStreamRealized", actorGuid: stream.actor.guid, streamLoadId: stream.loadId,
      slotIds: [...stream.actors].flatMap((actor) => { const slot = this.host.slot(actor); return slot === undefined ? [] : [slot]; }) });
    if (!this.host.deferModelsReady()) this.notifyReady(stream.actor.guid, stream.loadId);
  }

  private *removeActors(stream: SceneStream): Generator<void, void, unknown> {
    for (const child of stream.actors) {
      if (this.streams.get(stream.actor.guid) !== stream) return;
      const nested = this.streams.get(child.guid);
      if (nested) {
        nested.state = "Unloading";
        nested.progress = 0;
        nested.controller.abort(sceneRealizationCancelled());
        yield* this.removeActors(nested);
        this.retire(nested);
      }
      // Another unload or Stop can drain this same subtree while we yield.
      if (this.streams.get(stream.actor.guid) !== stream) return;
      if (!stream.actors.has(child)) continue;
      this.removeActor(stream, child);
      yield;
    }
  }

  private removeActor(stream: SceneStream, actor: Actor): void {
    this.host.removeActor(actor);
    this.host.navigation().removeActor(actor.guid);
    stream.actors.delete(actor);
    // Destruction hooks belong to this actor's budget, not a final subtree batch.
    // flushPending drains queues; it does not rescan the remaining world itself.
    this.host.world().flushPending();
  }

  private retire(stream: SceneStream, failure?: unknown): void {
    if (this.streams.get(stream.actor.guid) !== stream) return;
    this.host.releaseAssets(stream.scene.guid);
    const wasLoaded = stream.state === "Loaded";
    stream.state = "Unloading";
    stream.progress = 0;
    stream.controller.abort(sceneRealizationCancelled());
    this.streams.delete(stream.actor.guid);
    this.host.emit({ type: "sceneStreamRemoved", actorGuid: stream.actor.guid, streamLoadId: stream.loadId });
    for (const actor of stream.actors) this.removeActor(stream, actor);
    this.host.world().flushPending();
    stream.scene.destroyed = true;
    this.host.cancelInvalidTweens();
    stream.scene.callOnDestroyed();
    this.admission.drop(stream.scene);
    // Paired with Streamed Scene Loaded; a stream that never became ready is silent.
    if (this.announced.delete(stream) && stream.actor instanceof SceneStreamingActor) {
      this.host.world().notifyStreamedSceneUnloaded(stream.actor, stream.scene);
    }
    for (const obstacle of stream.navObstacles) this.host.navigation().removeObstacle(obstacle);
    // A graph may retain a destroyed actor reference. Its WeakMap ownership
    // must not retain the rest of the unloaded instance through this set.
    stream.actors.clear();
    stream.idMap = new Map();
    stream.navObstacles.length = 0;
    this.host.syncPhysics();
    stream.source?.release();
    stream.source = undefined;
    if (failure || !wasLoaded) stream.reject(failure ?? sceneRealizationCancelled());
    else stream.resolve();
  }
}

interface SceneStreamHostDeps {
  streams: SceneStreams;
  world(): World;
}

/** Script Scene reference and streaming calls: load, unload, state, progress and instance ids. */
export function createSceneStreamHostBindings(deps: SceneStreamHostDeps): Pick<ScriptHostServices,
  "getSceneReference" | "getTargetSceneName" | "loadScene" | "unloadScene" | "isSceneLoaded" |
  "getSceneLoadProgress" | "getSceneState" | "resolveInstanceId"> {
  const { streams } = deps;
  return {
    getSceneReference: (owner) => {
      // Subsystems have no stream, so they read the main Scene.
      const scene = streams.sceneFor(owner) ?? deps.world().currentScene;
      return scene && !scene.destroyed ? scene : null;
    },
    getTargetSceneName: (target) => streams.targetSceneName(target),
    loadScene: (target, blocking) => streams.load(target, blocking),
    unloadScene: (target, blocking) => streams.unload(target, blocking),
    isSceneLoaded: (target) => streams.state(target) === "Loaded",
    getSceneLoadProgress: (target) => streams.progress(target),
    getSceneState: (target) => streams.state(target),
    resolveInstanceId: (owner, id) => streams.resolveInstanceId(owner, id),
  };
}
