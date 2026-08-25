import {
  combineRotators,
  createSeededRng,
  deltaRotator,
  formatValue,
  inverseQuat,
  inverseRotator,
  lerpRotator,
  lookAtRotator,
  multiplyQuats,
  normalizeQuat,
  quatRotateVector,
  quatToRotator,
  rotatorForward,
  rotatorRight,
  rotatorToQuat,
  rotatorUp,
  slerpQuats,
  type Rng,
} from "@babylonslate/core";
import type { ScriptBundleEntry } from "@babylonslate/bridge";
import {
  Actor,
  ActorComponent,
  BObject,
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
  /** World actors in deterministic spawn order for class queries. */
  getActors?(): readonly Actor[];
  log(severity: LogSeverity, category: string, message: string): void;
  addComponent?(
    actor: Actor | null | undefined,
    classId: string,
    transform?: unknown,
  ): unknown;
  animGraphControl?(self: BObject | null | undefined): AnimGraphControl | null;
  spawnActor?(classId: string, transform?: unknown): Actor | null;
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
  /**
   * Resolve a backend physics actor id to a live Actor. Missing / destroyed
   * actors must return undefined so query nodes never surface string ids.
   */
  findActor?(actorId: string): Actor | undefined;
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
  addActorWorldOffset(
    actor: BObject | null | undefined,
    offset: { x: number; y: number; z: number },
  ): void;
  setActorRotation(
    actor: BObject | null | undefined,
    rotation: { pitch: number; yaw: number; roll: number },
  ): void;
  setActorScale(
    actor: BObject | null | undefined,
    scale: { x: number; y: number; z: number },
  ): void;
  setActorTransform(
    actor: BObject | null | undefined,
    transform: {
      position?: { x: number; y: number; z: number };
      rotation?: { x: number; y: number; z: number; w: number };
      scale?: { x: number; y: number; z: number };
    } | null | undefined,
  ): void;
  rotatorToQuat(
    rotator: { pitch?: number; yaw?: number; roll?: number } | null | undefined,
  ): { x: number; y: number; z: number; w: number };
  quatToRotator(
    quat: { x?: number; y?: number; z?: number; w?: number } | null | undefined,
  ): { pitch: number; yaw: number; roll: number };
  combineRotators(
    a: { pitch?: number; yaw?: number; roll?: number } | null | undefined,
    b: { pitch?: number; yaw?: number; roll?: number } | null | undefined,
  ): { pitch: number; yaw: number; roll: number };
  inverseRotator(
    rotator: { pitch?: number; yaw?: number; roll?: number } | null | undefined,
  ): { pitch: number; yaw: number; roll: number };
  deltaRotator(
    from: { pitch?: number; yaw?: number; roll?: number } | null | undefined,
    to: { pitch?: number; yaw?: number; roll?: number } | null | undefined,
  ): { pitch: number; yaw: number; roll: number };
  lerpRotator(
    a: { pitch?: number; yaw?: number; roll?: number } | null | undefined,
    b: { pitch?: number; yaw?: number; roll?: number } | null | undefined,
    alpha: number,
  ): { pitch: number; yaw: number; roll: number };
  rotatorForward(
    rotator: { pitch?: number; yaw?: number; roll?: number } | null | undefined,
  ): { x: number; y: number; z: number };
  rotatorRight(
    rotator: { pitch?: number; yaw?: number; roll?: number } | null | undefined,
  ): { x: number; y: number; z: number };
  rotatorUp(
    rotator: { pitch?: number; yaw?: number; roll?: number } | null | undefined,
  ): { x: number; y: number; z: number };
  lookAtRotator(
    from: { x?: number; y?: number; z?: number } | null | undefined,
    target: { x?: number; y?: number; z?: number } | null | undefined,
  ): { pitch: number; yaw: number; roll: number };
  multiplyQuats(
    a: { x?: number; y?: number; z?: number; w?: number } | null | undefined,
    b: { x?: number; y?: number; z?: number; w?: number } | null | undefined,
  ): { x: number; y: number; z: number; w: number };
  inverseQuat(
    quat: { x?: number; y?: number; z?: number; w?: number } | null | undefined,
  ): { x: number; y: number; z: number; w: number };
  slerpQuats(
    a: { x?: number; y?: number; z?: number; w?: number } | null | undefined,
    b: { x?: number; y?: number; z?: number; w?: number } | null | undefined,
    alpha: number,
  ): { x: number; y: number; z: number; w: number };
  quatRotateVector(
    quat: { x?: number; y?: number; z?: number; w?: number } | null | undefined,
    vector: { x?: number; y?: number; z?: number } | null | undefined,
  ): { x: number; y: number; z: number };
  normalizeQuat(
    quat: { x?: number; y?: number; z?: number; w?: number } | null | undefined,
  ): { x: number; y: number; z: number; w: number };
  /** Seeded PRNG surface — never Math.random. */
  random: {
    float(): number;
    int(min: number, max: number): number;
    bool(): boolean;
  };
  /** @deprecated Prefer `ctx.random.float()`. */
  randomFloat(): number;
  getAllActorsOfClass(classId: string): Actor[];
  getActorOfClass(classId: string): Actor | null;
  attachActor(
    child: BObject | null | undefined,
    parent: BObject | null | undefined,
  ): void;
  detachActor(child: BObject | null | undefined): void;
  getParent(actor: BObject | null | undefined): Actor | null;
  setOwner(
    actor: BObject | null | undefined,
    owner: BObject | null | undefined,
  ): void;
  getOwner(actor: BObject | null | undefined): Actor | null;
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
  addComponent(
    actor: BObject | null | undefined,
    classId: string,
    transform?: unknown,
  ): unknown;
  spawnActor(classId: string, transform?: unknown): Actor | null;
  isA(instance: unknown, classId: string): boolean;
  getAnimGraphVariable(target: unknown, name: string): unknown;
  setAnimGraphVariable(target: unknown, name: string, value: unknown): void;
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
  ): Record<string, unknown> | Promise<Record<string, unknown>>;
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
    channel?: string,
  ): {
    hit: boolean;
    location: Vec3 | null;
    normal: Vec3 | null;
    distance: number;
    actor: Actor | null;
  };
  sphereOverlap(
    center: Vec3,
    radius: number,
    channel?: string,
  ): OverlapResult & { actors: Actor[] };
  shapeSweep(
    shape: ColliderShape,
    start: PhysicsTransform,
    end: PhysicsTransform,
    channel?: string,
  ): {
    hit: boolean;
    location: Vec3 | null;
    normal: Vec3 | null;
    distance: number;
    actor: Actor | null;
  };
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
  changeScene(scene: string): void;
  setRenderResolution(width: number, height: number): void;
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
  /**
   * Per-script-instance / per-node mutable state for Do Once, Do N, Flip Flop,
   * Gate. Never module-global — keyed by the receiving BObject.
   */
  flowState(nodeId: string): Record<string, unknown>;
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
  private readonly flowStates = new WeakMap<
    BObject,
    Map<string, Record<string, unknown>>
  >();
  private readonly orphanFlowStates = new Map<
    string,
    Record<string, unknown>
  >();
  private readonly services: ScriptHostServices;
  private commandResult = { success: true, output: "" };
  private readonly rng: Rng = createSeededRng(1);

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
        this.clearFlowState(self);
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
    const ctx = this.createContext(
      self,
      0,
      0,
      {},
      undefined,
      extras,
      loaded[0]!.script.assetGuid,
    );
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
            const ctx = this.createContext(
              object,
              0,
              0,
              args,
              undefined,
              undefined,
              entry.script.assetGuid,
            );
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
          entry.script.assetGuid,
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

  clearFlowState(self: BObject | null | undefined): void {
    if (self) this.flowStates.delete(self);
  }

  private flowStateFor(
    self: BObject | null,
    nodeId: string,
    namespace = "",
  ): Record<string, unknown> {
    const key = namespace ? `${namespace}\0${nodeId}` : nodeId;
    if (!self) {
      let row = this.orphanFlowStates.get(key);
      if (!row) {
        row = {};
        this.orphanFlowStates.set(key, row);
      }
      return row;
    }
    let byNode = this.flowStates.get(self);
    if (!byNode) {
      byNode = new Map();
      this.flowStates.set(self, byNode);
    }
    let row = byNode.get(key);
    if (!row) {
      row = {};
      byNode.set(key, row);
    }
    return row;
  }

  createContext(
    self: BObject | null,
    deltaSeconds: number,
    tickIndex: number,
    commandArgs: Record<string, unknown> = {},
    tick?: TickContext,
    extras?: ScriptExtras,
    flowNamespace = "",
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
      flowState: (nodeId: string) =>
        this.flowStateFor(self, String(nodeId), flowNamespace),
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
      addActorWorldOffset: (actor, offset) => {
        const target = asActor(actor ?? self);
        if (!target || !offset) return;
        target.transform.position.x += Number(offset.x ?? 0);
        target.transform.position.y += Number(offset.y ?? 0);
        target.transform.position.z += Number(offset.z ?? 0);
      },
      setActorRotation: (actor, rotation) => {
        const target = asActor(actor ?? self);
        if (!target) return;
        const quat = rotatorToQuat(rotation);
        target.transform.rotation.x = quat.x;
        target.transform.rotation.y = quat.y;
        target.transform.rotation.z = quat.z;
        target.transform.rotation.w = quat.w;
      },
      setActorScale: (actor, scale) => {
        const target = asActor(actor ?? self);
        if (!target || !scale) return;
        target.transform.scale.x = Number(scale.x ?? 1);
        target.transform.scale.y = Number(scale.y ?? 1);
        target.transform.scale.z = Number(scale.z ?? 1);
      },
      setActorTransform: (actor, transform) => {
        const target = asActor(actor ?? self);
        if (!target || !transform) return;
        if (transform.position) {
          target.transform.position.x = Number(transform.position.x ?? 0);
          target.transform.position.y = Number(transform.position.y ?? 0);
          target.transform.position.z = Number(transform.position.z ?? 0);
        }
        if (transform.rotation) {
          target.transform.rotation.x = Number(transform.rotation.x ?? 0);
          target.transform.rotation.y = Number(transform.rotation.y ?? 0);
          target.transform.rotation.z = Number(transform.rotation.z ?? 0);
          target.transform.rotation.w = Number(transform.rotation.w ?? 1);
        }
        if (transform.scale) {
          target.transform.scale.x = Number(transform.scale.x ?? 1);
          target.transform.scale.y = Number(transform.scale.y ?? 1);
          target.transform.scale.z = Number(transform.scale.z ?? 1);
        }
      },
      rotatorToQuat,
      quatToRotator,
      combineRotators,
      inverseRotator,
      deltaRotator,
      lerpRotator,
      rotatorForward,
      rotatorRight,
      rotatorUp,
      lookAtRotator,
      multiplyQuats,
      inverseQuat,
      slerpQuats,
      quatRotateVector,
      normalizeQuat,
      random: {
        float: () => this.rng.nextFloat(),
        int: (min, max) => {
          const a = Number(min) | 0;
          const b = Number(max) | 0;
          const lo = Math.min(a, b);
          const hi = Math.max(a, b);
          if (hi === lo) return lo;
          return lo + (this.rng.next() % (hi - lo + 1));
        },
        bool: () => this.rng.nextFloat() < 0.5,
      },
      randomFloat: () => this.rng.nextFloat(),
      getAllActorsOfClass: (classId) => {
        const target = String(classId ?? "");
        const actors = services.getActors?.() ?? [];
        if (!target) return [];
        return actors.filter((actor) => {
          const id = actor.classId;
          if (!id) return false;
          return services.classRegistry?.isA(id, target) ?? id === target;
        });
      },
      getActorOfClass: (classId) => {
        const target = String(classId ?? "");
        const actors = services.getActors?.() ?? [];
        if (!target) return null;
        return (
          actors.find((actor) => {
            const id = actor.classId;
            if (!id) return false;
            return services.classRegistry?.isA(id, target) ?? id === target;
          }) ?? null
        );
      },
      attachActor: (child, parent) => {
        setActorLink(child, "parentId", parent);
      },
      detachActor: (child) => {
        setActorLink(child, "parentId", null);
      },
      getParent: (actor) => readActorLink(services, actor, "parentId"),
      setOwner: (actor, owner) => {
        setActorLink(actor, "ownerId", owner);
      },
      getOwner: (actor) => readActorLink(services, actor, "ownerId"),
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
      addComponent: (actor, classId, transform) => {
        const target = asActor(actor ?? self);
        if (!target) return null;
        return services.addComponent?.(target, classId, transform) ?? null;
      },
      spawnActor: (classId, transform) =>
        services.spawnActor?.(String(classId), transform) ?? null,
      isA: (instance, classId) => {
        if (instance == null || typeof instance !== "object") return false;
        const id = (instance as { classId?: unknown }).classId;
        if (typeof id !== "string" || !id) return false;
        const target = String(classId ?? "");
        if (!target) return false;
        return services.classRegistry?.isA(id, target) ?? id === target;
      },
      getAnimGraphVariable: (target, name) =>
        animationGraphComponentOf(target)?.getVariable(String(name ?? "")),
      setAnimGraphVariable: (target, name, value) => {
        animationGraphComponentOf(target)?.setVariable(
          String(name ?? ""),
          value,
        );
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
            entry.script.assetGuid,
          );
          try {
            const value = (fn as (ctx: ScriptContext) => unknown)(nested);
            if (value instanceof Promise) {
              return value.then(
                (resolved) =>
                  resolved &&
                  typeof resolved === "object" &&
                  !Array.isArray(resolved)
                    ? (resolved as Record<string, unknown>)
                    : {},
                (error) => {
                  if (isInfiniteLoopError(error)) throw error;
                  this.services.reportError(error);
                  return {};
                },
              );
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
          hit: hit.hit === true,
          location: hit.location ?? null,
          normal: hit.normal ?? null,
          distance: hit.distance ?? 0,
          actor: resolveLiveActor(services, hit.actorId),
        };
      },
      sphereOverlap: (center, radius) => {
        const overlap = services.sphereOverlap?.(center, radius) ?? {
          actorIds: [],
          bodyIds: [],
        };
        return {
          actorIds: overlap.actorIds,
          bodyIds: overlap.bodyIds,
          actors: resolveLiveActors(services, overlap.actorIds),
        };
      },
      shapeSweep: (shape, start, end) => {
        const hit = services.shapeSweep?.(shape, start, end) ?? {
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
      changeScene: (scene) => {
        services.changeScene?.(scene);
      },
      setRenderResolution: (width, height) => {
        services.setRenderResolution?.(Number(width), Number(height));
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

function setActorLink(
  actor: unknown,
  key: "parentId" | "ownerId",
  other: unknown,
): void {
  const target = asActor(actor);
  if (!target || target.destroyed) return;
  const linked = asActor(other);
  if (!linked || linked.destroyed || linked.guid === target.guid) {
    target.setVariable(key, null);
    return;
  }
  target.setVariable(key, linked.guid);
}

function readActorLink(
  services: ScriptHostServices,
  actor: unknown,
  key: "parentId" | "ownerId",
): Actor | null {
  const target = asActor(actor);
  if (!target || target.destroyed) return null;
  const id = target.getVariable(key);
  return typeof id === "string" ? resolveLiveActor(services, id) : null;
}

function resolveLiveActor(
  services: ScriptHostServices,
  actorId: string | null | undefined,
): Actor | null {
  if (!actorId) return null;
  const actor = services.findActor?.(actorId);
  if (!actor || actor.destroyed) return null;
  return actor;
}

function resolveLiveActors(
  services: ScriptHostServices,
  actorIds: readonly string[],
): Actor[] {
  const seen = new Set<string>();
  const actors: Actor[] = [];
  for (const id of actorIds) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const actor = resolveLiveActor(services, id);
    if (actor) actors.push(actor);
  }
  return actors;
}

function actorOf(target: unknown): Actor | null {
  if (target instanceof Actor) return target;
  if (target instanceof ActorComponent) return target.owner;
  return null;
}

function animationGraphComponentOf(target: unknown): ActorComponent | null {
  if (
    target instanceof ActorComponent &&
    target.classId === "AnimationGraphComponent" &&
    !target.destroyed
  ) {
    return target;
  }
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
