import { formatValue } from "@babylonslate/core";
import type { ScriptBundleEntry } from "@babylonslate/bridge";
import {
  interfaceHandlerKey,
  type Actor,
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
import { loadCompiledModule, type CompiledModuleExports } from "./module-loader";
import type { LogSeverity } from "./log-ring";

export type ScriptColor = { x: number; y: number; z: number; w: number };

/**
 * Engine services a compiled graph calls through `ctx`. The host implements the
 * subsystems that exist today; the rest are inert stubs so a graph that uses a
 * node from a later phase runs instead of throwing.
 */
export interface ScriptHostServices {
  log(severity: LogSeverity, category: string, message: string): void;
  addComponent?(
    actor: Actor | null | undefined,
    classId: string,
  ): unknown;
  spawnActor?(classId: string): Actor | null;
  print(
    message: string,
    key: string,
    duration: number,
    color: ScriptColor,
  ): void;
  destroyActor(actor: Actor | null | undefined): void;
  executeConsoleCommand(command: string): { success: boolean; output: string };
  delay(seconds: number): Promise<void>;
  reportError(error: unknown): void;
  reportCommand?(success: boolean, output: string): void;
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
  setWidgetVisible?(widget: string, visible: boolean): void;
  applyUserInterface?(assetGuid: string): string;
  removeUserInterface?(instanceId: string): void;
  changeScene?(scene: string): void;
  playSound?(asset: string, volume?: number): void;
  setRenderResolution?(width: number, height: number): void;
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
  self: Actor | null;
  deltaSeconds: number;
  tickIndex: number;
  formatValue(value: unknown): string;
  log(severity: LogSeverity, category: string, message: string): void;
  print(
    message: string,
    key: string,
    duration: number,
    color: ScriptColor,
  ): void;
  getVariable(name: string): unknown;
  setVariable(name: string, value: unknown): void;
  destroyActor(actor: Actor | null | undefined): void;
  setActorLocation(
    actor: Actor | null | undefined,
    location: { x: number; y: number; z: number },
  ): void;
  executeConsoleCommand(command: string): { success: boolean; output: string };
  delay(seconds: number): Promise<void>;
  commandArgs: Record<string, unknown>;
  reportCommand(success: boolean, output: string): void;
  callInterface(
    target: Actor | null | undefined,
    interfaceGuid: string,
    method: string,
  ): unknown;
  getComponent(actor: Actor | null | undefined, classId: string): unknown;
  addComponent(actor: Actor | null | undefined, classId: string): unknown;
  spawnActor(classId: string): Actor | null;
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
    actor: Actor | null | undefined,
    impulse: Vec3,
    strength?: number,
  ): void;
  moveCharacter(
    actor: Actor | null | undefined,
    translation: Vec3,
    offset?: number,
  ): void;
  playSound(asset: string, volume?: number): void;
  setWidgetVisible(widget: string, visible: boolean): void;
  applyUserInterface(assetGuid: string): string;
  removeUserInterface(instanceId: string): void;
  changeScene(scene: string): void;
  setRenderResolution(width: number, height: number): void;
  btFinish(result: "success" | "failure"): void;
  btEvaluate(value: boolean): void;
  getBlackboard(key: string): unknown;
  setBlackboard(key: string, value: unknown): void;
  findPathTo(from: Vec3, to: Vec3): Vec3[];
  moveTo(actor: Actor | null | undefined, destination: Vec3): void;
  stopMovement(actor: Actor | null | undefined): void;
  isPathValid(from: Vec3, to: Vec3): boolean;
  getClosestNavigablePoint(point: Vec3): Vec3 | null;
  getRandomPointInRadius(center: Vec3, radius: number): Vec3 | null;
  addObstacle(kind: string, pose: Vec3, size: Vec3): string;
  removeObstacle(id: string): void;
}

type BtScriptExtras = Pick<
  ScriptContext,
  "btFinish" | "btEvaluate" | "getBlackboard" | "setBlackboard"
>;

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
  private readonly pending = new WeakMap<Actor, Set<string>>();
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
  hooksFor(classId: string): LifecycleHooks<Actor> | undefined {
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
  invokeEvent(classId: string, event: string, self: Actor | null = null): void {
    const loaded = this.byClassId.get(classId);
    if (!loaded || loaded.length === 0) return;
    this.dispatchEvent(loaded, event, self, 0, 0);
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

  /**
   * Register compiled custom events as interface handlers on `actor`.
   * Keys match `interfaceHandlerKey` (`guid:method`).
   */
  bindInterfaceHandlers(actor: Actor): void {
    const loaded = this.byClassId.get(actor.classId);
    if (!loaded || loaded.length === 0) return;
    const lifecycle = new Set(["onBeginPlay", "onTick", "onCommandRun"]);
    for (const iface of actor.implementedInterfaces) {
      for (const entry of loaded) {
        for (const point of entry.script.entryPoints) {
          const event = point.event;
          if (!event || lifecycle.has(event)) continue;
          const key = interfaceHandlerKey(iface, event);
          actor.interfaceHandlers.set(key, (args) => {
            this.dispatchEvent(loaded, event, actor, 0, 0, args);
            return {};
          });
        }
      }
    }
  }

  private dispatchEvent(
    loaded: readonly LoadedScript[],
    event: string,
    self: Actor | null,
    deltaSeconds: number,
    tickIndex: number,
    commandArgs: Record<string, unknown> = {},
    tick?: TickContext,
    extras?: BtScriptExtras,
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
        }
      }
    }
  }

  private isPending(self: Actor, key: string): boolean {
    return this.pending.get(self)?.has(key) ?? false;
  }

  private markPending(self: Actor, key: string): void {
    const set = this.pending.get(self) ?? new Set<string>();
    set.add(key);
    this.pending.set(self, set);
  }

  private clearPending(self: Actor, key: string): void {
    this.pending.get(self)?.delete(key);
  }

  createContext(
    self: Actor | null,
    deltaSeconds: number,
    tickIndex: number,
    commandArgs: Record<string, unknown> = {},
    tick?: TickContext,
    extras?: BtScriptExtras,
  ): ScriptContext {
    const services = this.services;
    return {
      self,
      deltaSeconds,
      tickIndex,
      commandArgs,
      reportCommand: (success, output) => {
        this.commandResult = { success: Boolean(success), output: String(output) };
        services.reportCommand?.(Boolean(success), String(output));
      },
      formatValue: (value) => formatValue(value),
      log: (severity, category, message) =>
        services.log(severity, category, message),
      print: (message, key, duration, color) =>
        services.print(message, key, duration, color),
      getVariable: (name) => self?.getVariable(name),
      setVariable: (name, value) => self?.setVariable(name, value),
      destroyActor: (actor) => services.destroyActor(actor ?? self),
      setActorLocation: (actor, location) => {
        const target = actor ?? self;
        if (!target || !location) return;
        target.transform.position.x = Number(location.x ?? 0);
        target.transform.position.y = Number(location.y ?? 0);
        target.transform.position.z = Number(location.z ?? 0);
      },
      executeConsoleCommand: (command) =>
        services.executeConsoleCommand(command),
      delay: (seconds) => services.delay(seconds),
      callInterface: (target, interfaceGuid, method) => {
        const receiver = target ?? self;
        const handler = receiver?.interfaceHandlers.get(
          interfaceHandlerKey(String(interfaceGuid), String(method)),
        );
        return handler ? handler({}) : undefined;
      },
      getComponent: (actor, classId) =>
        (actor ?? self)?.components.find((c) => c.classId === classId) ?? null,
      addComponent: (actor, classId) =>
        services.addComponent?.(actor ?? self, classId) ?? null,
      spawnActor: (classId) => services.spawnActor?.(String(classId)) ?? null,
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
        services.addImpulse?.(actor ?? self, impulse, strength);
      },
      moveCharacter: (actor, translation, offset) => {
        services.moveCharacter?.(
          actor ?? self,
          translation,
          deltaSeconds,
          offset,
        );
      },
      playSound: (asset, volume) => {
        services.playSound?.(String(asset ?? ""), Number(volume ?? 1));
      },
      setWidgetVisible: (widget, visible) => {
        services.setWidgetVisible?.(widget, visible);
      },
      applyUserInterface: (assetGuid) =>
        services.applyUserInterface?.(assetGuid) ?? "",
      removeUserInterface: (instanceId) => {
        services.removeUserInterface?.(instanceId);
      },
      changeScene: (scene) => {
        services.changeScene?.(scene);
      },
      setRenderResolution: (width, height) => {
        services.setRenderResolution?.(Number(width), Number(height));
      },
      findPathTo: (from, to) => services.findPathTo?.(from, to) ?? [],
      moveTo: (actor, destination) => {
        services.moveTo?.(actor ?? self, destination);
      },
      stopMovement: (actor) => {
        services.stopMovement?.(actor ?? self);
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
