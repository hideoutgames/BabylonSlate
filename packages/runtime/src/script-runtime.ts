import type { UserCommandDef } from "@babylonslate/debugger";
import {
  GAME_SUBSYSTEM_CLASS_ID,
  SCENE_SUBSYSTEM_CLASS_ID,
  instantiableSubsystemClassIds,
  isLockedEngineClassId,
  hydrateClassVariableValue,
  type Actor,
  type BObject,
  type ClassKind,
  type GameSubsystemHooks,
  type SceneSubsystem,
  type SceneSubsystemHooks,
  type Subsystem,
  type TickContext,
  type World,
} from "@babylonslate/object-model";
import type { LogSeverity } from "./log-ring";
import { COMPILED_MODULE_LINE_OFFSET } from "./module-loader";
import type { OwnerAdmission } from "./owner-admission";
import { shouldSpawnScriptedActor } from "./play-load";
import type { SceneStreams } from "./scene-streams";
import { compiledScriptKey, compiledScriptSourceLabel, type CompiledScript, type ScriptHost } from "./script-host";
import type { AnchorEntry } from "./stack-map";

interface ScriptRuntimeOptions {
  /** Class id for the session Game Instance singleton. */
  gameInstanceClass: string;
  /** Catalog identity only; registering an available class never reads its source. */
  classAssetGuids: Readonly<Record<string, string>>;
}

interface ScriptRuntimeHost {
  world(): World;
  stopped(): boolean;
  scriptHost(): Pick<ScriptHost, "replaceScripts" | "hooksFor" | "invokeEvent" | "invokeGameShutdownEvent" | "bindInterfaceHandlers">;
  /** Live streamed Scenes, whose classes keep their sources on replacement. */
  streams(): Pick<SceneStreams, "scenes">;
  registerAnchors(label: string, anchors: readonly AnchorEntry[]): void;
  deleteAnchors(label: string): void;
  bindUserCommand(def: Omit<UserCommandDef, "run"> & { classId: string }): void;
  reportLog(message: string, severity: LogSeverity, category: string): void;
}

/** Hooks both `GameInstanceHooks` and `GameSubsystemHooks` accept. */
type GameLifecycleHooks = {
  onCreation: (self: BObject) => void;
  onTick: (self: BObject, ctx: TickContext) => void;
  onGameEnd: (self: BObject) => void;
  onSceneStartLoading: (self: BObject, sceneName: string) => void;
  onSceneFinishLoading: (self: BObject, sceneName: string) => void;
  onFirstSceneLoaded: (self: BObject, sceneName: string) => void;
  onSceneExit: (self: BObject, sceneName: string) => void;
};

/**
 * The driver side of compiled scripts: the loaded script sources (serialized
 * load and replacement, Class registration parent-first, source anchors,
 * user command bindings), Class asset guids, spawnable Class lookup, the
 * session Game Instance and its lifecycle hooks, GameSubsystem installation
 * and SceneSubsystem hooks with their silent main Scene teardown, and the
 * `Get <Subsystem>` cache. `ScriptHost` loads and runs the modules; every
 * hook goes through `OwnerAdmission`. The driver keeps the anchor table and
 * calls `unregisterClasses()` explicitly in Stop, after the World ends and
 * ScriptHost is disposed and before Scene sources release. It is not a
 * registered subsystem.
 */
export class ScriptRuntime {
  private readonly classGuids = new Map<string, string>();
  private readonly scriptSources = new Map<string, CompiledScript>();
  private scriptSourceWork: Promise<void> = Promise.resolve();
  private readonly gameInstanceClass: string;
  private gameInstanceBound = false;
  /**
   * Actors each SceneSubsystem heard enter play (Scene Actor Spawned); only
   * these report Scene Actor Destroyed to it.
   */
  private readonly sceneSubsystemActors = new WeakMap<SceneSubsystem, WeakSet<Actor>>();
  /**
   * Nonzero while the main Scene's own teardown removes its streams, layers
   * and actors: its SceneSubsystems hear none of those notifications.
   */
  private sceneTeardownDepth = 0;
  /** `Get <Subsystem>` matches by class id; cleared when live subsystems change. */
  private readonly subsystemMatches = new Map<string, readonly Subsystem[]>();
  private readonly ambiguousSubsystemWarnings = new Set<string>();
  private readonly admission: OwnerAdmission;
  private readonly host: ScriptRuntimeHost;

  constructor(admission: OwnerAdmission, options: ScriptRuntimeOptions, host: ScriptRuntimeHost) {
    for (const [classId, guid] of Object.entries(options.classAssetGuids)) this.classGuids.set(classId, guid);
    this.gameInstanceClass = options.gameInstanceClass;
    this.admission = admission;
    this.host = host;
  }

  /** Class id → asset guid, for on-demand Class asset preparation. */
  get classAssetGuids(): ReadonlyMap<string, string> { return this.classGuids; }

  classAssetGuid(classId: string): string | undefined {
    return this.classGuids.get(classId);
  }

  setClassAssetGuid(classId: string, assetGuid: string): void {
    this.classGuids.set(classId, assetGuid);
  }

  /**
   * Load (`replace` false) or replace script sources, serialized after any
   * earlier update. A replacement keeps the sources of classes still live.
   */
  updateSources(scripts: readonly CompiledScript[], replace: boolean): Promise<void> {
    const work = this.scriptSourceWork.catch(() => {}).then(async () => {
      if (this.host.stopped()) throw new Error("The runtime stopped during script preparation.");
      const world = this.host.world();
      const requested = new Map(scripts.map((script) => [compiledScriptKey(script), script]));
      const actors = world.getActors();
      const owners = [world.gameInstance, world.currentScene, ...actors, ...actors.flatMap((actor) => actor.components),
        ...world.getSceneLayers(), ...world.getGameSubsystems(), ...world.getSceneSubsystems(),
        ...this.host.streams().scenes()];
      const liveClasses = new Set(owners.filter((owner) => owner && !owner.destroyed)
        .flatMap((owner) => world.classRegistry.ancestry(owner!.classId)));
      for (const script of this.scriptSources.values())
        if ((!replace || liveClasses.has(script.classId)) && !requested.has(compiledScriptKey(script))) requested.set(compiledScriptKey(script), script);
      const ordered = parentFirstScriptOrder([...requested.values()], (classId) => world.classRegistry.has(classId));
      await this.host.scriptHost().replaceScripts(ordered);
      if (this.host.stopped()) throw new Error("The runtime stopped during script preparation.");
      const classes = this.host.world().classRegistry;
      for (const classId of [...new Set([...this.scriptSources.values()].map((script) => script.classId))]
        .sort((a, b) => classes.ancestry(b).length - classes.ancestry(a).length)) classes.unregister(classId);
      for (const previous of this.scriptSources.values()) {
        this.host.deleteAnchors(compiledScriptSourceLabel(previous));
        this.host.deleteAnchors(previous.assetGuid);
      }
      this.scriptSources.clear();
      const ownerAnchors = new Map<string, AnchorEntry[]>();
      for (const script of ordered) {
        this.classGuids.set(script.classId, script.assetGuid);
        this.registerScriptClass(script);
        this.scriptSources.set(compiledScriptKey(script), script);
        if (script.anchors.length > 0) {
          this.host.registerAnchors(compiledScriptSourceLabel(script), script.anchors.map((anchor) => ({
            ...anchor, line: anchor.line + COMPILED_MODULE_LINE_OFFSET,
          })));
          const anchors = ownerAnchors.get(script.assetGuid) ?? [];
          anchors.push(...script.anchors);
          ownerAnchors.set(script.assetGuid, anchors);
        }
        if (script.command) {
          this.host.bindUserCommand({
            ...script.command,
            classId: script.classId,
          });
        }
      }
      for (const [guid, anchors] of ownerAnchors)
        this.host.registerAnchors(guid, anchors.sort((a, b) => a.line - b.line || a.column - b.column));
      this.applyGameInstanceClassDefaults();
      this.installSubsystems();
      for (const owner of owners) if (owner && !owner.destroyed) this.host.scriptHost().bindInterfaceHandlers(owner);
    });
    this.scriptSourceWork = work;
    return work;
  }

  /** Stop: unregister the script classes (children first) and forget their sources. */
  unregisterClasses(): void {
    const classes = this.host.world().classRegistry;
    for (const classId of [...new Set([...this.scriptSources.values()].map((script) => script.classId))]
      .sort((a, b) => classes.ancestry(b).length - classes.ancestry(a).length))
      classes.unregister(classId);
    this.scriptSources.clear();
  }

  /** Whether a script spawn may create an actor of this class. */
  canSpawnActorClass(classId: string): boolean {
    if (!shouldSpawnScriptedActor(classId)) return false;
    const classes = this.host.world().classRegistry;
    if (classes.isA(classId, "SceneLayerActor")) return false;
    // Registration copies the parent's kind; a repaired parent (see
    // registerScriptClass) can change it, so read it from the engine base.
    const engineBase = classes.ancestry(classId).find(isLockedEngineClassId);
    const kind = classes.get(engineBase ?? classId)?.kind;
    return kind !== "object" && kind !== "gameInstance";
  }

  /**
   * Instantiate the leaf subsystem classes the registry now knows. Real hosts
   * load scripts once, before `World.start()`, so GameSubsystems' On Init can
   * precede the Game Instance's. Scripts loaded after the World started (only
   * a headless caller can do that) cannot honour that order: the installed
   * GameSubsystems stay and new ones are reported, never started late.
   * SceneSubsystem classes apply to every later main Scene.
   */
  private installSubsystems(): void {
    const world = this.host.world();
    const classes = world.classRegistry;
    const classIds = classes.classIds();
    this.subsystemMatches.clear();
    world.setSceneSubsystemClasses(
      instantiableSubsystemClassIds(classes, classIds, SCENE_SUBSYSTEM_CLASS_ID),
    );
    const gameClassIds = instantiableSubsystemClassIds(classes, classIds, GAME_SUBSYSTEM_CLASS_ID);
    const subsystems = gameClassIds.map((classId) =>
      world.createGameSubsystem({ classId, hooks: this.gameSubsystemHooks(classId) }));
    try {
      world.setGameSubsystems(subsystems);
    } catch {
      const installed = world.getGameSubsystems().map((subsystem) => subsystem.classId);
      const missing = gameClassIds.filter((classId) => !installed.includes(classId));
      if (missing.length > 0) {
        this.host.reportLog(`GameSubsystems loaded after Play started are not created: ${missing.join(", ")}`, "warning", "subsystem");
      }
      return;
    }
    for (const subsystem of subsystems) this.host.scriptHost().bindInterfaceHandlers(subsystem);
  }

  /**
   * The Game Instance is created before scripts register its class, so apply
   * its class variable defaults, inherited interfaces and interface handlers
   * once they are known (before `World.start()` fires On Init). Values already
   * on the instance win, as with `World.createGameInstance`.
   */
  private applyGameInstanceClassDefaults(): void {
    const world = this.host.world();
    const gameInstance = world.gameInstance;
    if (!gameInstance) return;
    const classes = world.classRegistry;
    for (const variable of classes.inheritedVariables(gameInstance.classId)) {
      if (gameInstance.variables.has(variable.name)) continue;
      const value = hydrateClassVariableValue(variable);
      if (value !== undefined) gameInstance.setVariable(variable.name, value);
    }
    const interfaces = new Set(gameInstance.implementedInterfaces);
    for (const iface of classes.inheritedInterfaces(gameInstance.classId)) {
      interfaces.add(iface);
    }
    gameInstance.implementedInterfaces = [...interfaces];
    this.host.scriptHost().bindInterfaceHandlers(gameInstance);
  }

  private registerScriptClass(script: CompiledScript): void {
    const classes = this.host.world().classRegistry;
    const requestedParent =
      script.parentClassId?.trim() || "Actor";
    const parentClassId = classes.has(requestedParent)
      ? requestedParent
      : "Actor";
    const kind: ClassKind =
      classes.get(parentClassId)?.kind ?? "actor";
    const existingParent = classes.get(script.classId)?.parentClassId;
    // `ensure` keeps an existing class's parent. Repair a user class registered
    // before its script (the built-in demo `Enemy : Actor`) to the registered
    // parent the script names; `reparent` refuses cycles, keeping the old one.
    if (existingParent !== undefined && parentClassId === requestedParent &&
      existingParent !== requestedParent && !isLockedEngineClassId(script.classId)) {
      classes.reparent(script.classId, requestedParent);
    }
    classes.ensure({
      id: script.classId,
      parentClassId,
      kind,
      variables: [
        ...Object.entries(script.actorDefaults?.properties ?? {}).map(([name, defaultValue]) => ({ name, type: "unknown", defaultValue })),
        ...(script.variables ?? []).map((variable) => ({
        name: variable.name,
        type: variable.type,
        defaultValue: variable.defaultValue,
        ...(variable.container === "array" || variable.container === "map"
          ? { container: variable.container }
          : {}),
        ...(variable.keyTypeId ? { keyTypeId: variable.keyTypeId } : {}),
        ...(variable.keyTypeClassId
          ? { keyTypeClassId: variable.keyTypeClassId }
          : {}),
      })),
      ],
      implementedInterfaces: [...(script.implementedInterfaces ?? [])],
    });
  }

  /** Create the session Game Instance once; scripts bind to it lazily. */
  bindGameInstance(): void {
    if (this.gameInstanceBound) return;
    this.gameInstanceBound = true;
    const classId = this.gameInstanceClass;
    const hooks = this.gameLifecycleHooks(classId);
    const world = this.host.world();
    world.setGameInstance(
      world.createGameInstance({
        classId,
        guid: "runtime-gi",
        variables: { ticks: 0 },
        hooks: {
          ...hooks,
          onTick: (self, ctx) => {
            self.setVariable(
              "ticks",
              Number(self.getVariable("ticks")) + 1,
            );
            hooks.onTick(self, ctx);
          },
        },
      }),
    );
  }

  /**
   * Script binding shared by the Game Instance and GameSubsystems (full
   * parity). Scripts resolve lazily, so objects built before `loadScripts`
   * still run them. On End, and On Scene Exit once Play stops, are the final
   * lifecycle.
   */
  private gameLifecycleHooks(classId: string): GameLifecycleHooks {
    const sceneEvent = (event: string) => (self: BObject, sceneName: string) => {
      this.admission.run(self, () => this.admission.guard(() => this.host.scriptHost().invokeEvent(classId, event, self, { sceneName })));
    };
    return {
      onCreation: (self) => {
        const hooks = this.host.scriptHost().hooksFor(classId);
        this.admission.runCreation(self, () => hooks?.onCreation?.(self));
      },
      onTick: (self, ctx) => {
        const hooks = this.host.scriptHost().hooksFor(classId);
        this.admission.guard(() => hooks?.onTick?.(self, ctx));
      },
      onGameEnd: (self) => {
        this.admission.guard(() =>
          this.host.scriptHost().invokeGameShutdownEvent(classId, "onEnd", self),
        );
      },
      onSceneStartLoading: sceneEvent("onSceneStartLoading"),
      onSceneFinishLoading: sceneEvent("onSceneFinishLoading"),
      onFirstSceneLoaded: sceneEvent("onFirstSceneLoaded"),
      onSceneExit: (self, sceneName) => {
        this.admission.guard(() => {
          if (this.host.stopped()) {
            this.host.scriptHost().invokeGameShutdownEvent(classId, "onSceneExit", self, { sceneName });
          } else {
            this.admission.run(self, () => this.host.scriptHost().invokeEvent(classId, "onSceneExit", self, { sceneName }));
          }
        });
      },
    };
  }

  private gameSubsystemHooks(classId: string): GameSubsystemHooks {
    const hooks = this.gameLifecycleHooks(classId);
    return {
      ...hooks,
      onGameEnd: (self) => {
        this.subsystemMatches.clear();
        hooks.onGameEnd(self);
      },
    };
  }

  /**
   * Script binding for a SceneSubsystem the World creates with the main Scene.
   * Interface handlers bind at creation, so it is callable while the Scene
   * prepares. On Init and every notification wait in its owner queue until
   * the Scene may run, preserving the World's order (On Init first). On End
   * is final and always runs, dropping anything still queued.
   */
  sceneSubsystemHooks(classId: string): SceneSubsystemHooks {
    const notify = (self: SceneSubsystem, event: string, args: Record<string, unknown>) => {
      if (!this.sceneSubsystemNotificationsMuted()) this.runSceneSubsystemEvent(self, classId, event, args);
    };
    return {
      onCreation: (self) => {
        this.subsystemMatches.clear();
        this.host.scriptHost().bindInterfaceHandlers(self);
        this.admission.runCreation(self, () => this.host.scriptHost().hooksFor(classId)?.onCreation?.(self));
      },
      onTick: (self, ctx) =>
        this.admission.guard(() => this.host.scriptHost().hooksFor(classId)?.onTick?.(self, ctx)),
      onEnd: (self) => {
        this.subsystemMatches.clear();
        this.admission.drop(self);
        this.admission.guard(() => this.host.scriptHost().invokeGameShutdownEvent(classId, "onEnd", self));
      },
      onSceneLoaded: (self, sceneName) => notify(self, "onSceneLoaded", { sceneName }),
      onStreamedSceneLoaded: (self, streamingActor, scene) =>
        notify(self, "onStreamedSceneLoaded", { streamingActor, scene }),
      onStreamedSceneUnloaded: (self, streamingActor, scene) =>
        notify(self, "onStreamedSceneUnloaded", { streamingActor, scene }),
      onSceneLayerAdded: (self, sceneLayer) => notify(self, "onSceneLayerAdded", { sceneLayer }),
      onSceneLayerRemoved: (self, sceneLayer) => notify(self, "onSceneLayerRemoved", { sceneLayer }),
      onSceneActorSpawned: (self, actor) => {
        if (this.sceneSubsystemNotificationsMuted()) return;
        // The World announces at spawn commit; the actor enters play when its
        // own queue runs, so Spawned waits there, right before its Begin Play.
        this.admission.run(actor, () => {
          if (self.ended) return;
          let entered = this.sceneSubsystemActors.get(self);
          if (!entered) this.sceneSubsystemActors.set(self, entered = new WeakSet());
          entered.add(actor);
          this.runSceneSubsystemEvent(self, classId, "onSceneActorSpawned", { actor });
        });
      },
      onSceneActorDestroyed: (self, actor) => {
        if (this.sceneSubsystemActors.get(self)?.delete(actor)) notify(self, "onSceneActorDestroyed", { actor });
      },
    };
  }

  /**
   * The main Scene's own teardown is silent for its SceneSubsystems: Stop
   * (streams, layers, the cancelled realization), Change Scene's stream
   * retirement and a failed realization's cleanup.
   */
  private sceneSubsystemNotificationsMuted(): boolean {
    return this.host.stopped() || this.sceneTeardownDepth > 0;
  }

  duringSceneTeardown(teardown: () => void): void {
    this.sceneTeardownDepth++;
    try {
      teardown();
    } finally {
      this.sceneTeardownDepth--;
    }
  }

  /** Dispatch after On Init and any earlier queued notification, in order. */
  private runSceneSubsystemEvent(
    subsystem: SceneSubsystem,
    classId: string,
    event: string,
    args: Record<string, unknown>,
  ): void {
    this.admission.runAfterQueued(subsystem, () =>
      this.admission.guard(() => this.host.scriptHost().invokeEvent(classId, event, subsystem, args)));
  }

  /**
   * `Get <Subsystem>`: compiled graphs evaluate it at every use, so matches
   * are cached until the live subsystems change. More than one match takes
   * the first (class-id order) and warns once per class id.
   */
  findSubsystem(classId: string): Subsystem | null {
    let matches = this.subsystemMatches.get(classId);
    if (!matches) {
      matches = this.host.world().findSubsystems(classId);
      this.subsystemMatches.set(classId, matches);
      if (matches.length > 1 && !this.ambiguousSubsystemWarnings.has(classId)) {
        this.ambiguousSubsystemWarnings.add(classId);
        this.host.reportLog(
          `Get ${classId} matches ${matches.length} subsystems (${matches.map((match) => match.classId).join(", ")}); using ${matches[0]!.classId}.`,
          "warning",
          "subsystem",
        );
      }
    }
    return matches[0] ?? null;
  }
}

/**
 * Order scripts so a user parent class registers before its children; the
 * incoming order is kept otherwise. A parent that is missing, or reached again
 * through a parent cycle, falls back to `Actor` like any unknown parent.
 */
function parentFirstScriptOrder(
  scripts: readonly CompiledScript[],
  isRegistered: (classId: string) => boolean,
): CompiledScript[] {
  const indicesByClassId = new Map<string, number[]>();
  scripts.forEach((script, index) => {
    const indices = indicesByClassId.get(script.classId) ?? [];
    indices.push(index);
    indicesByClassId.set(script.classId, indices);
  });
  const visited = new Set<number>();
  const ordered: CompiledScript[] = [];
  const visit = (index: number): void => {
    if (visited.has(index)) return;
    visited.add(index);
    const script = scripts[index]!;
    const parentClassId = script.parentClassId?.trim();
    if (parentClassId && parentClassId !== script.classId && !isRegistered(parentClassId)) {
      for (const parentIndex of indicesByClassId.get(parentClassId) ?? []) visit(parentIndex);
    }
    ordered.push(script);
  };
  scripts.forEach((_, index) => visit(index));
  return ordered;
}
