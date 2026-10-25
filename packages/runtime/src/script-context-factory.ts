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
  type Rng,
  type SaveGameMigrationData,
  type SaveGameValue,
} from "@haptic/core";
import {
  Actor,
  ActorComponent,
  EngineObject,
  MaterialObject,
  Scene,
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
  HostContextMembers,
  LoadedScript,
  ScreenProjection,
  ScriptContext,
  ScriptExtras,
} from "./script-context-types";
import type { ScriptDebugTrace } from "./script-debug";
import {
  asActor,
  asActorComponent,
  asScriptVec3,
  finiteQuat,
  finiteRotator,
  finiteVector,
  findComponentById,
  findComponentByIdFromTarget,
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
 * What `createScriptContext` reads from its `ScriptHost`: the host builds it once from wrappers over its
 * private state, which contexts reach only through these members.
 */
export interface ScriptContextHost extends ComponentFunctionHost {
  readonly rng: Rng;
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

/**
 * The body of `ScriptHost.createContext`, which documents the context. Every per-call member is assigned
 * here, in the order `Object.keys(ctx)` lists them; the host-lifetime members come from `host.hostMembers`.
 */
export function createScriptContext(
  host: ScriptContextHost,
  self: EngineObject | null,
  deltaSeconds: number,
  tickIndex: number,
  commandArgs: Record<string, unknown> = {},
  tick?: TickContext,
  extras?: ScriptExtras,
  flowNamespace = "",
): ScriptContext {
  const services = host.services;
  const store = extras?.variableStore ?? self;
  // Also the Scene query caller: queries answer from this object's world, so
  // a static Function Library call keeps its caller's.
  const contextOwner = self ?? extras?.callerOwner ?? null;
  const migrationData = (): SaveGameMigrationData => {
    const data = extras?.saveMigrationData ?? commandArgs.saveMigrationData as SaveGameMigrationData | undefined;
    if (!data) throw new SaveGameError("invalid", "Migration fields are available only inside Event Save Migration.");
    return data;
  };
  // Created from the host members and filled in place: a literal given its prototype afterwards
  // (`Object.setPrototypeOf`) costs about twice as much per context in V8. The block only groups the
  // assignments; they are the context's own members, and their order is the order `Object.keys(ctx)` lists.
  const context = Object.create(host.hostMembers) as ScriptContext;
  {
    context.registerSaveMigration = (fromVersion, migrate) => {
      const service = requireSaveGameService(services);
      if (typeof migrate === "function") service.registerMigration(fromVersion, migrate);
      else {
        if (!self) throw new SaveGameError("invalid", "Visual save migrations require an owning object.");
        service.registerMigration(fromVersion, (snapshot) => host.invokeSaveMigration(self, migrate, snapshot));
      }
    };
    // Actor identities remain IDs here: staged actors do not exist yet.
    context.getSaveMigrationField = (id) => migrationData().fields[id] ?? null;
    context.setSaveMigrationField = (id, value) => {
      const fields = cloneSaveGameValue({ [id]: value }) as Record<string, SaveGameValue>;
      Object.assign(migrationData().fields, fields);
    };
    context.data = services.data ?? EMPTY_DATA;
    context.readDataEntryAsync = async (tree, path, definitionGuid) => {
      if (services.prepareAssets) await services.prepareAssets([tree, ...(definitionGuid ? [definitionGuid] : [])], self);
      else if (!services.data?.hasTree(tree)) throw new Error(`Data Tree ${tree} is not prepared; this host cannot load cold data.`);
      if (self?.destroyed) throw Object.assign(new Error("The data reader was destroyed"), { name: "AbortError" });
      return services.data?.readEntry(tree, path, definitionGuid) ?? null;
    };
    context.editorData = services.editorData ?? UNAVAILABLE_EDITOR_DATA;
    context.self = self;
    context.deltaSeconds = deltaSeconds;
    context.tickIndex = tickIndex;
    // The instance is `self`, except for an Animation Graph's scripts, which run on the actor
    // while the graph's instance is its component (the variable store).
    context.debugTrace = host.debugTraceFor(store);
    context.commandArgs = commandArgs;
    context.args = commandArgs;
    context.animFacts = extras?.animFacts;
    context.animExitTimeReached = (exitTime) =>
      extras?.animFacts ? animExitTimeReached(extras.animFacts, Number(exitTime)) : false;
    context.flowState = (nodeId: string) =>
      host.flowStateFor(contextOwner, String(nodeId), flowNamespace);
    context.reportCommand = (success, output) => {
      if (extras?.commandResult) Object.assign(extras.commandResult, { success: Boolean(success), output: String(output) });
    };
    // Own per context, as before: a script that patches its `ctx.random` changes only that context. Every
    // context draws from the host RNG, in call order.
    context.random = {
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
    context.getVariable = (name) => store?.getVariable(name);
    context.variableReference = (target, name, implicitSelf = false) => {
      const object = implicitSelf ? store : target;
      if (!object || typeof name !== "string" || !name ||
        (object instanceof EngineObject && (object.destroyed || isReadOnlyTweenProperty(object, name)))) return null;
      return {
        identity: object, property: `variable:${name}`,
        owner: object instanceof EngineObject ? object : contextOwner ?? undefined,
        set: (value) => {
          if (object instanceof EngineObject) context.setVariableOn(object, name, tweenStorageValue(object, name, value));
          else object.setVariable(name, value);
        },
      };
    };
    context.tweenValue = (reference, type, a, b, duration, curve) => {
      if (!reference) return Promise.resolve(false);
      if (!services.tween) return Promise.reject(new Error("Tween actions are unavailable in this script host."));
      return services.tween({ reference, type, a, b, duration, curve, owner: contextOwner }).then(completed =>
        completed && tweenOwnerAlive(contextOwner) && tweenOwnerAlive(reference.owner) && services.isTweenSessionActive?.() !== false);
    };
    context.tweenProperty = (target, property, type, a, b, duration, curve, space) => {
      const reference = propertyTweenReference(target, property, type, space, services);
      return context.tweenValue(reference, type, a, b, duration, curve);
    };
    context.setVariable = (name, value) => {
      if (store instanceof Actor && name === "parentId") {
        writeParentId(services, store, value);
        return;
      }
      store?.setVariable(name, value);
    };
    context.getVariableFrom = (object, name) => {
      if (object instanceof ActorComponent && object.classId === "2DRichTextComponent" &&
        (name === "appearProgress" || name === "isRevealed")) {
        const progress = services.text2DAppearProgress?.(object) ?? 1;
        return name === "isRevealed" ? progress === 1 : progress;
      }
      if (object instanceof ActorComponent && object.classId === "RenderTargetCaptureComponent" && name === "actorIds") {
        return host.canInvokeOwner(object) ? captureActorReferences(object, (id) => services.findActor?.(id)) : [];
      }
      return object?.getVariable(name);
    };
    context.setVariableOn = (object, name, value) => {
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
    };
    context.setMeshMaterialAsync = async (component, materialGuid) => {
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
        const material = context.setMeshMaterial(target, guid);
        host.materials.retainMaterialPreload(target, "material", { id: preload, guid });
        preload = "";
        return material;
      } finally {
        if (preload) services.releaseAcquiredAssets?.(preload);
      }
    };
    context.setMaterialTextureParameterAsync = async (material, name, value) => {
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
        context.setMaterialTextureParameter(material, name, guid || null);
        host.materials.retainMaterialPreload(material, key, { id: preload, guid });
        preload = "";
      } finally {
        if (preload) services.releaseAcquiredAssets?.(preload);
      }
    };
    context.destroyActor = (actor) => {
      const target = asActor(actor);
      if (target) services.destroyActor(target);
    };
    context.setActorLocation = (actor, location) => {
      const target = transformTarget(actor);
      const position = finiteVector(location, 0);
      if (!target || !position) return;
      Object.assign(target.transform.position, position);
      services.teleportActor?.(target);
    };
    context.addActorWorldOffset = (actor, offset) => {
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
    };
    context.setActorRotation = (actor, rotation) => {
      const target = transformTarget(actor);
      const rotator = finiteRotator(rotation);
      if (!target || !rotator) return;
      Object.assign(target.transform.rotation, rotatorToQuat(rotator));
      services.teleportActor?.(target);
    };
    context.setActorScale = (actor, scale) => {
      const target = transformTarget(actor);
      const next = finiteVector(scale, 1);
      if (!target || !next) return;
      Object.assign(target.transform.scale, next);
      services.teleportActor?.(target);
    };
    context.setActorTransform = (actor, transform, options) => {
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
    };
    context.attachToBone = (actor, target, boneName) => {
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
    };
    context.executeConsoleCommandAsync = async (command) => {
      const result = await (services.executeConsoleCommandAsync?.(String(command ?? "")) ?? services.executeConsoleCommand(String(command ?? "")));
      if (self?.destroyed) throw Object.assign(new Error("The console command caller was destroyed"), { name: "AbortError" });
      return result;
    };
    context.delay = (seconds) => services.delay(seconds, self);
    context.callInterface = (target, interfaceGuid, method, args) => {
      const registry = services.interfaceRegistry;
      if (!registry) return {};
      const receiver = target as InterfaceDispatchTarget | null | undefined;
      // A missing or unadmitted receiver runs no handler and reads the pin defaults.
      const dispatchTarget: InterfaceDispatchTarget = !receiver ? NO_INTERFACE_RECEIVER
        : !(receiver instanceof EngineObject) || host.canInvokeOwner(receiver) ? receiver
          : { guid: receiver.guid, classId: receiver.classId, implementedInterfaces: receiver.implementedInterfaces };
      return host.withInterfaceCaller({ deltaSeconds, tickIndex, tick }, () =>
        dispatchInterface(registry, dispatchTarget, String(interfaceGuid), String(method), args ?? {}));
    };
    context.getComponent = (actor, classId) =>
      asActor(actor)?.components.find((c) => c.classId === classId && !c.destroyed) ??
      null;
    context.getComponentById = (actor, componentId) => {
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
    };
    context.callComponentFunction = (target, name, args) =>
      callNativeComponentFunction(host, target, String(name ?? ""), args ?? {});
    context.addComponent = (actor, classId, transform) => {
      const target = asActor(actor);
      if (!target) return null;
      return services.addComponent?.(target, classId, transform) ?? null;
    };
    context.spawnActor = (classId, transform) =>
      services.spawnActor?.(String(classId), transform, self) ?? null;
    context.spawnActorAsync = async (classId, transform) => {
      if (!services.spawnActorAsync) throw new Error("This host cannot prepare a cold actor; use a runtime with asset loading");
      const actor = await services.spawnActorAsync(String(classId), transform, self);
      if (self?.destroyed) throw Object.assign(new Error("The spawn caller was destroyed"), { name: "AbortError" });
      return actor;
    };
    // A destroyed owner's handle would never be released, so it gets none. A host
    // without load handles hands out "" too and fails every wait and state read.
    context.requestAssetLoad = (assets, options) => self?.destroyed ? "" : services.requestAssetLoad?.(assets, self, options) ?? "";
    context.requestClassLoad = (classId, options) => self?.destroyed ? "" : services.requestClassLoad?.(String(classId ?? ""), self, options) ?? "";
    context.waitForAssetLoad = async (handle, options) => {
      const result = await services.waitForAssetLoad?.(handle, self, options?.blocking === true) ?? {
        success: false, errorMessage: ASSET_LOADING_UNAVAILABLE,
      };
      if (self?.destroyed) throw Object.assign(new Error("The asset load caller was destroyed"), { name: "AbortError" });
      return result;
    };
    context.unloadAsset = (asset, options) => services.unloadAsset?.(String(asset ?? ""), self, options);
    context.prepareAssets = async (assets) => {
      if (self?.destroyed) throw Object.assign(new Error("The asset consumer was destroyed"), { name: "AbortError" });
      if (!services.prepareAssets) throw new Error("This host cannot prepare cold assets");
      await services.prepareAssets(assets, self);
      if (self?.destroyed) throw Object.assign(new Error("The asset consumer was destroyed"), { name: "AbortError" });
    };
    context.loadSceneBlocking = async (target) => {
      await services.loadScene?.(target, true);
      await services.waitForSimulation?.(self);
      if (self?.destroyed) throw Object.assign(new Error("The streaming caller was destroyed."), { name: "AbortError" });
    };
    context.unloadSceneBlocking = async (target) => {
      await services.unloadScene?.(target, true);
      await services.waitForSimulation?.(self);
      if (self?.destroyed) throw Object.assign(new Error("The streaming caller was destroyed."), { name: "AbortError" });
    };
    context.getSceneReference = () => {
      const scene = services.getSceneReference?.(self) ?? null;
      return scene && !scene.destroyed ? scene : null;
    };
    context.invokeCustomEvent = (target, eventName, eventArgs) => {
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
    };
    context.invokeEvent = (classId, eventName, eventArgs) => {
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
    };
    context.invokeFunction = (target, functionName, fnArgs) => {
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
          const nested = createScriptContext(
            host,
            receiver,
            deltaSeconds,
            tickIndex,
            fnArgs ?? {},
            tick,
            nestedExtras,
            entry.script.assetGuid,
          );
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
    };
    context.isActionHeld = (action) => tick?.isActionHeld?.(action) ?? false;
    context.inputBindings = services.inputBindings;
    context.getInputState = services.getInputState;
    context.wasActionPressed = (action) => tick?.wasActionPressed?.(action) ?? false;
    context.wasActionReleased = (action) =>
      tick?.wasActionReleased?.(action) ?? false;
    context.getPressedKeys = () => tick?.getPressedKeys?.() ?? [];
    context.getAxis = (axis) => tick?.getAxis?.(axis) ?? 0;
    context.getAxis2D = (axis) => tick?.getAxis2D?.(axis) ?? { x: 0, y: 0 };
    context.getCursorPosition = () =>
      tick?.getCursorPosition?.() ?? { x: 0, y: 0, pressed: false };
    context.getTouches = () => tick?.getTouches?.() ?? [];
    context.getTouchEvents = () => tick?.getTouchEvents?.() ?? [];
    context.getDeviceMotion = () => tick?.getDeviceMotion?.() ?? idleDeviceMotion();
    context.calibrateTilt = () => tick?.calibrateTilt?.();
    context.setCursorVisible = (visible) => {
      if (services.setCursorVisible) {
        services.setCursorVisible(visible === true);
      } else {
        tick?.setCursorVisible?.(visible === true);
      }
    };
    context.setGamepadRumble = (gamepadIndex, intensity, durationMs) => {
      tick?.setGamepadRumble?.(gamepadIndex, intensity, durationMs);
    };
    context.vibrateDevice = (durationMs) => tick?.vibrateDevice?.(durationMs);
    context.gamepadConnections = tick?.gamepadConnections ?? [];
    context.sampleWater = (position, waterActor) => {
      if (waterActor?.destroyed) return { ...emptyWaterSample(), actor: null };
      const sample = services.sampleWater?.(position, waterActor?.guid ?? null, contextOwner);
      return sample ? { ...sample, actor: resolveLiveActor(services, sample.actorId) } : { ...emptyWaterSample(), actor: null };
    };
    context.lineTrace = (start, end, channel, options) => {
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
    };
    const screenProjection = (hit: ReturnType<NonNullable<ScriptHostServices["projectCursorToScene"]>> | undefined): ScreenProjection => ({
      hit: hit?.hit === true,
      location: hit?.location ?? null,
      normal: hit?.normal ?? null,
      distance: hit?.distance ?? 0,
      actor: resolveLiveActor(services, hit?.actorId ?? null),
      worldOrigin: hit?.worldOrigin ?? { x: 0, y: 0, z: 0 },
      worldDirection: hit?.worldDirection ?? { x: 0, y: 0, z: 0 },
    });
    context.projectCursorToScene = (channel, options) =>
      screenProjection(services.projectCursorToScene?.(channel, options, contextOwner));
    context.projectTouchToScene = (finger, channel, options) =>
      screenProjection(services.projectTouchToScene?.(finger, channel, options, contextOwner));
    context.sphereOverlap = (center, radius, channel) => {
      const overlap = services.sphereOverlap?.(center, radius, channel, contextOwner) ?? {
        actorIds: [],
        bodyIds: [],
      };
      return {
        actorIds: overlap.actorIds,
        bodyIds: overlap.bodyIds,
        actors: resolveLiveActors(services, overlap.actorIds),
      };
    };
    context.shapeSweep = (shape, start, end, channel) => {
      const hit = services.shapeSweep?.(shape, start, end, channel, contextOwner) ?? {
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
    };
    context.addImpulse = (actor, impulse, strength) => {
      const target = asActor(actor);
      if (!target) return;
      services.addImpulse?.(target, impulse, strength);
    };
    context.moveCharacter = (actor, translation, offset) => {
      const target = asActor(actor);
      if (!target) return;
      services.moveCharacter?.(
        target,
        translation,
        deltaSeconds,
        offset,
      );
    };
    context.playSound = (asset, volume) => {
      services.playSound?.(String(asset ?? ""), Number(volume ?? 1), {
        emitterActorGuid: self?.guid ?? null,
      });
    };
    context.playParticles = (actor) => {
      const target = asActor(actor);
      if (!target) return;
      services.setParticlePlaying?.(target.guid, true);
    };
    context.stopParticles = (actor) => {
      const target = asActor(actor);
      if (!target) return;
      services.setParticlePlaying?.(target.guid, false);
    };
    context.createSceneLayerAsync = async (assetGuid, zOrder) => {
      if (!services.createSceneLayerAsync) throw new Error("This host cannot prepare a cold SceneLayer");
      const layer = await services.createSceneLayerAsync(String(assetGuid ?? ""), Number(zOrder) || 0, self);
      if (self?.destroyed) throw Object.assign(new Error("The SceneLayer caller was destroyed"), { name: "AbortError" });
      return layer;
    };
    context.moveTo = (actor, destination) => {
      const target = asActor(actor);
      if (!target) return;
      services.moveTo?.(target, destination);
    };
    context.stopMovement = (actor) => {
      const target = asActor(actor);
      if (!target) return;
      services.stopMovement?.(target);
    };
    context.btFinish = extras?.btFinish ?? NO_BT_HOOK;
    context.btEvaluate = extras?.btEvaluate ?? NO_BT_HOOK;
    context.getBlackboard = extras?.getBlackboard ?? NO_BT_HOOK;
    context.setBlackboard = extras?.setBlackboard ?? NO_BT_HOOK;
  }
  return context;
}
