import { formatValue } from "@babylonslate/core";
import type { ScriptBundleEntry } from "@babylonslate/bridge";
import {
  Actor,
  ActorComponent,
  BObject,
  UserInterface,
  Widget,
  dispatchInterface,
  interfaceHandlerKey,
  type ClassRegistry,
  type InterfaceDispatchTarget,
  type InterfaceRegistry,
  type LifecycleHooks,
  type TickContext,
} from "@babylonslate/object-model";
import type {
  ColliderShape,
  HitResult,
  OverlapResult,
  PhysicsTransform,
  Vec3,
} from "@babylonslate/physics";
import type {
  AnimStateFacts,
  AnimTransitionDecision,
} from "@babylonslate/anim-graph";
import { loadCompiledModule, type CompiledModuleExports } from "./module-loader";
import type { LogSeverity } from "./log-ring";
import { isInfiniteLoopError } from "@babylonslate/debugger";

export type AnimGraphControl = {
  getVariable(name: string): unknown;
  setVariable(name: string, value: unknown): void;
  getCurrentState(): { id: string; name: string } | null;
  jumpToState(state: string): void;
};

export type ScriptColor = { x: number; y: number; z: number; w: number };

/**
 * Engine services a compiled graph calls through `ctx`. The host implements the
 * subsystems that exist today; the rest are inert stubs so a graph that uses a
 * node from a later phase runs instead of throwing.
 */
export interface ScriptHostServices {
  /** When set, `ctx.callInterface` uses P3 dispatch (pin defaults on miss). */
  interfaceRegistry?: InterfaceRegistry;
  /** Live-object `ctx.isA` uses ClassRegistry ancestry, not string equality. */
  classRegistry?: ClassRegistry;
  log(severity: LogSeverity, category: string, message: string): void;
  addComponent?(
    actor: Actor | null | undefined,
    classId: string,
  ): unknown;
  animGraphControl?(self: BObject | null | undefined): AnimGraphControl | null;
  spawnActor?(classId: string): Actor | null;
  print(
    message: string,
    key: string,
    duration: number,
    color: ScriptColor,
  ): void;
  drawDebug?(payload: Record<string, unknown>): void;
  destroyActor(actor: Actor | null | undefined): void;
  executeConsoleCommand(command: string): { success: boolean; output: string };
  delay(seconds: number): Promise<void>;
  reportError(error: unknown): void;
  reportCommand?(success: boolean, output: string): void;
  /** Debugger loop guard; omitted in release players. */
  checkInfiniteLoop?(): void;
  lineTrace?(start: Vec3, end: Vec3): HitResult;
  sphereOverlap?(center: Vec3, radius: number): OverlapResult;
  shapeSweep?(
    shape: ColliderShape,
    start: PhysicsTransform,
    end: PhysicsTransform,
  ): HitResult;
  addImpulse?(
    actor: Actor | null | undefined,
    impulse: Vec3,
    strength?: number,
  ): void;
  moveCharacter?(
    actor: Actor | null | undefined,
    translation: Vec3,
    dt: number,
    offset?: number,
  ): void;
  setWidgetVisible?(widget: Widget | string, visible: boolean): void;
  applyUserInterface?(classIdOrGuid: string): UserInterface | null;
  removeUserInterface?(
    instance: UserInterface | string | null | undefined,
  ): void;
  changeScene?(scene: string): void;
  playSound?(
    asset: string,
    volume?: number,
    options?: {
      emitterActorGuid?: string | null;
      loop?: boolean;
      voiceId?: string;
    },
  ): void;
  setParticlePlaying?(actorGuid: string, playing: boolean): void;
  setChannelVolume?(channelGuid: string, volume: number): void;
  setGlobalVolume?(volume: number): void;
  setRenderResolution?(width: number, height: number): void;
  setInputMode?(mode: string): void;
  possessCamera?(target: unknown): void;
  updateIllumination?(target: unknown): void;
  findPathTo?(
    from: Vec3,
    to: Vec3,
  ): Vec3[];
  moveTo?(actor: Actor | null | undefined, destination: Vec3): void;
  stopMovement?(actor: Actor | null | undefined): void;
  isPathValid?(from: Vec3, to: Vec3): boolean;
  getClosestNavigablePoint?(point: Vec3): Vec3 | null;
  getRandomPointInRadius?(center: Vec3, radius: number): Vec3 | null;
  addObstacle?(kind: string, pose: Vec3, size: Vec3): string;
  removeObstacle?(id: string): void;
}

export interface ScriptContext {
  self: BObject | null;
  deltaSeconds: number;
  tickIndex: number;
  formatValue(value: unknown): string;
  checkInfiniteLoop(): void;
  log(severity: LogSeverity, category: string, message: string): void;
  print(
    message: string,
    key: string,
    duration: number,
    color: ScriptColor,
  ): void;
  drawDebug(payload: Record<string, unknown>): void;
  getVariable(name: string): unknown;
  setVariable(name: string, value: unknown): void;
  getVariableFrom(target: BObject | null | undefined, name: string): unknown;
  setVariableOn(
    target: BObject | null | undefined,
    name: string,
    value: unknown,
  ): void;
  destroyActor(actor: BObject | null | undefined): void;
  setActorLocation(
    actor: BObject | null | undefined,
    location: { x: number; y: number; z: number },
  ): void;
  executeConsoleCommand(command: string): { success: boolean; output: string };
  delay(seconds: number): Promise<void>;
  commandArgs: Record<string, unknown>;
  /** Alias of `commandArgs` so function Input nodes can read `ctx.args`. */
  args: Record<string, unknown>;
  reportCommand(success: boolean, output: string): void;
  callInterface(
    target: BObject | null | undefined,
    interfaceGuid: string,
    method: string,
    args?: Record<string, unknown>,
  ): unknown;
  getComponent(actor: BObject | null | undefined, classId: string): unknown;
  addComponent(actor: BObject | null | undefined, classId: string): unknown;
  spawnActor(classId: string): Actor | null;
  isA(instance: unknown, classId: string): boolean;
  getAnimGraphVariable(name: string): unknown;
  setAnimGraphVariable(name: string, value: unknown): void;
  getAnimGraphCurrentState(): { id: string; name: string } | null;
  jumpAnimGraphState(state: string): void;
  invokeCustomEvent(
    target: BObject | null | undefined,
    eventName: string,
    args?: Record<string, unknown>,
  ): void;
  /**
   * Run a compiled entry point on a specific classId (Call Parent Event).
   * Uses `self` as the receiver so parent graphs see the child instance.
   */
  invokeEvent(
    classId: string,
    eventName: string,
    args?: Record<string, unknown>,
  ): void;
  invokeFunction(
    target: BObject | string | null | undefined,
    functionName: string,
    args?: Record<string, unknown>,
  ): Record<string, unknown>;
  isActionHeld(action: string): boolean;
  wasActionPressed?(action: string): boolean;
  wasActionReleased?(action: string): boolean;
  getAxis(axis: string): number;
  getAxis2D(axis: string): { x: number; y: number };
  setGamepadRumble?(
    gamepadIndex: number,
    intensity: number,
    durationMs: number,
  ): void;
  gamepadConnections?: ReadonlyArray<{
    gamepadIndex: number;
    connected: boolean;
  }>;
  lineTrace(
    start: Vec3,
    end: Vec3,
  ): {
    hit: boolean;
    location: Vec3 | null;
    actor: string | null;
  };
  sphereOverlap(center: Vec3, radius: number): OverlapResult;
  shapeSweep(
    shape: ColliderShape,
    start: PhysicsTransform,
    end: PhysicsTransform,
  ): HitResult;
  addImpulse(
    actor: BObject | null | undefined,
    impulse: Vec3,
    strength?: number,
  ): void;
  moveCharacter(
    actor: BObject | null | undefined,
    translation: Vec3,
    offset?: number,
  ): void;
  playSound(asset: string, volume?: number): void;
  playParticles(actor?: BObject | null): void;
  stopParticles(actor?: BObject | null): void;
  setChannelVolume(channelGuid: string, volume: number): void;
  setGlobalVolume(volume: number): void;
  getWidget(widgetId: string): Widget | null;
  setWidgetVisible(widget: Widget | string, visible: boolean): void;
  applyUserInterface(classIdOrGuid: string): UserInterface | null;
  removeUserInterface(instance: UserInterface | string | null | undefined): void;
  changeScene(scene: string): void;
  setRenderResolution(width: number, height: number): void;
  setInputMode(mode: string): void;
  possessCamera(target: unknown): void;
  getCameraFieldOfView(target: unknown): number;
  setCameraFieldOfView(target: unknown, fov: number): void;
  getCameraOrthographicSize(target: unknown): number;
  setCameraOrthographicSize(target: unknown, size: number): void;
  setLightEnabled(target: unknown, enabled: boolean): void;
  setLightColor(
    target: unknown,
    color: { x: number; y: number; z: number; w?: number },
  ): void;
  setLightIntensity(target: unknown, intensity: number): void;
  btFinish(result: "success" | "failure"): void;
  btEvaluate(value: boolean): void;
  getBlackboard(key: string): unknown;
  setBlackboard(key: string, value: unknown): void;
  findPathTo(from: Vec3, to: Vec3): Vec3[];
  moveTo(actor: BObject | null | undefined, destination: Vec3): void;
  stopMovement(actor: BObject | null | undefined): void;
  isPathValid(from: Vec3, to: Vec3): boolean;
  getClosestNavigablePoint(point: Vec3): Vec3 | null;
  getRandomPointInRadius(center: Vec3, radius: number): Vec3 | null;
  addObstacle(kind: string, pose: Vec3, size: Vec3): string;
  removeObstacle(id: string): void;
  animFacts?: AnimStateFacts;
}

export type VariableStore = {
  getVariable(name: string): unknown;
  setVariable(name: string, value: unknown): void;
};

type BtScriptExtras = Pick<
  ScriptContext,
  "btFinish" | "btEvaluate" | "getBlackboard" | "setBlackboard"
>;

export type ScriptExtras = Partial<BtScriptExtras> & {
  animFacts?: AnimStateFacts;
  variableStore?: VariableStore;
};

export type CompiledScript = ScriptBundleEntry;

type LoadedScript = {
  script: CompiledScript;
  exports: CompiledModuleExports;
};

/**
 * Loads compiled graph modules and binds their entry points to actor
 * lifecycle hooks. One host per runtime session.
 */
export class ScriptHost {
  private readonly byClassId = new Map<string, LoadedScript[]>();
  private readonly pending = new WeakMap<BObject, Set<string>>();
  private readonly services: ScriptHostServices;
  private commandResult = { success: true, output: "" };

  constructor(services: ScriptHostServices) {
    this.services = services;
  }

  async load(script: CompiledScript): Promise<void> {
    const exports = await loadCompiledModule(script.source, script.assetGuid);
    const list = this.byClassId.get(script.classId) ?? [];
    list.push({ script, exports });
    this.byClassId.set(script.classId, list);
  }

  classIds(): string[] {
    return [...this.byClassId.keys()];
  }

  scriptsFor(classId: string): CompiledScript[] {
    return (this.byClassId.get(classId) ?? []).map((entry) => entry.script);
  }

  /** Lifecycle hooks that run every entry point registered for `classId`. */
  hooksFor(classId: string): LifecycleHooks<BObject> | undefined {
    const loaded = this.byClassId.get(classId);
    if (!loaded || loaded.length === 0) return undefined;
    return {
      onCreation: (self) => {
        this.dispatchEvent(loaded, "onBeginPlay", self, 0, 0);
      },
      onTick: (self, ctx: TickContext) => {
        this.dispatchEvent(
          loaded,
          "onTick",
          self,
          ctx.dt,
          ctx.tickIndex,
          {},
          ctx,
        );
      },
      onDestroyed: (self) => {
        this.dispatchEvent(loaded, "onDestroyed", self, 0, 0);
      },
    };
  }

  invokeCommand(
    classId: string,
    args: Record<string, unknown>,
  ): { success: boolean; output: string } {
    const loaded = this.byClassId.get(classId);
    this.commandResult = { success: true, output: "" };
    if (!loaded || loaded.length === 0) {
      return { success: false, output: `unknown command class ${classId}` };
    }
    this.dispatchEvent(loaded, "onCommandRun", null, 0, 0, args);
    return this.commandResult;
  }

  /** Fire a compiled entry point (Begin Play, Tick, or a custom event name). */
  invokeEvent(
    classId: string,
    event: string,
    self: BObject | null = null,
    args: Record<string, unknown> = {},
  ): void {
    const loaded = this.byClassId.get(classId);
    if (!loaded || loaded.length === 0) return;
    this.dispatchEvent(loaded, event, self, 0, 0, args);
  }

  hasClass(classId: string): boolean {
    return (this.byClassId.get(classId)?.length ?? 0) > 0;
  }

  invokeBtEvent(
    classId: string,
    event: string,
    self: Actor | null,
    deltaSeconds: number,
    extras: BtScriptExtras,
  ): void {
    const loaded = this.byClassId.get(classId);
    if (!loaded || loaded.length === 0) return;
    this.dispatchEvent(loaded, event, self, deltaSeconds, 0, {}, undefined, extras);
  }

  invokeAnimEvent(
    classId: string,
    event: string,
    self: Actor | null,
    deltaSeconds: number,
    extras: ScriptExtras = {},
  ): void {
    const loaded = this.byClassId.get(classId);
    if (!loaded || loaded.length === 0) return;
    this.dispatchEvent(loaded, event, self, deltaSeconds, 0, {}, undefined, extras);
  }

  invokeAnimRule(
    classId: string,
    self: Actor | null,
    extras: ScriptExtras = {},
  ): AnimTransitionDecision | undefined {
    const loaded = this.byClassId.get(classId);
    if (!loaded || loaded.length === 0) return undefined;
    const evaluate = loaded[0]?.exports.evaluate;
    if (typeof evaluate !== "function") return undefined;
    const ctx = this.createContext(self, 0, 0, {}, undefined, extras);
    try {
      const result = (evaluate as (context: ScriptContext) => unknown)(ctx);
      if (!result || typeof result !== "object") return undefined;
      const row = result as { enter?: unknown; exit?: unknown };
      return {
        enter: row.enter !== false,
        exit: row.exit !== false,
      };
    } catch (error) {
      this.services.reportError(error);
      return undefined;
    }
  }

  /**
   * Register compiled function implementations as interface handlers on `object`.
   * Keys match `interfaceHandlerKey` (`guid:method`).
   */
  bindInterfaceHandlers(object: BObject): void {
    const loaded = this.byClassId.get(object.classId);
    if (!loaded || loaded.length === 0) return;
    for (const iface of object.implementedInterfaces) {
      for (const entry of loaded) {
        for (const impl of entry.script.interfaceImplementations ?? []) {
          if (impl.interfaceGuid !== iface) continue;
          const exportName = impl.exportName;
          const key = interfaceHandlerKey(iface, impl.method);
          object.interfaceHandlers.set(key, (args) => {
            const fn = entry.exports[exportName];
            if (typeof fn !== "function") return {};
            const ctx = this.createContext(object, 0, 0, args);
            try {
              const result = (fn as (ctx: ScriptContext) => unknown)(ctx);
              if (result instanceof Promise) {
                void result.catch((error) => this.services.reportError(error));
                return {};
              }
              return (
                result && typeof result === "object" && !Array.isArray(result)
                  ? result
                  : {}
              ) as Record<string, unknown>;
            } catch (error) {
              this.services.reportError(error);
              return {};
            }
          });
        }
      }
    }
  }

  private dispatchEvent(
    loaded: readonly LoadedScript[],
    event: string,
    self: BObject | null,
    deltaSeconds: number,
    tickIndex: number,
    commandArgs: Record<string, unknown> = {},
    tick?: TickContext,
    extras?: ScriptExtras,
  ): void {
    for (const entry of loaded) {
      for (const point of entry.script.entryPoints) {
        if (point.event !== event) continue;
        const fn = entry.exports[point.name];
        if (typeof fn !== "function") continue;
        const key = `${entry.script.assetGuid}:${point.name}`;
        if (self && point.isAsync && this.isPending(self, key)) continue;
        const ctx = this.createContext(
          self,
          deltaSeconds,
          tickIndex,
          commandArgs,
          tick,
          extras,
        );
        try {
          const result = (fn as (ctx: ScriptContext) => unknown)(ctx);
          if (result instanceof Promise) {
            if (self) this.markPending(self, key);
            void result
              .catch((error) => this.services.reportError(error))
              .finally(() => {
                if (self) this.clearPending(self, key);
              });
          }
        } catch (error) {
          this.services.reportError(error);
          if (isInfiniteLoopError(error)) throw error;
        }
      }
    }
  }

  private isPending(self: BObject, key: string): boolean {
    return this.pending.get(self)?.has(key) ?? false;
  }

  private markPending(self: BObject, key: string): void {
    const set = this.pending.get(self) ?? new Set<string>();
    set.add(key);
    this.pending.set(self, set);
  }

  private clearPending(self: BObject, key: string): void {
    this.pending.get(self)?.delete(key);
  }

  createContext(
    self: BObject | null,
    deltaSeconds: number,
    tickIndex: number,
    commandArgs: Record<string, unknown> = {},
    tick?: TickContext,
    extras?: ScriptExtras,
  ): ScriptContext {
    const services = this.services;
    const store = extras?.variableStore ?? self;
    return {
      self,
      deltaSeconds,
      tickIndex,
      commandArgs,
      args: commandArgs,
      animFacts: extras?.animFacts,
      reportCommand: (success, output) => {
        this.commandResult = { success: Boolean(success), output: String(output) };
        services.reportCommand?.(Boolean(success), String(output));
      },
      formatValue: (value) => formatValue(value),
      checkInfiniteLoop: () => {
        services.checkInfiniteLoop?.();
      },
      log: (severity, category, message) =>
        services.log(severity, category, message),
      print: (message, key, duration, color) =>
        services.print(message, key, duration, color),
      drawDebug: (payload) => {
        services.drawDebug?.(payload);
      },
      getVariable: (name) => store?.getVariable(name),
      setVariable: (name, value) => {
        store?.setVariable(name, value);
      },
      getVariableFrom: (target, name) =>
        (target ?? self)?.getVariable(name),
      setVariableOn: (target, name, value) => {
        (target ?? self)?.setVariable(name, value);
      },
      destroyActor: (actor) => {
        const target = asActor(actor ?? self);
        if (target) services.destroyActor(target);
      },
      setActorLocation: (actor, location) => {
        const target = asActor(actor ?? self);
        if (!target || !location) return;
        target.transform.position.x = Number(location.x ?? 0);
        target.transform.position.y = Number(location.y ?? 0);
        target.transform.position.z = Number(location.z ?? 0);
      },
      executeConsoleCommand: (command) =>
        services.executeConsoleCommand(command),
      delay: (seconds) => services.delay(seconds),
      callInterface: (target, interfaceGuid, method, args) => {
        const receiver = (target ?? self) as InterfaceDispatchTarget | null;
        const registry = services.interfaceRegistry;
        if (!registry || !receiver) return {};
        return dispatchInterface(
          registry,
          receiver,
          String(interfaceGuid),
          String(method),
          args ?? {},
        );
      },
      getComponent: (actor, classId) =>
        asActor(actor ?? self)?.components.find((c) => c.classId === classId) ??
        null,
      addComponent: (actor, classId) => {
        const target = asActor(actor ?? self);
        if (!target) return null;
        return services.addComponent?.(target, classId) ?? null;
      },
      spawnActor: (classId) => services.spawnActor?.(String(classId)) ?? null,
      isA: (instance, classId) => {
        if (instance == null || typeof instance !== "object") return false;
        const id = (instance as { classId?: unknown }).classId;
        if (typeof id !== "string" || !id) return false;
        const target = String(classId ?? "");
        if (!target) return false;
        return services.classRegistry?.isA(id, target) ?? id === target;
      },
      getAnimGraphVariable: (name) =>
        services.animGraphControl?.(self)?.getVariable(String(name ?? "")),
      setAnimGraphVariable: (name, value) => {
        services.animGraphControl?.(self)?.setVariable(String(name ?? ""), value);
      },
      getAnimGraphCurrentState: () =>
        services.animGraphControl?.(self)?.getCurrentState() ?? null,
      jumpAnimGraphState: (state) => {
        services.animGraphControl?.(self)?.jumpToState(String(state ?? ""));
      },
      invokeCustomEvent: (target, eventName, eventArgs) => {
        const receiver = (target ?? self) as BObject | null;
        if (!receiver || typeof eventName !== "string" || !eventName) return;
        const loaded = this.byClassId.get(receiver.classId);
        if (!loaded || loaded.length === 0) return;
        this.dispatchEvent(
          loaded,
          eventName,
          receiver,
          0,
          0,
          eventArgs ?? {},
        );
      },
      invokeEvent: (classId, eventName, eventArgs) => {
        if (typeof classId !== "string" || !classId.trim()) return;
        if (typeof eventName !== "string" || !eventName) return;
        const loaded = this.byClassId.get(classId.trim());
        if (!loaded || loaded.length === 0) return;
        this.dispatchEvent(
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
      invokeFunction: (target, functionName, fnArgs) => {
        if (typeof functionName !== "string" || !functionName) {
          return {};
        }
        let loaded: LoadedScript[] | undefined;
        let receiver: BObject | null = null;
        if (typeof target === "string") {
          loaded = this.byClassId.get(target);
        } else {
          const object = (target ?? self) as BObject | null;
          if (!object) return {};
          receiver = object;
          loaded = this.byClassId.get(object.classId);
        }
        if (!loaded || loaded.length === 0) return {};
        let result: unknown = {};
        for (const entry of loaded) {
          const fn = entry.exports[functionName];
          if (typeof fn !== "function") continue;
          const nested = this.createContext(
            receiver,
            deltaSeconds,
            tickIndex,
            fnArgs ?? {},
            tick,
            extras,
          );
          try {
            const value = (fn as (ctx: ScriptContext) => unknown)(nested);
            if (value instanceof Promise) {
              void value.catch((error) => this.services.reportError(error));
              continue;
            }
            result = value ?? {};
          } catch (error) {
            if (isInfiniteLoopError(error)) throw error;
            this.services.reportError(error);
          }
        }
        return (
          result && typeof result === "object" && !Array.isArray(result)
            ? result
            : {}
        ) as Record<string, unknown>;
      },
      isActionHeld: (action) => tick?.isActionHeld?.(action) ?? false,
      wasActionPressed: (action) => tick?.wasActionPressed?.(action) ?? false,
      wasActionReleased: (action) =>
        tick?.wasActionReleased?.(action) ?? false,
      getAxis: (axis) => tick?.getAxis?.(axis) ?? 0,
      getAxis2D: (axis) => tick?.getAxis2D?.(axis) ?? { x: 0, y: 0 },
      setGamepadRumble: (gamepadIndex, intensity, durationMs) => {
        tick?.setGamepadRumble?.(gamepadIndex, intensity, durationMs);
      },
      gamepadConnections: tick?.gamepadConnections ?? [],
      lineTrace: (start, end) => {
        const hit = services.lineTrace?.(start, end) ?? {
          hit: false,
          location: null,
          actorId: null,
          normal: null,
          distance: 0,
          bodyId: null,
        };
        return {
          hit: hit.hit,
          location: hit.location,
          actor: hit.actorId,
        };
      },
      sphereOverlap: (center, radius) =>
        services.sphereOverlap?.(center, radius) ?? {
          actorIds: [],
          bodyIds: [],
        },
      shapeSweep: (shape, start, end) =>
        services.shapeSweep?.(shape, start, end) ?? {
          hit: false,
          location: null,
          normal: null,
          distance: 0,
          actorId: null,
          bodyId: null,
        },
      addImpulse: (actor, impulse, strength) => {
        const target = asActor(actor ?? self);
        if (!target) return;
        services.addImpulse?.(target, impulse, strength);
      },
      moveCharacter: (actor, translation, offset) => {
        const target = asActor(actor ?? self);
        if (!target) return;
        services.moveCharacter?.(
          target,
          translation,
          deltaSeconds,
          offset,
        );
      },
      playSound: (asset, volume) => {
        services.playSound?.(String(asset ?? ""), Number(volume ?? 1), {
          emitterActorGuid: self?.guid ?? null,
        });
      },
      playParticles: (actor) => {
        const target = asActor(actor ?? self);
        if (!target) return;
        services.setParticlePlaying?.(target.guid, true);
      },
      stopParticles: (actor) => {
        const target = asActor(actor ?? self);
        if (!target) return;
        services.setParticlePlaying?.(target.guid, false);
      },
      setChannelVolume: (channelGuid, volume) => {
        services.setChannelVolume?.(
          String(channelGuid ?? ""),
          Number(volume ?? 1),
        );
      },
      setGlobalVolume: (volume) => {
        services.setGlobalVolume?.(Number(volume ?? 1));
      },
      getWidget: (widgetId) => {
        if (!(self instanceof UserInterface)) return null;
        const id = String(widgetId ?? "");
        return self.widgets.find((widget) => widget.widgetId === id) ?? null;
      },
      setWidgetVisible: (widget, visible) => {
        services.setWidgetVisible?.(widget, visible);
      },
      applyUserInterface: (classIdOrGuid) =>
        services.applyUserInterface?.(classIdOrGuid) ?? null,
      removeUserInterface: (instance) => {
        services.removeUserInterface?.(instance);
      },
      changeScene: (scene) => {
        services.changeScene?.(scene);
      },
      setRenderResolution: (width, height) => {
        services.setRenderResolution?.(Number(width), Number(height));
      },
      setInputMode: (mode) => {
        services.setInputMode?.(String(mode ?? ""));
      },
      possessCamera: (target) => {
        services.possessCamera?.(target);
      },
      getCameraFieldOfView: (target) =>
        Number(cameraComponentOf(target)?.getVariable("fieldOfView") ?? 60),
      setCameraFieldOfView: (target, fov) => {
        cameraComponentOf(target)?.setVariable("fieldOfView", Number(fov));
        services.updateIllumination?.(target);
      },
      getCameraOrthographicSize: (target) =>
        Number(
          cameraComponentOf(target)?.getVariable("orthographicSize") ?? 5,
        ),
      setCameraOrthographicSize: (target, size) => {
        cameraComponentOf(target)?.setVariable("orthographicSize", Number(size));
        services.updateIllumination?.(target);
      },
      setLightEnabled: (target, enabled) => {
        lightComponentOf(target)?.setVariable("enabled", Boolean(enabled));
        services.updateIllumination?.(target);
      },
      setLightColor: (target, color) => {
        lightComponentOf(target)?.setVariable("color", [
          Number(color?.x ?? 1),
          Number(color?.y ?? 1),
          Number(color?.z ?? 1),
        ]);
        services.updateIllumination?.(target);
      },
      setLightIntensity: (target, intensity) => {
        lightComponentOf(target)?.setVariable("intensity", Number(intensity));
        services.updateIllumination?.(target);
      },
      findPathTo: (from, to) => services.findPathTo?.(from, to) ?? [],
      moveTo: (actor, destination) => {
        const target = asActor(actor ?? self);
        if (!target) return;
        services.moveTo?.(target, destination);
      },
      stopMovement: (actor) => {
        const target = asActor(actor ?? self);
        if (!target) return;
        services.stopMovement?.(target);
      },
      isPathValid: (from, to) => services.isPathValid?.(from, to) ?? false,
      getClosestNavigablePoint: (point) =>
        services.getClosestNavigablePoint?.(point) ?? null,
      getRandomPointInRadius: (center, radius) =>
        services.getRandomPointInRadius?.(center, radius) ?? null,
      addObstacle: (kind, pose, size) =>
        services.addObstacle?.(kind, pose, size) ?? "",
      removeObstacle: (id) => {
        services.removeObstacle?.(id);
      },
      btFinish: extras?.btFinish ?? (() => undefined),
      btEvaluate: extras?.btEvaluate ?? (() => undefined),
      getBlackboard: extras?.getBlackboard ?? (() => undefined),
      setBlackboard: extras?.setBlackboard ?? (() => undefined),
    };
  }
}

function asActor(target: unknown): Actor | null {
  return target instanceof Actor ? target : null;
}

function actorOf(target: unknown): Actor | null {
  if (target instanceof Actor) return target;
  if (target instanceof ActorComponent) return target.owner;
  return null;
}

function cameraComponentOf(target: unknown): ActorComponent | null {
  if (target instanceof ActorComponent && target.classId === "CameraComponent") {
    return target;
  }
  return (
    actorOf(target)?.components.find(
      (component) => component.classId === "CameraComponent" && !component.destroyed,
    ) ?? null
  );
}

function lightComponentOf(target: unknown): ActorComponent | null {
  if (target instanceof ActorComponent && target.classId === "LightComponent") {
    return target;
  }
  return (
    actorOf(target)?.components.find(
      (component) => component.classId === "LightComponent" && !component.destroyed,
    ) ?? null
  );
}
