import type { SessionBoundaryRequest, SessionBoundaryResult, SessionPauseReason } from "@babylonslate/bridge";
import { SaveGameError, SaveGameService, type SaveGameServiceOptions, type SerializedScene } from "@babylonslate/core";
import {
  Actor,
  attachSerializedComponents,
  createActorFromSerialized,
  type BObject,
  type SceneActorHooks,
  type World,
} from "@babylonslate/object-model";
import type { OwnerAdmission } from "./owner-admission";
import type { RuntimePhysicsWorlds } from "./runtime-physics-worlds";
import { SaveGameWorld } from "./save-game-world";
import type { SceneRealizer } from "./scene-realizer";
import type { SceneStreams } from "./scene-streams";
import type { ScriptHost } from "./script-host";

export type RuntimeSaveGameOptions = Omit<SaveGameServiceOptions,
  "atBoundary" | "captureState" | "stageState" | "applyState" | "resetState" | "onGameLoaded">;

interface SessionBoundariesHost {
  world(): World;
  sessionGeneration(): number;
  stopped(): boolean;
  /** The main Scene document and guid; Save Game falls back to the library for the current Scene. */
  playScene(): SerializedScene | undefined;
  playSceneGuid(): string;
  sceneLibrary(): ReadonlyMap<string, SerializedScene>;
  scripts(): Pick<ScriptHost, "scriptsFor" | "classIds" | "hooksFor" | "bindInterfaceHandlers" | "invokeEvent" | "setSaveGameService">;
  streams(): Pick<SceneStreams, "blocking" | "isStreamActor">;
  sceneRealizer(): Pick<SceneRealizer, "blocked" | "realizing" | "loadId">;
  physics(): Pick<RuntimePhysicsWorlds, "main">;
  actorHooks(): SceneActorHooks;
  canSpawnActorClass(classId: string): boolean;
  realizeActor(actor: Actor): void;
  /** Remove an actor instance the way the driver removes any owned actor. */
  removeActor(actor: Actor): void;
  publishSnapshot(): void;
  /** The overlay layout deferred during the Save Game boundary, if any. */
  takeDeferredOverlayLayout(): boolean;
  pauseReasons(): ReadonlySet<SessionPauseReason>;
  setPauseReason(reason: SessionPauseReason, paused: boolean): void;
  resetInputState(): void;
  commandRevision(): number;
  reportError(error: unknown): void;
}

/**
 * Save Game and session boundaries: the Save Game service and world state
 * (`configureSaveGame`, its boundary, capture, stage, apply and reset
 * callbacks, and the deferred On Game Loaded notifications), Save Game actor
 * registration with the spawned-actor set, and the host's session boundary
 * requests (validation, the microtask-flushed queue, pause and input reset,
 * and the result identity). The driver keeps pause state and Simulation
 * quiesce and capture, which read the boundary result through this module.
 */
export class SessionBoundaries {
  private service?: SaveGameService;
  private saveGameWorld?: SaveGameWorld;
  private boundaryActive = false;
  private readonly savedActors = new WeakSet<Actor>();
  private pendingGameLoaded: (() => void) | null = null;
  private lastBoundaryRequestId = 0;
  private readonly boundaryRequests: Array<{ request: SessionBoundaryRequest; resolve(result: SessionBoundaryResult): void }> = [];
  private boundaryScheduled = false;
  private readonly admission: OwnerAdmission;
  private readonly host: SessionBoundariesHost;

  constructor(admission: OwnerAdmission, host: SessionBoundariesHost) {
    this.admission = admission;
    this.host = host;
  }

  /** A Save Game boundary is capturing or applying a checkpoint. */
  get saveBoundaryActive(): boolean { return this.boundaryActive; }
  get saveGameService(): SaveGameService | undefined { return this.service; }
  /** A queued session boundary request will pause the session. */
  get pausePending(): boolean {
    return this.boundaryRequests.some(({ request }) => request.action.kind === "pause" && request.action.paused);
  }

  /** A script or console spawn: Save Game removes it on reset and recreates it on load. */
  markSpawned(actor: Actor): void { this.savedActors.add(actor); }

  /** Actor realization tracks the actor for Save Game, outside a Save Game boundary. */
  trackRealized(actor: Actor): void {
    if (!this.boundaryActive) this.saveGameWorld?.register(actor, this.savedActors.has(actor));
  }

  saveActorId(actor: Actor): string { return this.saveGameWorld?.persistentId(actor) ?? actor.guid; }

  findSaveActor(id: string): Actor | undefined { return this.saveGameWorld?.findActor(id); }

  configureSaveGame(options: RuntimeSaveGameOptions): SaveGameService {
    if (this.service) throw new SaveGameError("invalid", "Save Game is already configured for this session.");
    const world = this.host.world();
    const state = new SaveGameWorld({
      world,
      sceneId: () => world.currentScene?.assetGuid ?? this.host.playSceneGuid(),
      eligible: (actor) => !actor.sceneLayerId && !this.host.streams().isStreamActor(actor),
      isSpawned: (actor) => this.savedActors.has(actor),
      classAssetGuid: (classId) => this.host.scripts().scriptsFor(classId)[0]?.assetGuid,
      resolveClass: (classId, assetGuid) => {
        const scripts = this.host.scripts();
        if (!assetGuid) return scripts.scriptsFor(classId).length === 0 && world.classRegistry.get(classId) ? classId : null;
        const candidates = scripts.classIds().filter((id) => scripts.scriptsFor(id).some((script) => script.assetGuid === assetGuid));
        return candidates.length === 1 ? candidates[0]! : null;
      },
      prepare: (id, classId, spawned) => {
        const scripts = this.host.scripts();
        if (!spawned) {
          const scene = this.host.playScene() ?? this.host.sceneLibrary().get(world.currentScene?.assetGuid ?? this.host.playSceneGuid());
          const row = scene?.actors.find((actor) => actor.id === id && actor.classId === classId);
          const actor = row ? createActorFromSerialized(world, row, this.host.actorHooks()) : null;
          if (actor) scripts.bindInterfaceHandlers(actor);
          return actor;
        }
        if (!this.host.canSpawnActorClass(classId) || !scripts.hooksFor(classId)) return null;
        const actor = world.createActor({ guid: id, classId, hooks: this.host.actorHooks()(classId) });
        scripts.bindInterfaceHandlers(actor);
        const components = scripts.scriptsFor(classId).find((script) => script.components !== undefined)?.components;
        if (components) attachSerializedComponents(world, actor, components, { freshIds: true });
        this.savedActors.add(actor);
        return actor;
      },
      realize: (actor) => this.host.realizeActor(actor),
      remove: (actor) => this.host.removeActor(actor),
      synchronize: (actors) => {
        this.host.physics().main.syncFromWorld(world);
        for (const actor of actors) this.host.physics().main.teleportActor(actor, world);
        this.host.publishSnapshot();
      },
      reportError: (error) => { this.host.reportError(error); },
    });
    this.saveGameWorld = state;
    for (const actor of world.getActors()) state.register(actor, this.savedActors.has(actor));
    const service = new SaveGameService({
      ...options,
      atBoundary: async (operation) => {
        // Promise scheduling enters after the entire synchronous tick, including
        // World's deferred spawn/destroy flush, even when called by a Tick graph.
        await Promise.resolve();
        if (this.host.stopped()) throw new SaveGameError("unavailable", "The game session has stopped.");
        if (this.host.sceneRealizer().blocked || this.host.streams().blocking || this.host.sceneRealizer().realizing) {
          throw new SaveGameError("unavailable", "Wait for scene loading to finish before saving or loading.");
        }
        this.boundaryActive = true;
        try { return await operation(); }
        finally {
          this.boundaryActive = false;
          const loaded = this.pendingGameLoaded;
          this.pendingGameLoaded = null;
          const publishOverlays = this.host.takeDeferredOverlayLayout();
          if (!this.host.stopped()) {
            // User callbacks run after commit. They cannot turn an applied
            // checkpoint into an apparent load failure.
            for (const notify of [publishOverlays ? () => this.host.publishSnapshot() : null, loaded, () => this.admission.flush()]) {
              try { notify?.(); }
              catch (error) {
                try { this.host.reportError(error); } catch { /* The host may be disconnected. */ }
              }
            }
          }
        }
      },
      captureState: (data) => {
        state.validateDataReferences(data, options.definition);
        return state.capture();
      },
      stageState: (saved, data) => {
        const staged = state.stage(saved);
        state.validateDataReferences(data, options.definition, staged);
        return staged;
      },
      applyState: (staged) => state.apply(staged),
      resetState: () => state.reset(),
      onGameLoaded: (info) => {
        this.pendingGameLoaded = () => {
          const owners: Array<BObject | null> = [world.gameInstance, world.currentScene,
            ...world.getGameSubsystems(), ...world.getSceneSubsystems(),
            ...world.getActors().flatMap((actor) => [actor, ...actor.components])];
          for (const owner of owners) {
            if (owner && !owner.destroyed) this.admission.run(owner, () => this.admission.guard(() =>
              this.host.scripts().invokeEvent(owner.classId, "onGameLoaded", owner, { ...info })));
          }
        };
      },
    });
    this.service = service;
    this.host.scripts().setSaveGameService(service);
    return service;
  }

  registerSaveActor(actor: BObject, persistentId?: string): void {
    if (!this.saveGameWorld) throw new SaveGameError("unavailable", "Select a default Save Game definition in Project Settings.");
    if (!(actor instanceof Actor) || actor.world !== this.host.world() || actor.destroyed) {
      throw new SaveGameError("invalid", "Register a live actor from this game session.");
    }
    this.saveGameWorld.register(actor, this.savedActors.has(actor), persistentId);
  }

  requestSessionBoundary(request: SessionBoundaryRequest): Promise<SessionBoundaryResult> {
    const invalid = request.sessionGeneration !== this.host.sessionGeneration() ? "Stale session generation." :
      !Number.isSafeInteger(request.requestId) || request.requestId <= this.lastBoundaryRequestId ? "Invalid or superseded request ID." :
      request.action?.kind !== "resetInput" && (request.action?.kind !== "pause" ||
        !["user", "lifecycle", "loading"].includes(request.action.reason) || typeof request.action.paused !== "boolean") ? "Unsupported session boundary operation." :
      this.host.stopped() ? "The game session has stopped." :
      this.boundaryRequests.length >= 64 ? "Session boundary queue is full." : null;
    if (invalid) return Promise.resolve(this.result(request, invalid));
    this.lastBoundaryRequestId = request.requestId;
    // A microtask runs after the complete synchronous tick and its deferred
    // snapshot publication, including reentrant host requests from onCommand.
    const result = new Promise<SessionBoundaryResult>(resolve => {
      this.boundaryRequests.push({ request: { ...request, action: { ...request.action } }, resolve });
    });
    if (!this.boundaryScheduled) {
      this.boundaryScheduled = true;
      queueMicrotask(() => this.flush());
    }
    return result;
  }

  /** The boundary result: pause reasons (a blocking stream load adds `loading`) and the session's identity now. */
  result(request: SessionBoundaryRequest, reason?: string): SessionBoundaryResult {
    const pauseReasons = new Set(this.host.pauseReasons());
    if (this.host.streams().blocking) pauseReasons.add("loading");
    return { sessionGeneration: request.sessionGeneration, requestId: request.requestId, success: !reason,
      ...(reason ? { reason } : {}), paused: pauseReasons.size > 0, pauseReasons: [...pauseReasons],
      tickIndex: this.host.world().clock.tickIndex, sceneAssetGuid: this.host.playSceneGuid(),
      sceneLoadId: this.host.sceneRealizer().loadId, commandRevision: this.host.commandRevision() };
  }

  /** Apply queued requests in order; after Stop each resolves as stopped. */
  flush(): void {
    this.boundaryScheduled = false;
    for (const { request, resolve } of this.boundaryRequests.splice(0)) {
      if (this.host.stopped()) { resolve(this.result(request, "The game session has stopped.")); continue; }
      try {
        if (request.action.kind === "pause") this.host.setPauseReason(request.action.reason, request.action.paused);
        else this.host.resetInputState();
        resolve(this.result(request));
      } catch (error) {
        resolve(this.result(request, error instanceof Error ? error.message : "Session boundary operation failed."));
      }
    }
  }
}
