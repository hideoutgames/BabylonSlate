import { formatValue } from "@babylonslate/core";
import type { ScriptBundleEntry } from "@babylonslate/bridge";
import type { Actor, LifecycleHooks, TickContext } from "@babylonslate/object-model";
import { loadCompiledModule, type CompiledModuleExports } from "./module-loader";
import type { LogSeverity } from "./log-ring";

export type CompiledScript = ScriptBundleEntry;

export type ScriptColor = { x: number; y: number; z: number; w: number };

/**
 * Engine services a compiled graph calls through `ctx`. The host implements the
 * subsystems that exist today; the rest are inert stubs so a graph that uses a
 * node from a later phase runs instead of throwing.
 */
export interface ScriptHostServices {
  log(severity: LogSeverity, category: string, message: string): void;
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
}

/** The `ctx` object bound into every compiled graph invocation. */
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
  callInterface(
    target: Actor | null | undefined,
    interfaceGuid: string,
    method: string,
  ): unknown;
  getComponent(actor: Actor | null | undefined, classId: string): unknown;
  addComponent(actor: Actor | null | undefined, classId: string): unknown;
  isActionHeld(action: string): boolean;
  getAxis(axis: string): number;
  getAxis2D(axis: string): { x: number; y: number };
  lineTrace(): { hit: boolean; location: null; actor: null };
  addImpulse(): void;
  playSound(): void;
  setWidgetVisible(): void;
  changeScene(scene: string): void;
}

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
        this.invokeEvent(loaded, "onBeginPlay", self, 0, 0);
      },
      onTick: (self, ctx: TickContext) => {
        this.invokeEvent(loaded, "onTick", self, ctx.dt, ctx.tickIndex);
      },
    };
  }

  private invokeEvent(
    loaded: readonly LoadedScript[],
    event: "onBeginPlay" | "onTick",
    self: Actor,
    deltaSeconds: number,
    tickIndex: number,
  ): void {
    for (const entry of loaded) {
      for (const point of entry.script.entryPoints) {
        if (point.event !== event) continue;
        const fn = entry.exports[point.name];
        if (typeof fn !== "function") continue;
        const key = `${entry.script.assetGuid}:${point.name}`;
        // A latent entry point must finish before it is re-entered, otherwise
        // a per-tick event would stack one pending run per frame.
        if (point.isAsync && this.isPending(self, key)) continue;
        const ctx = this.createContext(self, deltaSeconds, tickIndex);
        try {
          const result = (fn as (ctx: ScriptContext) => unknown)(ctx);
          if (result instanceof Promise) {
            this.markPending(self, key);
            void result
              .catch((error) => this.services.reportError(error))
              .finally(() => this.clearPending(self, key));
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
  ): ScriptContext {
    const services = this.services;
    return {
      self,
      deltaSeconds,
      tickIndex,
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
          `${interfaceGuid}.${method}`,
        );
        return handler ? handler({}) : undefined;
      },
      // Subsystems that land with later phases; inert but callable so a graph
      // referencing them still runs.
      getComponent: (actor, classId) =>
        (actor ?? self)?.components.find((c) => c.classId === classId) ?? null,
      addComponent: () => null,
      isActionHeld: () => false,
      getAxis: () => 0,
      getAxis2D: () => ({ x: 0, y: 0 }),
      lineTrace: () => ({ hit: false, location: null, actor: null }),
      addImpulse: () => {},
      playSound: () => {},
      setWidgetVisible: () => {},
      changeScene: () => {},
    };
  }
}
