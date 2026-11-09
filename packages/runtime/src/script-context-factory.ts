import {
  cloneSaveGameValue,
  DEFORMER_PROPERTY_KEYS,
  emptyWaterSample,
  idleDeviceMotion,
  lookAtRotator,
  rotatorToQuat,
  SaveGameError,
  updateDeformerProperties,
  type RenderTargetCaptureProperty,
  type RandomStream,
  type SaveGameMigrationData,
  type SaveGameValue,
} from "@haptic/core";
import {
  Actor,
  ActorComponent,
  EngineObject,
  LayerCamera,
  MaterialObject,
  Scene,
  SceneCameraManager,
  SceneLayer,
  dispatchInterface,
  type InterfaceDispatchTarget,
  type TickContext,
} from "@haptic/object-model";
import { animExitTimeReached } from "@haptic/anim-graph";
import { isInfiniteLoopError } from "@haptic/debugger";
import { createUnavailableEditorDataApi } from "@haptic/scripting";
import { RuntimeDataCatalog } from "./data-catalog";
import { captureActorReferences, setCaptureProperty } from "./render-targets";
import { callNativeComponentFunction, type ComponentFunctionHost } from "./script-component-functions";
import type {
  CallerFrame,
  CompiledScript,
  HostContextKey,
  HostContextMembers,
  LoadedScript,
  ScreenProjection,
  ScriptContext,
  ScriptExtras,
} from "./script-context-types";
import type { ScriptDebugTrace } from "./script-debug";
import { EventDelegate, DISPATCHER_MAX_DEPTH, type DispatcherBindings } from "./script-dispatchers";
import {
  asActor,
  asActorComponent,
  asScriptVec3,
  finiteQuat,
  finiteRotator,
  finiteVector,
  findComponentById,
  findComponentByIdFromTarget,
  ownedSceneActor,
  refuseParentCycle,
  requireSaveGameService,
  resolveLiveActor,
  resolveLiveActors,
  transformTarget,
  writeParentId,
} from "./script-host-helpers";
import type { ScriptHostServices } from "./script-host-services";
import type { ScriptMaterialOwnership } from "./script-material-ownership";
import { tweenOwnerAlive } from "./tween-runtime";
import { isReadOnlyTweenProperty, propertyTweenReference, tweenStorageValue } from "./tween-targets";

const EMPTY_DATA = new RuntimeDataCatalog();
const UNAVAILABLE_EDITOR_DATA = createUnavailableEditorDataApi();
/** Behaviour Tree hooks of a context without a Behaviour Tree run: they do nothing and read nothing. */
const NO_BT_HOOK = (): undefined => undefined;

const ASSET_LOADING_UNAVAILABLE = "Asset loading is unavailable in this host";

/** Handlers of a missing receiver: none, so interface calls read the pin defaults. */
const NO_INTERFACE_RECEIVER: InterfaceDispatchTarget = { guid: "", classId: "", implementedInterfaces: [] };

/**
 * What `createScriptContextClass` reads from its `ScriptHost`: the host builds it once from wrappers over its
 * private state, which contexts reach only through these members.
 */
export interface ScriptContextHost extends ComponentFunctionHost {
  readonly rng: RandomStream;
  readonly dispatchers: DispatcherBindings;
  readonly materials: ScriptMaterialOwnership;
  /** The prototype of every context. */
  readonly hostMembers: HostContextMembers;
  /** `ctx.debugTrace` of a context whose instance (variable store) is `store`. */
  debugTraceFor(store: unknown): ScriptDebugTrace | null;
  flowStateFor(owner: EngineObject | null, nodeId: string, namespace: string): Record<string, unknown>;
  /** Runs `run` with `frame` as the `ctx.callInterface` caller, whose frame its interface handler runs in. */
  withInterfaceCaller<T>(frame: CallerFrame, run: () => T): T;
  invokeSaveMigration(self: EngineObject, event: string, snapshot: SaveGameMigrationData): Promise<void>;
  eventScriptsFor(classId: string, event: string, self: EngineObject | null, componentId?: string): LoadedScript[] | undefined;
  functionScriptsFor(classId: string, exportName: string): LoadedScript[] | undefined;
  dispatchEvent(
    loaded: readonly LoadedScript[],
    event: string,
    self: EngineObject | null,
    deltaSeconds: number,
    tickIndex: number,
    commandArgs?: Record<string, unknown>,
    tick?: TickContext,
    extras?: ScriptExtras,
    componentId?: string,
  ): { error: unknown } | null;
  invokeEntry<T>(owner: EngineObject | null, script: CompiledScript, exportName: string, invoke: () => T): T;
  reportLatentError(error: unknown, owner: EngineObject | null): void;
}

/** Builds a context for one script call; see `ScriptHost.createContext`. */
export type ScriptContextConstructor = new (
  self: EngineObject | null,
  deltaSeconds: number,
  tickIndex: number,
  commandArgs?: Record<string, unknown>,
  tick?: TickContext,
  extras?: ScriptExtras,
  flowNamespace?: string,
) => ScriptContext;

/** The members a context holds as its own values, set when it is built. */
type CallValueKey =
  | "data" | "editorData" | "self" | "deltaSeconds" | "tickIndex" | "debugTrace" | "commandArgs" | "args" | "animFacts"
  | "inputBindings" | "getInputState" | "gamepadConnections" | "btFinish" | "btEvaluate" | "getBlackboard" | "setBlackboard";
/** The members that act on a call's state: methods every context of a host shares. */
type CallMethods = Omit<ScriptContext, HostContextKey | CallValueKey | "random">;

function migrationData(extras: ScriptExtras | undefined, commandArgs: Record<string, unknown>): SaveGameMigrationData {
  const data = extras?.saveMigrationData ?? commandArgs.saveMigrationData as SaveGameMigrationData | undefined;
  if (!data) throw new SaveGameError("invalid", "Migration fields are available only inside Event Save Migration.");
  return data;
}

/**
 * The class of a host's contexts, built once per host. A context is one small object per script call: its own
 * values, and the call's state in private fields. Everything that acts on that state is a method on the class's
 * prototype, shared by every context of the host, and the prototype inherits the host-lifetime members
 * (`host.hostMembers`). Building a context therefore allocates no function, however many members a context has.
 *
 * A method reads the call from `this`, so it must be called on its context (`ctx.getVariable(name)`), as compiled
 * graphs do; taken off the context and called bare, it throws. `CallMethods` and `CallValueKey` together must cover
 * every `ScriptContext` member that is not a `HostContextKey`: a member missing from both fails to compile here.
 */
export function createScriptContextClass(host: ScriptContextHost): ScriptContextConstructor {
  const services = host.services;
  const screenProjection = (hit: ReturnType<NonNullable<ScriptHostServices["projectCursorToScene"]>> | undefined): ScreenProjection => ({
    hit: hit?.hit === true,
    location: hit?.location ?? null,
    normal: hit?.normal ?? null,
    distance: hit?.distance ?? 0,
    actor: resolveLiveActor(services, hit?.actorId ?? null),
    worldOrigin: hit?.worldOrigin ?? { x: 0, y: 0, z: 0 },
    worldDirection: hit?.worldDirection ?? { x: 0, y: 0, z: 0 },
  });

  const queryOptions = (channel: string | undefined, actorsToIgnore: readonly (Actor | null)[] | undefined) => ({
    ignoreActorIds: [
      ...new Set(
        (Array.isArray(actorsToIgnore) ? actorsToIgnore : [])
          .filter((actor): actor is Actor => actor instanceof Actor && !actor.destroyed)
          .map((actor) => actor.guid),
      ),
    ],
    ...(channel ? { channel } : {}),
  });

  // The handle's Id is the number in the voice id (`script:<Id>`); 0 when no host names voices.
  const playScriptSound = (self: EngineObject | null, asset: unknown, volume: unknown, extra: { location?: { x: number; y: number; z: number }; pitch?: number }) => {
    const voiceId = services.scriptVoiceId?.();
    services.playSound?.(String(asset ?? ""), Number(volume ?? 1), {
      emitterActorGuid: self?.guid ?? null,
      ...(voiceId ? { voiceId } : {}),
      ...extra,
    });
    return { Id: voiceId ? Number(voiceId.slice("script:".length)) || 0 : 0 };
  };
  // One generator for every context of the host; each context draws from the host RNG, in call order.
  const random: ScriptContext["random"] = {
    float: () => host.rng.nextFloat(),
    int: (min, max) => {
      const a = Number(min) | 0;
      const b = Number(max) | 0;
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      if (hi === lo) return lo;
      return lo + (host.rng.next() % (hi - lo + 1));
    },
    bool: () => host.rng.nextFloat() < 0.5,
  };

  class Context implements Pick<ScriptContext, CallValueKey> {
    data: ScriptContext["data"];
    editorData: ScriptContext["editorData"];
    self: ScriptContext["self"];
    deltaSeconds: number;
    tickIndex: number;
    debugTrace: ScriptContext["debugTrace"];
    commandArgs: ScriptContext["commandArgs"];
    args: ScriptContext["args"];
    animFacts: ScriptContext["animFacts"];
    inputBindings: ScriptContext["inputBindings"];
    getInputState: ScriptContext["getInputState"];
    gamepadConnections: ScriptContext["gamepadConnections"];
    btFinish: ScriptContext["btFinish"];
    btEvaluate: ScriptContext["btEvaluate"];
    getBlackboard: ScriptContext["getBlackboard"];
    setBlackboard: ScriptContext["setBlackboard"];
    /** The instance whose variables the call reads: `self`, or an Animation Graph's component. */
    readonly #store: NonNullable<ScriptExtras["variableStore"]> | EngineObject | null;
    /** Also the Scene query caller: queries answer from this object's world, so a static Function Library call keeps its caller's. */
    readonly #owner: EngineObject | null;
    readonly #tick: TickContext | undefined;
    readonly #extras: ScriptExtras | undefined;
    readonly #flowNamespace: string;

    constructor(
      self: EngineObject | null,
      deltaSeconds: number,
      tickIndex: number,
      commandArgs: Record<string, unknown> = {},
      tick?: TickContext,
      extras?: ScriptExtras,
      flowNamespace = "",
    ) {
      const store = extras?.variableStore ?? self;
      this.data = services.data ?? EMPTY_DATA;
      this.editorData = services.editorData ?? UNAVAILABLE_EDITOR_DATA;
      this.self = self;
      this.deltaSeconds = deltaSeconds;
      this.tickIndex = tickIndex;
      // The instance is `self`, except for an Animation Graph's scripts, which run on the actor
      // while the graph's instance is its component (the variable store).
      this.debugTrace = host.debugTraceFor(store);
      this.commandArgs = commandArgs;
      this.args = commandArgs;
      this.animFacts = extras?.animFacts;
      this.inputBindings = services.inputBindings;
      this.getInputState = services.getInputState;
      this.gamepadConnections = tick?.gamepadConnections ?? [];
      this.btFinish = extras?.btFinish ?? NO_BT_HOOK;
      this.btEvaluate = extras?.btEvaluate ?? NO_BT_HOOK;
      this.getBlackboard = extras?.getBlackboard ?? NO_BT_HOOK;
      this.setBlackboard = extras?.setBlackboard ?? NO_BT_HOOK;
      this.#store = store;
      this.#owner = self ?? extras?.callerOwner ?? null;
      this.#tick = tick;
      this.#extras = extras;
      this.#flowNamespace = flowNamespace;
    }

    static {
      // The class as scripts see it: its methods and the host members are on the prototype, which the class type omits.
      const NestedContext = Context as unknown as ScriptContextConstructor;
      const methods: CallMethods & ThisType<Context & ScriptContext> = {
        registerSaveMigration(fromVersion, migrate) {
          const { self } = this;
          const service = requireSaveGameService(services);
          if (typeof migrate === "function") service.registerMigration(fromVersion, migrate);
          else {
            if (!self) throw new SaveGameError("invalid", "Visual save migrations require an owning object.");
            service.registerMigration(fromVersion, (snapshot) => host.invokeSaveMigration(self, migrate, snapshot));
          }
        },
        // Actor identities remain IDs here: staged actors do not exist yet. Map fields read as a Map, as in gameplay.
        getSaveMigrationField(id, _type, container) {
          const { commandArgs } = this;
          const extras = this.#extras;
          const value = migrationData(extras, commandArgs).fields[id] ?? null;
          return container === "map" && Array.isArray(value)
            ? new Map(value.map((entry) => [(entry as { key: SaveGameValue }).key, (entry as { value: SaveGameValue }).value]))
            : value;
        },
        setSaveMigrationField(id, value, _type, container) {
          const { commandArgs } = this;
          const extras = this.#extras;
          const stored = container === "map" && value instanceof Map ? [...value].map(([key, entry]) => ({ key, value: entry })) : value;
          const fields = cloneSaveGameValue({ [id]: stored }) as Record<string, SaveGameValue>;
          Object.assign(migrationData(extras, commandArgs).fields, fields);
        },
        async readDataEntryAsync(tree, path, definitionGuid) {
          const { self } = this;
          if (services.prepareAssets) await services.prepareAssets([tree, ...(definitionGuid ? [definitionGuid] : [])], self);
          else if (!services.data?.hasTree(tree)) throw new Error(`Data Tree ${tree} is not prepared; this host cannot load cold data.`);
          if (self?.destroyed) throw Object.assign(new Error("The data reader was destroyed"), { name: "AbortError" });
          return services.data?.readEntry(tree, path, definitionGuid) ?? null;
        },
        animExitTimeReached(exitTime) {
          const extras = this.#extras;
          return extras?.animFacts ? animExitTimeReached(extras.animFacts, Number(exitTime)) : false;
        },
        flowState(nodeId: string) {
          const contextOwner = this.#owner, flowNamespace = this.#flowNamespace;
          return host.flowStateFor(contextOwner, String(nodeId), flowNamespace);
        },
        reportCommand(success, output) {
          const extras = this.#extras;
          if (extras?.commandResult) Object.assign(extras.commandResult, { success: Boolean(success), output: String(output) });
        },
        // Get Layer Camera on Self (a Scene Layer or Scene Layer Actor) is read live, unless the class declares its own.
        getVariable(name) {
          const store = this.#store;
          return name === "layerCamera" && store instanceof EngineObject && !store.variables.has(name)
            ? this.getVariableFrom(store, name) : store?.getVariable(name);
        },
        variableReference(target, name, implicitSelf = false) {
          const store = this.#store, contextOwner = this.#owner;
          const object = implicitSelf ? store : target;
          if (!object || typeof name !== "string" || !name ||
            (object instanceof EngineObject && (object.destroyed || isReadOnlyTweenProperty(object, name)))) return null;
          return {
            identity: object, property: `variable:${name}`,
            owner: object instanceof EngineObject ? object : contextOwner ?? undefined,
            get: () => object instanceof EngineObject ? this.getVariableFrom(object, name) : object.getVariable(name),
            set: (value) => {
              if (object instanceof EngineObject) this.setVariableOn(object, name, tweenStorageValue(object, name, value));
              else object.setVariable(name, value);
            },
          };
        },
        tweenValue(reference, type, a, b, duration, curve) {
          const contextOwner = this.#owner;
          if (!reference) return Promise.resolve(false);
          if (!services.tween) return Promise.reject(new Error("Tween actions are unavailable in this script host."));
          return services.tween({ reference, type, a, b, duration, curve, owner: contextOwner }).then(completed =>
            completed && tweenOwnerAlive(contextOwner) && tweenOwnerAlive(reference.owner) && services.isTweenSessionActive?.() !== false);
        },
        tweenProperty(target, property, type, a, b, duration, curve, space) {
          const reference = propertyTweenReference(target, property, type, space, services);
          return this.tweenValue(reference, type, a, b, duration, curve);
        },
        setVariable(name, value) {
          const store = this.#store;
          if (store instanceof Actor && name === "parentId") {
            writeParentId(services, store, value);
            return;
          }
          store?.setVariable(name, value);
        },
        getVariableFrom(object, name) {
          if (object instanceof ActorComponent && object.classId === "2DRichTextComponent" &&
            (name === "appearProgress" || name === "isRevealed")) {
            const progress = services.text2DAppearProgress?.(object) ?? 1;
            return name === "isRevealed" ? progress === 1 : progress;
          }
          if (object instanceof ActorComponent && object.classId === "RenderTargetCaptureComponent" && name === "actorIds") {
            return host.canInvokeOwner(object) ? captureActorReferences(object, (id) => services.findActor?.(id)) : [];
          }
          if (object instanceof SceneCameraManager) {
            if (name === "layerCamera") return services.getMainSceneCamera?.() ?? null;
            if (name === "cameraActor") return services.getCameraActor?.() ?? null;
            if (name === "cameraComponent") return services.getCameraComponent?.() ?? null;
          }
          if (name === "layerCamera") {
            // A Scene Layer's own camera, or the camera of the layer a Scene Layer Actor belongs to.
            if (object instanceof SceneLayer) return object.camera;
            if (object instanceof Actor) return services.getOwningSceneLayer?.(object)?.camera ?? null;
          }
          return object?.getVariable(name);
        },
        setVariableOn(object, name, value) {
          if (object instanceof ActorComponent && object.classId === "DeformerComponent" &&
            (DEFORMER_PROPERTY_KEYS as readonly string[]).includes(name)) {
            if (!host.canInvokeOwner(object)) return;
            const next = updateDeformerProperties(Object.fromEntries(DEFORMER_PROPERTY_KEYS.map((key) => [key, object.getVariable(key)])), name, value);
            for (const key of DEFORMER_PROPERTY_KEYS) object.setVariable(key, next[key]);
            host.applyComponentVariable(object, name, next[name as keyof typeof next]);
            return;
          }
          if (object instanceof ActorComponent && object.classId === "RenderTargetCaptureComponent") {
            if (host.canInvokeOwner(object) && setCaptureProperty(object, name as RenderTargetCaptureProperty, value, (id) => services.findActor?.(id))) {
              host.applyComponentVariable(object, name, value);
            }
            return;
          }
          if (object instanceof LayerCamera && (name === "location" || name === "rotation" || name === "zoom")) {
            const vector = value as { x?: unknown; y?: unknown } | null | undefined;
            services.setLayerCamera?.(object, name === "location" ? { x: vector?.x, y: vector?.y } : { [name]: value });
            return;
          }
          if (object instanceof Scene && String(name ?? "") === "gravity") {
            const gravity = asScriptVec3(value);
            if (!gravity) return;
            object.setVariable("gravity", gravity);
            services.setWorldGravity?.(gravity);
            return;
          }
          if (object instanceof Actor && name === "parentId") {
            writeParentId(services, object, value);
            return;
          }
          const previous = object instanceof ActorComponent ? object.getVariable(name) : undefined;
          object?.setVariable(name, value);
          if (object instanceof ActorComponent) {
            host.applyComponentVariable(object, String(name ?? ""), value, previous);
          }
        },
        async setMeshMaterialAsync(component, materialGuid) {
          const { self } = this;
          const target = asActorComponent(component);
          if (!target || (target.classId !== "MeshComponent" && target.classId !== "DynamicRuntimeMeshComponent") || !host.canInvokeOwner(target)) return null;
          const version = host.materials.beginMaterialReplacement(target, "material");
          const guid = typeof materialGuid === "string" ? materialGuid.trim() : "";
          let preload = "";
          try {
            if (guid && services.prepareAssets) preload = await host.materials.prepareMaterialAsset(guid, target);
            if (self?.destroyed || !host.canInvokeOwner(target) || !host.materials.isMaterialReplacementCurrent(target, "material", version)) {
              throw Object.assign(new Error("The material replacement was cancelled or superseded"), { name: "AbortError" });
            }
            const material = this.setMeshMaterial(target, guid);
            host.materials.retainMaterialPreload(target, "material", { id: preload, guid });
            preload = "";
            return material;
          } finally {
            if (preload) services.releaseAcquiredAssets?.(preload);
          }
        },
        async setMaterialTextureParameterAsync(material, name, value) {
          const { self } = this;
          if (!host.materials.materialAvailable(material) || typeof name !== "string" || !name.trim()) return;
          const key = `texture:${name.trim()}`;
          const version = host.materials.beginMaterialReplacement(material, key);
          const guid = typeof value === "string" ? value.trim() : "";
          let preload = "";
          try {
            if (guid && services.prepareAssets) preload = await host.materials.prepareMaterialAsset(guid, material instanceof MaterialObject ? material.component : self);
            if (self?.destroyed || !host.materials.materialAvailable(material) || !host.materials.isMaterialReplacementCurrent(material, key, version)) {
              throw Object.assign(new Error("The texture replacement was cancelled or superseded"), { name: "AbortError" });
            }
            this.setMaterialTextureParameter(material, name, guid || null);
            host.materials.retainMaterialPreload(material, key, { id: preload, guid });
            preload = "";
          } finally {
            if (preload) services.releaseAcquiredAssets?.(preload);
          }
        },
        destroyActor(actor) {
          const target = asActor(actor);
          if (target) services.destroyActor(target);
        },
        setActorLocation(actor, location) {
          const target = transformTarget(actor);
          const position = finiteVector(location, 0);
          if (!target || !position) return;
          Object.assign(target.transform.position, position);
          services.teleportActor?.(target);
        },
        addActorWorldOffset(actor, offset) {
          const target = transformTarget(actor);
          const delta = finiteVector(offset, 0);
          if (!target || !delta) return;
          const position = finiteVector({
            x: target.transform.position.x + delta.x,
            y: target.transform.position.y + delta.y,
            z: target.transform.position.z + delta.z,
          }, 0);
          if (!position) return;
          Object.assign(target.transform.position, position);
          services.teleportActor?.(target);
        },
        setActorRotation(actor, rotation) {
          const target = transformTarget(actor);
          const rotator = finiteRotator(rotation);
          if (!target || !rotator) return;
          Object.assign(target.transform.rotation, rotatorToQuat(rotator));
          services.teleportActor?.(target);
        },
        setActorScale(actor, scale) {
          const target = transformTarget(actor);
          const next = finiteVector(scale, 1);
          if (!target || !next) return;
          Object.assign(target.transform.scale, next);
          services.teleportActor?.(target);
        },
        setActorTransform(actor, transform, options) {
          const target = transformTarget(actor);
          if (!target || !transform) return;
          // Every supplied part is checked first, so a non-finite part changes nothing.
          const position = transform.position ? finiteVector(transform.position, 0) : undefined;
          const rotation = transform.rotation ? finiteQuat(transform.rotation) : undefined;
          const scale = transform.scale ? finiteVector(transform.scale, 1) : undefined;
          if (position === null || rotation === null || scale === null) return;
          if (position) Object.assign(target.transform.position, position);
          if (rotation) Object.assign(target.transform.rotation, rotation);
          if (scale) Object.assign(target.transform.scale, scale);
          services.teleportActor?.(target, options);
        },
        attachToBone(actor, target, boneName) {
          const child = asActor(actor);
          const parent = asActor(target);
          if (!child || child.destroyed || !parent || parent.destroyed ||
            typeof boneName !== "string" || !boneName.trim()) return;
          if (refuseParentCycle(services, child, parent, "Attach To Bone")) return;
          // Without a renderer attachment the child would sit at the parent's
          // origin, so a refused attachment keeps its parent link and pose.
          if (!services.attachToBone?.(child, parent, boneName)) return;
          child.setVariable("parentId", parent.guid);
          child.transform.position = { x: 0, y: 0, z: 0 };
          child.transform.rotation = { x: 0, y: 0, z: 0, w: 1 };
        },
        async executeConsoleCommandAsync(command) {
          const { self } = this;
          const result = await (services.executeConsoleCommandAsync?.(String(command ?? "")) ?? services.executeConsoleCommand(String(command ?? "")));
          if (self?.destroyed) throw Object.assign(new Error("The console command caller was destroyed"), { name: "AbortError" });
          return result;
        },
        delay(seconds) {
          const { self } = this;
          return services.delay(seconds, self);
        },
        delayOneTick() {
          const { self } = this;
          if (!services.delayOneTick) throw new Error("This host cannot delay by one tick");
          return services.delayOneTick(self);
        },
        // Keyed like `flowState`: one wait per node of this script for each object.
        retriggerableDelay(nodeId, seconds) {
          const { self } = this;
          const flowNamespace = this.#flowNamespace;
          if (!services.retriggerableDelay) throw new Error("This host cannot run a Retriggerable Delay");
          const key = flowNamespace ? `${flowNamespace}\0${String(nodeId)}` : String(nodeId);
          return services.retriggerableDelay(key, seconds, self);
        },
        // The timer belongs to the object running the graph: it ends with it, and pauses with it.
        setTimer(delegate, time, looping, firstDelay) {
          const { self } = this;
          return ({
          Id: delegate instanceof EventDelegate ? services.timers?.set(self ?? null, delegate, time, looping, firstDelay) ?? 0 : 0,
        });
        },
        callInterface(target, interfaceGuid, method, args) {
          const { deltaSeconds, tickIndex } = this;
          const tick = this.#tick;
          const registry = services.interfaceRegistry;
          if (!registry) return {};
          const receiver = target as InterfaceDispatchTarget | null | undefined;
          // A missing or unadmitted receiver runs no handler and reads the pin defaults.
          const dispatchTarget: InterfaceDispatchTarget = !receiver ? NO_INTERFACE_RECEIVER
            : !(receiver instanceof EngineObject) || host.canInvokeOwner(receiver) ? receiver
              : { guid: receiver.guid, classId: receiver.classId, implementedInterfaces: receiver.implementedInterfaces };
          return host.withInterfaceCaller({ deltaSeconds, tickIndex, tick }, () =>
            dispatchInterface(registry, dispatchTarget, String(interfaceGuid), String(method), args ?? {}));
        },
        getComponent(actor, classId) {
          return asActor(actor)?.components.find((c) => c.classId === classId && !c.destroyed) ??
          null;
        },
        getComponentById(actor, componentId) {
          const target = actor ?? null;
          // Spawned prefabs resolve their own sourceId before an authored scene
          // component with the same id can claim the stream-wide translation.
          const local = findComponentById(asActor(target), componentId);
          if (local) return local;
          return findComponentByIdFromTarget(
            target,
            services.resolveInstanceId?.(target, componentId) ?? componentId,
            services.getActors?.(),
            services.getSceneReference?.(target) ?? null,
          );
        },
        getOwnedActor(actorId) {
          const { self } = this;
          return ownedActor(services, self, String(actorId ?? ""));
        },
        getOwnedTimelineClip(clipId) {
          const { self } = this;
          return services.timelineClip?.(self, String(clipId ?? "")) ?? null;
        },
        getOwnedComponent(actorId, componentId) {
          const { self } = this;
          return findComponentById(ownedActor(services, self, String(actorId ?? "")), String(componentId ?? ""));
        },
        callComponentFunction(target, name, args) {
          return callNativeComponentFunction(host, target, String(name ?? ""), args ?? {});
        },
        addComponent(actor, classId, transform) {
          const target = asActor(actor);
          if (!target) return null;
          return services.addComponent?.(target, classId, transform) ?? null;
        },
        spawnActor(classId, transform) {
          const { self } = this;
          return services.spawnActor?.(String(classId), transform, self) ?? null;
        },
        async spawnActorAsync(classId, transform, options) {
          const { self } = this;
          if (!services.spawnActorAsync) throw new Error("This host cannot prepare a cold actor; use a runtime with asset loading");
          const actor = await services.spawnActorAsync(String(classId), transform, self, { blocking: options?.blocking === true });
          if (self?.destroyed) throw Object.assign(new Error("The spawn caller was destroyed"), { name: "AbortError" });
          return actor;
        },
        async beginDeferredSpawnActorAsync(classId, transform, options) {
          const { self } = this;
          if (!services.beginDeferredSpawnAsync) throw new Error("This host cannot defer an actor spawn");
          const actor = await services.beginDeferredSpawnAsync(String(classId), transform, self, { blocking: options?.blocking === true });
          if (self?.destroyed) throw Object.assign(new Error("The spawn caller was destroyed"), { name: "AbortError" });
          return actor;
        },
        finishDeferredSpawnActor(actor) {
          const target = asActor(actor);
          if (!target) return null;
          if (!services.finishDeferredSpawn) throw new Error("This host cannot defer an actor spawn");
          return services.finishDeferredSpawn(target);
        },
        // A destroyed owner's handle would never be released, so it gets none. A host
        // without load handles hands out "" too and fails every wait and state read.
        requestAssetLoad(assets, options) {
          const { self } = this;
          return self?.destroyed ? "" : services.requestAssetLoad?.(assets, self, options) ?? "";
        },
        requestClassLoad(classId, options) {
          const { self } = this;
          return self?.destroyed ? "" : services.requestClassLoad?.(String(classId ?? ""), self, options) ?? "";
        },
        async waitForAssetLoad(handle, options) {
          const { self } = this;
          const result = await services.waitForAssetLoad?.(handle, self, options?.blocking === true) ?? {
            success: false, errorMessage: ASSET_LOADING_UNAVAILABLE,
          };
          if (self?.destroyed) throw Object.assign(new Error("The asset load caller was destroyed"), { name: "AbortError" });
          return result;
        },
        unloadAsset(asset, options) {
          const { self } = this;
          return services.unloadAsset?.(String(asset ?? ""), self, options);
        },
        async prepareAssets(assets) {
          const { self } = this;
          if (self?.destroyed) throw Object.assign(new Error("The asset consumer was destroyed"), { name: "AbortError" });
          if (!services.prepareAssets) throw new Error("This host cannot prepare cold assets");
          await services.prepareAssets(assets, self);
          if (self?.destroyed) throw Object.assign(new Error("The asset consumer was destroyed"), { name: "AbortError" });
        },
        async loadSceneBlocking(target) {
          const { self } = this;
          await services.loadScene?.(target, true);
          await services.waitForSimulation?.(self);
          if (self?.destroyed) throw Object.assign(new Error("The streaming caller was destroyed."), { name: "AbortError" });
        },
        async unloadSceneBlocking(target) {
          const { self } = this;
          await services.unloadScene?.(target, true);
          await services.waitForSimulation?.(self);
          if (self?.destroyed) throw Object.assign(new Error("The streaming caller was destroyed."), { name: "AbortError" });
        },
        getSceneReference() {
          const { self } = this;
          const scene = services.getSceneReference?.(self) ?? null;
          return scene && !scene.destroyed ? scene : null;
        },
        invokeCustomEvent(target, eventName, eventArgs) {
          const { deltaSeconds, tickIndex } = this;
          const tick = this.#tick;
          const receiver = target as EngineObject | null | undefined;
          if (!receiver || !host.canInvokeOwner(receiver) || typeof eventName !== "string" || !eventName) return;
          // The event runs inside the caller's frame: delta, tick index and input
          // follow it. Caller extras (Behaviour Tree, Animation Graph) belong to
          // the calling script and stay behind.
          const dispatch = (object: EngineObject, componentId?: string) => {
            const loaded = host.eventScriptsFor(object.classId, eventName, object, componentId);
            if (!loaded || !host.canInvokeOwner(object)) return;
            host.dispatchEvent(loaded, eventName, object, deltaSeconds, tickIndex, eventArgs ?? {}, tick, undefined, componentId);
          };
          dispatch(receiver);
          if (receiver instanceof ActorComponent && receiver.owner) dispatch(receiver.owner, receiver.guid);
        },
        callDispatcher(owner, name, values) {
          host.dispatchers.call(
            owner,
            name,
            Array.isArray(values) ? values : [],
            (delegate, args) => {
              if (delegate.kind === "function") void this.invokeFunction(delegate.object, delegate.name, args);
              else this.invokeCustomEvent(delegate.object, delegate.name, args);
            },
            () => services.log(
              "error",
              "Script",
              `Event Dispatcher "${name}" was called inside its own listeners more than ${DISPATCHER_MAX_DEPTH} times; the deeper Calls were skipped.`,
            ),
          );
        },
        invokeEvent(classId, eventName, eventArgs) {
          const { self, deltaSeconds, tickIndex } = this;
          const tick = this.#tick, extras = this.#extras;
          if (self && !host.canInvokeOwner(self)) return;
          if (typeof classId !== "string" || !classId.trim()) return;
          if (typeof eventName !== "string" || !eventName) return;
          // Call Parent passes the parent class; resolve from there, never from self.
          const loaded = host.eventScriptsFor(classId.trim(), eventName, self);
          if (!loaded) return;
          host.dispatchEvent(
            loaded,
            eventName,
            self,
            deltaSeconds,
            tickIndex,
            eventArgs ?? {},
            tick,
            extras,
          );
        },
        invokeFunction(target, functionName, fnArgs) {
          const { deltaSeconds, tickIndex } = this;
          const contextOwner = this.#owner, tick = this.#tick, extras = this.#extras;
          if (typeof functionName !== "string" || !functionName) {
            if (extras?.saveMigrationData) throw new SaveGameError("incompatible", "A save migration called an invalid function.");
            return {};
          }
          let loaded: LoadedScript[] | undefined;
          let receiver: EngineObject | null = null;
          if (typeof target === "string") {
            loaded = host.functionScriptsFor(target, functionName);
          } else {
            const object = target as EngineObject | null | undefined;
            if (!object || !host.canInvokeOwner(object)) {
              if (extras?.saveMigrationData) throw new SaveGameError("incompatible", "A save migration function's owner is unavailable.");
              return {};
            }
            receiver = object;
            loaded = host.functionScriptsFor(object.classId, functionName);
          }
          if (!loaded) {
            if (extras?.saveMigrationData) throw new SaveGameError("incompatible", `Save migration function “${functionName}” is missing.`);
            return {};
          }
          const scripts = loaded;
          const nestedExtras = receiver ? extras : { ...extras, callerOwner: contextOwner };
          const failed = (error: unknown): void => {
            if (extras?.saveMigrationData || isInfiniteLoopError(error)) throw error;
            host.reportLatentError(error, receiver);
          };
          const record = (value: unknown): Record<string, unknown> =>
            (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
          // Every module exporting the function runs in order. A latent one is
          // awaited before the next starts; the last result is returned. A
          // continuation stops once its receiver may no longer run.
          const run = (start: number, result: unknown): Record<string, unknown> | Promise<Record<string, unknown>> => {
            if (start > 0 && receiver && !host.canInvokeOwner(receiver)) return record(result);
            for (let index = start; index < scripts.length; index++) {
              const entry = scripts[index]!;
              const fn = entry.exports[functionName];
              if (typeof fn !== "function") continue;
              const nested = new NestedContext(receiver, deltaSeconds, tickIndex, fnArgs ?? {}, tick, nestedExtras, entry.script.assetGuid);
              try {
                const value = host.invokeEntry(receiver, entry.script, functionName, () => (fn as (ctx: ScriptContext) => unknown)(nested));
                if (value instanceof Promise) {
                  const previous = result;
                  return value.then(
                    (resolved) => run(index + 1, resolved),
                    (error) => {
                      failed(error);
                      return run(index + 1, previous);
                    },
                  );
                }
                result = value;
              } catch (error) {
                failed(error);
              }
            }
            return record(result);
          };
          return run(0, {});
        },
        isActionHeld(action) {
          const tick = this.#tick;
          return tick?.isActionHeld?.(action) ?? false;
        },
        wasActionPressed(action) {
          const tick = this.#tick;
          return tick?.wasActionPressed?.(action) ?? false;
        },
        wasActionReleased(action) {
          const tick = this.#tick;
          return tick?.wasActionReleased?.(action) ?? false;
        },
        getPressedKeys() {
          const tick = this.#tick;
          return tick?.getPressedKeys?.() ?? [];
        },
        getAxis(axis) {
          const tick = this.#tick;
          return tick?.getAxis?.(axis) ?? 0;
        },
        getAxis2D(axis) {
          const tick = this.#tick;
          return tick?.getAxis2D?.(axis) ?? { x: 0, y: 0 };
        },
        getCursorPosition() {
          const tick = this.#tick;
          return tick?.getCursorPosition?.() ?? { x: 0, y: 0, pressed: false };
        },
        getTouches() {
          const tick = this.#tick;
          return tick?.getTouches?.() ?? [];
        },
        getTouchEvents() {
          const tick = this.#tick;
          return tick?.getTouchEvents?.() ?? [];
        },
        getDeviceMotion() {
          const tick = this.#tick;
          return tick?.getDeviceMotion?.() ?? idleDeviceMotion();
        },
        calibrateTilt() {
          const tick = this.#tick;
          return tick?.calibrateTilt?.();
        },
        setCursorVisible(visible) {
          const tick = this.#tick;
          if (services.setCursorVisible) {
            services.setCursorVisible(visible === true);
          } else {
            tick?.setCursorVisible?.(visible === true);
          }
        },
        setGamepadRumble(gamepadIndex, intensity, durationMs) {
          const tick = this.#tick;
          tick?.setGamepadRumble?.(gamepadIndex, intensity, durationMs);
        },
        vibrateDevice(durationMs) {
          const tick = this.#tick;
          return tick?.vibrateDevice?.(durationMs);
        },
        sampleWater(position, waterActor) {
          const contextOwner = this.#owner;
          if (waterActor?.destroyed) return { ...emptyWaterSample(), actor: null };
          const sample = services.sampleWater?.(position, waterActor?.guid ?? null, contextOwner);
          return sample ? { ...sample, actor: resolveLiveActor(services, sample.actorId) } : { ...emptyWaterSample(), actor: null };
        },
        lineTrace(start, end, channel, options) {
          const contextOwner = this.#owner;
          const ignoreActorIds = [
            ...new Set(
              (options?.actorsToIgnore ?? [])
                .filter((actor): actor is Actor => actor instanceof Actor && !actor.destroyed)
                .map((actor) => actor.guid),
            ),
          ];
          const hit = services.lineTrace?.(start, end, { ignoreActorIds, ...(channel ? { channel } : {}) }, contextOwner) ?? {
            hit: false,
            location: null,
            actorId: null,
            normal: null,
            distance: 0,
            bodyId: null,
          };
          if (services.traceDebugDraw !== false && options?.drawDebug !== false) {
            const location = hit.hit === true ? hit.location : null;
            services.drawDebug?.({
              kind: "line",
              start,
              end: location ?? end,
              thickness: 1,
              color: location
                ? { x: 0, y: 1, z: 0, w: 1 }
                : { x: 1, y: 0, z: 0, w: 1 },
              duration: 0,
            });
            if (location) {
              services.drawDebug?.({
                kind: "circle",
                center: location,
                radius: 0.08,
                rotation: lookAtRotator({ x: 0, y: 0, z: 0 }, hit.normal),
                color: { x: 1, y: 0, z: 0, w: 1 },
                duration: 0,
              });
            }
          }
          return {
            hit: hit.hit === true,
            location: hit.location ?? null,
            normal: hit.normal ?? null,
            distance: hit.distance ?? 0,
            actor: resolveLiveActor(services, hit.actorId),
          };
        },
        projectCursorToScene(channel, options) {
          const contextOwner = this.#owner;
          return screenProjection(services.projectCursorToScene?.(channel, options, contextOwner));
        },
        projectTouchToScene(finger, channel, options) {
          const contextOwner = this.#owner;
          return screenProjection(services.projectTouchToScene?.(finger, channel, options, contextOwner));
        },
        sphereOverlap(center, radius, channel) {
          const contextOwner = this.#owner;
          const overlap = services.sphereOverlap?.(center, radius, channel, contextOwner) ?? {
            actorIds: [],
            bodyIds: [],
          };
          return {
            actorIds: overlap.actorIds,
            bodyIds: overlap.bodyIds,
            actors: resolveLiveActors(services, overlap.actorIds),
          };
        },
        shapeSweep(shape, start, end, channel, actorsToIgnore) {
          const contextOwner = this.#owner;
          const hit = services.shapeSweep?.(shape, start, end, queryOptions(channel, actorsToIgnore), contextOwner) ?? {
            hit: false,
            location: null,
            normal: null,
            distance: 0,
            actorId: null,
            bodyId: null,
          };
          return {
            hit: hit.hit === true,
            location: hit.location ?? null,
            normal: hit.normal ?? null,
            distance: hit.distance ?? 0,
            actor: resolveLiveActor(services, hit.actorId),
          };
        },
        multiTrace(shape, start, end, channel, actorsToIgnore) {
          const contextOwner = this.#owner;
          return (services.multiTrace?.(shape, start, end, queryOptions(channel, actorsToIgnore), contextOwner) ?? [])
            .map((hit) => ({ ...hit, actor: resolveLiveActor(services, hit.actorId) }))
            // An actor destroyed by an earlier handler this tick is no hit.
            .filter((hit) => hit.actor !== null)
            .map((hit) => ({
              Hit: true,
              Location: hit.location ?? { x: 0, y: 0, z: 0 },
              Normal: hit.normal ?? { x: 0, y: 0, z: 0 },
              Actor: hit.actor,
              Distance: hit.distance ?? 0,
            }));
        },
        shapeOverlap(shape, pose, channel) {
          const contextOwner = this.#owner;
          return resolveLiveActors(services, services.shapeOverlap?.(shape, pose, queryOptions(channel, undefined), contextOwner)?.actorIds ?? []);
        },
        addImpulse(actor, impulse, strength) {
          const target = asActor(actor);
          if (!target) return;
          services.addImpulse?.(target, impulse, strength);
        },
        moveCharacter(actor, translation, offset) {
          const { deltaSeconds } = this;
          const target = asActor(actor);
          if (!target) return;
          services.moveCharacter?.(
            target,
            translation,
            deltaSeconds,
            offset,
          );
        },
        playSound(asset, volume) {
          const { self } = this;
          return playScriptSound(self, asset, volume, {});
        },
        playSoundAtLocation(asset, location, volume, pitch) {
          const { self } = this;
          const position = finiteVector(location as never, 0);
          const multiplier = Number(pitch ?? 1);
          return playScriptSound(self, asset, volume, {
            ...(position ? { location: position } : {}),
            pitch: Number.isFinite(multiplier) ? multiplier : 1,
          });
        },
        spawnParticlesAtLocation(system, location, rotation, scale, autoDestroy = true) {
          const { self } = this;
          return services.spawnParticleEffect?.({ systemGuid: String(system ?? ""), location, rotation, scale, autoDestroy: autoDestroy !== false }, self) ?? null;
        },
        spawnParticlesAttached(system, attachTo, bone, locationOffset, rotationOffset, autoDestroy = true) {
          const { self } = this;
          return services.spawnParticleEffect?.({ systemGuid: String(system ?? ""), attachTo: attachTo ?? null, bone: String(bone ?? ""),
            location: locationOffset, rotation: rotationOffset, autoDestroy: autoDestroy !== false }, self) ?? null;
        },
        async createSceneLayerAsync(assetGuid, zOrder) {
          const { self } = this;
          if (!services.createSceneLayerAsync) throw new Error("This host cannot prepare a cold SceneLayer");
          const layer = await services.createSceneLayerAsync(String(assetGuid ?? ""), Number(zOrder) || 0, self);
          if (self?.destroyed) throw Object.assign(new Error("The SceneLayer caller was destroyed"), { name: "AbortError" });
          return layer;
        },
        moveTo(actor, destination) {
          const target = asActor(actor);
          if (!target) return;
          services.moveTo?.(target, destination);
        },
        stopMovement(actor) {
          const target = asActor(actor);
          if (!target) return;
          services.stopMovement?.(target);
        },
      };
      Object.assign(Context.prototype, methods, { random });
      Object.setPrototypeOf(Context.prototype, host.hostMembers);
    }
  }
  return Context as unknown as ScriptContextConstructor;
}


function ownedActor(services: ScriptHostServices, owner: EngineObject | null, actorId: string): Actor | null {
  return ownedSceneActor(owner, actorId, (guid) => services.findActor?.(guid), (scene, id) => services.resolveInstanceId?.(scene, id) ?? id);
}
