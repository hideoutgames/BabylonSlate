import { createSeededRng, SaveGameError, type Rng, type SaveGameMigrationData, type SaveGameService } from "@haptic/core";
import {
  interfaceHandlerKey,
  isLockedEngineClassId,
  SUBSYSTEM_CLASS_ID,
  type Actor,
  type ActorComponent,
  type EngineObject,
  type LifecycleHooks,
  type TickContext,
} from "@haptic/object-model";
import type { AnimTransitionDecision } from "@haptic/anim-graph";
import { isInfiniteLoopError } from "@haptic/debugger";
import { loadCompiledModule } from "./module-loader";
import type { ScriptBreakpoints } from "./script-breakpoints";
import { createScriptContext, type ScriptContextHost } from "./script-context-factory";
import type {
  BtScriptExtras,
  CallerFrame,
  CompiledScript,
  HostContextMembers,
  LoadedScript,
  ScriptContext,
  ScriptExtras,
} from "./script-context-types";
import type { ScriptCostMeter } from "./script-cost-meter";
import type { ScriptDebugTrace } from "./script-debug";
import { entryMatchesComponentInvoke, isTextComponent } from "./script-host-helpers";
import { createHostMembers } from "./script-host-members";
import type { ScriptHostServices } from "./script-host-services";
import { ScriptMaterialOwnership } from "./script-material-ownership";
import { RuntimeContinuationCancelled } from "./simulation-waits";

export type { AnimGraphControl, ScriptAssetLoadResult, ScriptColor, ScriptHostServices } from "./script-host-services";
export type {
  CompiledScript,
  HostContextKey,
  ScreenProjection,
  ScriptContext,
  ScriptExtras,
  VariableStore,
} from "./script-context-types";

/** An AnimationGraph asset may own several independently compiled Class modules. */
export function compiledScriptKey(script: Pick<CompiledScript, "assetGuid" | "classId">): string {
  return JSON.stringify([script.assetGuid, script.classId]);
}

export function compiledScriptSourceLabel(script: Pick<CompiledScript, "assetGuid" | "classId">): string {
  return `${script.assetGuid}~${encodeURIComponent(script.classId)}`;
}

/**
 * Loads compiled graph modules and binds their entry points to actor
 * lifecycle hooks. One host per runtime session.
 */
export class ScriptHost {
  private readonly boundInterfaceKeys = new WeakMap<EngineObject, Set<string>>();
  /** Text components whose On Text Changed handlers are running now. */
  private readonly textChangeDispatches = new Set<ActorComponent>();
  private readonly byClassId = new Map<string, LoadedScript[]>();
  private sourceGeneration = 0;
  /**
   * `scriptLineage` per class id. `hooksFor` resolves it on every tick for
   * every component and actor, so it is cached; `load` clears it, and the
   * runtime only changes the ClassRegistry immediately before a `load`.
   */
  private readonly lineageByClassId = new Map<string, readonly LoadedScript[][]>();
  /** `hooksFor` results per class id; cleared with the lineage they derive from. */
  private readonly hooksByClassId = new Map<string, LifecycleHooks<EngineObject>>();
  /**
   * `eventScriptsFor` results of the lifecycle events a hook dispatches each
   * tick, per class id and event. They depend only on the lineage, so they are
   * cleared with it. Held hooks look them up here, never in their closures, so
   * a reload reaches actors that captured their hooks at creation.
   */
  private readonly lifecycleScriptsByClassId = new Map<string, Map<string, LoadedScript[] | null>>();
  private readonly pending = new WeakMap<EngineObject, Set<string>>();
  private readonly flowStates = new WeakMap<
    EngineObject,
    Map<string, Record<string, unknown>>
  >();
  private readonly orphanFlowStates = new Map<
    string,
    Record<string, unknown>
  >();
  private readonly services: ScriptHostServices;
  /** The instance the editor's graph debugger follows, and where its scripts report. */
  private debugObject: EngineObject | null = null;
  private debugSink: ScriptDebugTrace | null = null;
  private breakpoints: ScriptBreakpoints | null = null;
  private costMeter: ScriptCostMeter | null = null;
  private invokingOwner: EngineObject | null = null;
  private finalizingOwner: EngineObject | null = null;
  /** The `ctx.callInterface` caller whose frame its interface handler runs in. */
  private interfaceCaller: CallerFrame | null = null;
  private readonly rng: Rng;
  /** Host-lifetime members every context inherits; built once in the constructor. */
  private readonly hostMembers: HostContextMembers;
  /** Material replacement versions and the preloads they hold, per owner and scope. */
  private readonly materials: ScriptMaterialOwnership;
  /** What `createScriptContext` reads from this host; built once in the constructor. */
  private readonly contextHost: ScriptContextHost;

  constructor(services: ScriptHostServices) {
    this.services = services;
    this.rng = createSeededRng(services.seed ?? 1);
    const canInvokeOwner = (owner: EngineObject) => this.canInvokeOwner(owner);
    this.materials = new ScriptMaterialOwnership({ services, canInvokeOwner });
    // The context modules reach this host's private state only through these wrappers.
    const shared = {
      services,
      rng: this.rng,
      materials: this.materials,
      canInvokeOwner,
      applyComponentVariable: (component: ActorComponent, name: string, value: unknown, previous?: unknown) =>
        this.applyComponentVariable(component, name, value, previous),
    };
    this.hostMembers = createHostMembers({ ...shared, breakpoints: () => this.breakpoints });
    this.contextHost = {
      ...shared,
      hostMembers: this.hostMembers,
      debugTraceFor: (store) => this.debugTraceFor(store),
      flowStateFor: (owner, nodeId, namespace) => this.flowStateFor(owner, nodeId, namespace),
      withInterfaceCaller: <T>(frame: CallerFrame, run: () => T): T => this.withInterfaceCaller(frame, run),
      invokeSaveMigration: (self, event, snapshot) => this.invokeSaveMigration(self, event, snapshot),
      eventScriptsFor: (classId, event, self, componentId) => this.eventScriptsFor(classId, event, self, componentId),
      functionScriptsFor: (classId, exportName) => this.functionScriptsFor(classId, exportName),
      // Forwarded as given, so an omitted argument still takes its default.
      dispatchEvent: (...args) => this.dispatchEvent(...args),
      invokeEntry: <T>(owner: EngineObject | null, script: CompiledScript, exportName: string, invoke: () => T): T =>
        this.invokeEntry(owner, script, exportName, invoke),
      reportLatentError: (error, owner) => this.reportLatentError(error, owner),
    };
  }

  /** Routes `ctx.debugTrace` to `sink` for scripts that run on `object` (both null stops). */
  setDebugTrace(object: EngineObject | null, sink: ScriptDebugTrace | null): void {
    this.debugObject = object;
    this.debugSink = sink;
  }

  /** The breakpoints every run checks; null, or an empty set, checks none. */
  setBreakpoints(breakpoints: ScriptBreakpoints | null): void {
    this.breakpoints = breakpoints;
  }

  /** Times every entry point call while a profile records; null times none. */
  setCostMeter(meter: ScriptCostMeter | null): void {
    this.costMeter = meter;
  }

  /** The driver installs persistence before authored Init/Begin Play hooks run. */
  setSaveGameService(service: SaveGameService | undefined): void {
    this.services.saveGame = service;
  }

  /** Migration exceptions must propagate to the transaction, unlike ordinary events. */
  private async invokeSaveMigration(self: EngineObject, event: string, snapshot: SaveGameMigrationData): Promise<void> {
    if (self.destroyed) throw new SaveGameError("incompatible", "The registered save migration owner no longer exists.");
    const loaded = this.eventScriptsFor(self.classId, event, self);
    if (!loaded) throw new SaveGameError("incompatible", `Save migration event “${event}” is missing.`);
    for (const entry of loaded) {
      for (const point of entry.script.entryPoints) {
        if (point.event !== event) continue;
        const handler = entry.exports[point.name];
        if (typeof handler !== "function") continue;
        const context = this.createContext(self, 0, 0, { saveMigrationData: snapshot }, undefined, { saveMigrationData: snapshot }, entry.script.assetGuid);
        await this.invokeOwned(self, () => (handler as (ctx: ScriptContext) => unknown)(context));
      }
    }
  }

  async load(script: CompiledScript): Promise<void> {
    const scripts = [...this.byClassId.values()].flatMap((entries) => entries.map((entry) => entry.script));
    await this.replaceScripts([...scripts.filter((entry) => compiledScriptKey(entry) !== compiledScriptKey(script)), script]);
  }

  /** Prepare a complete owned union, retaining the previous valid modules on failure. */
  async replaceScripts(scripts: readonly CompiledScript[]): Promise<void> {
    const generation = ++this.sourceGeneration;
    const existing = new Map([...this.byClassId.values()].flat().map((entry) => [compiledScriptKey(entry.script), entry]));
    const prepared = new Map<string, LoadedScript[]>();
    for (const script of scripts) {
      const previous = existing.get(compiledScriptKey(script));
      const exports = previous?.script.source === script.source
        ? previous.exports : await loadCompiledModule(script.source, compiledScriptSourceLabel(script));
      if (generation !== this.sourceGeneration) throw new Error("Script preparation was superseded or disposed.");
      const entries = prepared.get(script.classId) ?? [];
      entries.push({ script, exports });
      prepared.set(script.classId, entries);
    }
    if (generation !== this.sourceGeneration) throw new Error("Script preparation was superseded or disposed.");
    this.byClassId.clear();
    for (const [classId, entries] of prepared) this.byClassId.set(classId, entries);
    this.clearLineageCaches();
    const retained = new Set(scripts.map((script) => script.assetGuid));
    for (const key of this.orphanFlowStates.keys()) if (!retained.has(key.split("\0", 1)[0]!)) this.orphanFlowStates.delete(key);
  }

  dispose(): void {
    ++this.sourceGeneration;
    this.byClassId.clear();
    this.clearLineageCaches();
    this.orphanFlowStates.clear();
  }

  private clearLineageCaches(): void {
    this.lineageByClassId.clear();
    this.hooksByClassId.clear();
    this.lifecycleScriptsByClassId.clear();
  }

  classIds(): string[] {
    return [...this.byClassId.keys()];
  }

  scriptsFor(classId: string): CompiledScript[] {
    return (this.byClassId.get(classId) ?? []).map((entry) => entry.script);
  }

  /**
   * Loaded scripts of `classId`, then of each user-class ancestor, nearest
   * first. Scripts keyed by a locked engine id answer only for that exact id
   * and are never inherited.
   */
  private scriptLineage(classId: string): readonly LoadedScript[][] {
    const cached = this.lineageByClassId.get(classId);
    if (cached) return cached;
    const lineage: LoadedScript[][] = [];
    const own = this.byClassId.get(classId);
    if (own && own.length > 0) lineage.push(own);
    const ancestry = this.services.classRegistry?.ancestry(classId) ?? [];
    for (const ancestorId of ancestry.slice(1)) {
      const loaded = this.byClassId.get(ancestorId);
      if (!loaded || loaded.length === 0) continue;
      // Engine bases only have engine ancestors.
      if (isLockedEngineClassId(ancestorId)) break;
      lineage.push(loaded);
    }
    this.lineageByClassId.set(classId, lineage);
    return lineage;
  }

  /**
   * The nearest class in `classId`'s lineage that implements `event`. A class
   * that implements an event replaces its ancestors' implementation; Call
   * Parent (`ctx.invokeEvent`) reaches an ancestor explicitly.
   */
  private eventScriptsFor(
    classId: string,
    event: string,
    self: EngineObject | null,
    componentId?: string,
  ): LoadedScript[] | undefined {
    return this.scriptLineage(classId).find((loaded) =>
      loaded.some((entry) =>
        entry.script.entryPoints.some(
          (point) =>
            point.event === event &&
            typeof entry.exports[point.name] === "function" &&
            entryMatchesComponentInvoke(point.componentId, componentId, self),
        ),
      ),
    );
  }

  /** The nearest class in `classId`'s lineage that exports function `exportName`. */
  private functionScriptsFor(
    classId: string,
    exportName: string,
  ): LoadedScript[] | undefined {
    return this.scriptLineage(classId).find((loaded) =>
      loaded.some((entry) => typeof entry.exports[exportName] === "function"),
    );
  }

  /**
   * `eventScriptsFor` for a lifecycle event the host invokes without a
   * component id. That result ignores `self`, so it is cached per class.
   */
  private lifecycleScriptsFor(classId: string, event: string): LoadedScript[] | undefined {
    let byEvent = this.lifecycleScriptsByClassId.get(classId);
    if (!byEvent) this.lifecycleScriptsByClassId.set(classId, byEvent = new Map());
    const cached = byEvent.get(event);
    if (cached !== undefined) return cached ?? undefined;
    const loaded = this.eventScriptsFor(classId, event, null);
    byEvent.set(event, loaded ?? null);
    return loaded;
  }

  /**
   * Lifecycle hooks for `classId`. Each event runs the nearest implementation
   * in the class lineage, so a child inherits its parent's events. Creation is
   * On Init for the Game Instance and subsystems, Begin Play for the rest.
   * The hooks carry no per-object state, so one object serves every instance.
   */
  hooksFor(classId: string): LifecycleHooks<EngineObject> | undefined {
    const cached = this.hooksByClassId.get(classId);
    if (cached) return cached;
    if (this.scriptLineage(classId).length === 0) return undefined;
    const ancestry = this.services.classRegistry?.ancestry(classId) ?? [classId];
    const creationEvent =
      ancestry.includes("GameInstance") || ancestry.includes(SUBSYSTEM_CLASS_ID)
        ? "onInit"
        : "onBeginPlay";
    const hooks: LifecycleHooks<EngineObject> = {
      onCreation: (self) => {
        const loaded = this.lifecycleScriptsFor(classId, creationEvent);
        if (loaded) this.dispatchEvent(loaded, creationEvent, self, 0, 0);
      },
      onTick: (self, ctx: TickContext) => {
        const loaded = this.lifecycleScriptsFor(classId, "onTick");
        if (!loaded) return;
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
        const loaded = this.lifecycleScriptsFor(classId, "onDestroyed");
        if (loaded) this.dispatchFinalEvent(loaded, "onDestroyed", self);
      },
    };
    this.hooksByClassId.set(classId, hooks);
    return hooks;
  }

  invokeCommand(
    classId: string,
    args: Record<string, unknown>,
  ): { success: boolean; output: string } {
    const loaded = this.byClassId.get(classId);
    if (!loaded || loaded.length === 0) {
      return { success: false, output: `unknown command class ${classId}` };
    }
    // Each run owns its result, so a nested command cannot replace it.
    const result = { success: true, output: "" };
    const failure = this.dispatchEvent(loaded, "onCommandRun", null, 0, 0, args, undefined, { commandResult: result });
    if (failure) return { success: false, output: failure.error instanceof Error ? failure.error.message : String(failure.error) };
    return result;
  }

  async invokeCommandAsync(classId: string, args: Record<string, unknown>, signal: AbortSignal): Promise<{ success: boolean; output: string }> {
    const loaded = this.byClassId.get(classId);
    if (!loaded?.length) return { success: false, output: `Unknown command class ${classId}` };
    const result = { success: true, output: "" };
    for (const entry of loaded) for (const point of entry.script.entryPoints) {
      if (point.event !== "onCommandRun") continue;
      const fn = entry.exports[point.name];
      if (typeof fn !== "function") continue;
      signal.throwIfAborted();
      const ctx = this.createContext(null, 0, 0, args, undefined, { commandResult: result }, entry.script.assetGuid);
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason ?? new Error("Console command cancelled"));
        signal.addEventListener("abort", abort, { once: true });
        Promise.resolve().then(() => {
          signal.throwIfAborted();
          return this.invokeOwned(null, () => (fn as (ctx: ScriptContext) => unknown)(ctx));
        }).then(() => resolve(), reject).finally(() => signal.removeEventListener("abort", abort));
      });
    }
    return result;
  }

  /**
   * Final-lifecycle dispatch: the driver calls this only for the Game
   * Instance's shutdown events and a subsystem's On End. Only the dying
   * object's synchronous calls into itself bypass owner admission.
   */
  invokeGameShutdownEvent(classId: string, event: "onEnd" | "onSceneExit", self: EngineObject, args: Record<string, unknown> = {}): void {
    const loaded = this.eventScriptsFor(classId, event, self);
    if (loaded) this.dispatchFinalEvent(loaded, event, self, args);
  }

  private dispatchFinalEvent(loaded: readonly LoadedScript[], event: string, self: EngineObject, args: Record<string, unknown> = {}): void {
    const previous = this.finalizingOwner;
    this.finalizingOwner = self;
    try {
      this.dispatchEvent(loaded, event, self, 0, 0, args);
    } finally {
      this.finalizingOwner = previous;
    }
  }

  private canInvokeOwner(owner: EngineObject): boolean {
    // Only synchronous calls from the finalizing object itself inherit its final
    // lifecycle. Calling through another object must reapply normal admission.
    if (owner === this.finalizingOwner && owner === this.invokingOwner) return true;
    return !owner.destroyed && this.services.canRunOwner?.(owner) !== false;
  }

  /**
   * Report a latent script failure. A continuation cancelled because `owner`
   * was destroyed (a counting Delay, or one Pause or a blocking load held)
   * ends that owner's graph quietly, like a cancelled tween.
   */
  private reportLatentError(error: unknown, owner: EngineObject | null): void {
    if (owner?.destroyed && error instanceof RuntimeContinuationCancelled && error.reason === "ownerDestroyed") return;
    this.services.reportError(error);
  }

  private invokeOwned<T>(owner: EngineObject | null, invoke: () => T): T {
    const previous = this.invokingOwner;
    this.invokingOwner = owner;
    try {
      return invoke();
    } finally {
      this.invokingOwner = previous;
    }
  }

  /** `invokeOwned` for a compiled entry point, which the cost meter times while a profile records. */
  private invokeEntry<T>(owner: EngineObject | null, script: CompiledScript, exportName: string, invoke: () => T): T {
    const meter = this.costMeter;
    if (meter === null) return this.invokeOwned(owner, invoke);
    meter.enter(script, exportName);
    try {
      return this.invokeOwned(owner, invoke);
    } finally {
      meter.exit();
    }
  }

  /** Fire a compiled entry point (Begin Play, Tick, or a custom event name). */
  invokeEvent(
    classId: string,
    event: string,
    self: EngineObject | null = null,
    args: Record<string, unknown> = {},
    componentId?: string,
  ): void {
    const loaded = this.eventScriptsFor(classId, event, self, componentId);
    if (!loaded) return;
    if (self && !this.canInvokeOwner(self)) return;
    this.dispatchEvent(loaded, event, self, 0, 0, args, undefined, undefined, componentId);
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
   * Push an engine task's pose write (Behaviour Tree Rotate To Face) to the
   * actor's physics body through the same binding script transform writes use.
   */
  teleportActor(actor: Actor): void {
    this.services.teleportActor?.(actor);
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
      const result = this.invokeEntry(self, loaded[0]!.script, "evaluate", () => (evaluate as (context: ScriptContext) => unknown)(ctx));
      if (!result || typeof result !== "object") return undefined;
      const row = result as { enter?: unknown; exit?: unknown };
      return {
        enter: row.enter !== false,
        exit: row.exit !== false,
      };
    } catch (error) {
      this.services.reportError(error);
      if (isInfiniteLoopError(error)) throw error;
      return undefined;
    }
  }

  /**
   * Register compiled function implementations as interface handlers on `object`.
   * Keys match `interfaceHandlerKey` (`guid:method`). Implementations declared by
   * user ancestors are inherited; the nearest declaring class wins.
   */
  bindInterfaceHandlers(object: EngineObject): void {
    for (const key of this.boundInterfaceKeys.get(object) ?? []) object.interfaceHandlers.delete(key);
    const owned = new Set<string>();
    this.boundInterfaceKeys.set(object, owned);
    const lineage = this.scriptLineage(object.classId);
    if (lineage.length === 0) return;
    for (const iface of object.implementedInterfaces) {
      // Farthest ancestor first so nearer declarations replace its handlers.
      for (const loaded of [...lineage].reverse()) {
        for (const entry of loaded) {
          for (const impl of entry.script.interfaceImplementations ?? []) {
            if (impl.interfaceGuid !== iface) continue;
            const exportName = impl.exportName;
            const key = interfaceHandlerKey(iface, impl.method);
            owned.add(key);
            object.interfaceHandlers.set(key, this.boundInterfaceHandler(object, entry.script.assetGuid, entry.script.classId, exportName));
          }
        }
      }
    }
  }

  private boundInterfaceHandler(object: EngineObject, assetGuid: string, classId: string, exportName: string): (args: Record<string, unknown>) => Record<string, unknown> {
    // Keep only identities in the live object's callback; a revised module
    // must not stay rooted through an older interface binding.
    return (args) => {
      for (const loaded of this.scriptLineage(object.classId)) {
        const entry = loaded.find((candidate) => candidate.script.assetGuid === assetGuid && candidate.script.classId === classId);
        if (entry) return this.invokeInterfaceHandler(object, loaded, entry, exportName, args);
      }
      return {};
    };
  }

  /**
   * Run an interface implementation on `object`. A class between `object` and
   * the declaring class that overrides the implementing function runs instead.
   */
  private invokeInterfaceHandler(
    object: EngineObject,
    declaringScripts: readonly LoadedScript[],
    declaringEntry: LoadedScript,
    exportName: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    if (!this.canInvokeOwner(object)) return {};
    let entry = declaringEntry;
    for (const loaded of this.scriptLineage(object.classId)) {
      if (loaded === declaringScripts) break;
      const override = loaded.find(
        (candidate) => typeof candidate.exports[exportName] === "function",
      );
      if (override) {
        entry = override;
        break;
      }
    }
    const fn = entry.exports[exportName];
    if (typeof fn !== "function") return {};
    // The handler runs inside its caller's frame, so input and delta reads match the caller.
    const frame = this.interfaceCaller;
    const ctx = this.createContext(
      object,
      frame?.deltaSeconds ?? 0,
      frame?.tickIndex ?? 0,
      args,
      frame?.tick,
      undefined,
      entry.script.assetGuid,
    );
    try {
      const result = this.invokeEntry(object, entry.script, exportName, () => (fn as (ctx: ScriptContext) => unknown)(ctx));
      if (result instanceof Promise) {
        // Call Interface is not latent: a latent implementation's outputs are the pin defaults.
        void result.catch((error) => this.reportLatentError(error, object));
        return {};
      }
      return (
        result && typeof result === "object" && !Array.isArray(result)
          ? result
          : {}
      ) as Record<string, unknown>;
    } catch (error) {
      // The calling script's dispatcher reports the loop abort once.
      if (isInfiniteLoopError(error)) throw error;
      this.services.reportError(error);
      return {};
    }
  }

  /**
   * Runs every matching entry. A synchronous throw is reported and the
   * remaining entries still run; the first such throw is returned, and an
   * infinite-loop error is rethrown to abort the tick.
   */
  private dispatchEvent(
    loaded: readonly LoadedScript[],
    event: string,
    self: EngineObject | null,
    deltaSeconds: number,
    tickIndex: number,
    commandArgs: Record<string, unknown> = {},
    tick?: TickContext,
    extras?: ScriptExtras,
    componentId?: string,
  ): { error: unknown } | null {
    let failure: { error: unknown } | null = null;
    for (const entry of loaded) {
      for (const point of entry.script.entryPoints) {
        if (point.event !== event) continue;
        if (!entryMatchesComponentInvoke(point.componentId, componentId, self)) {
          continue;
        }
        const fn = entry.exports[point.name];
        if (typeof fn !== "function") continue;
        // Only a latent entry point is checked for a pending run; the synchronous common path builds no key.
        const latentKey = self && point.isAsync ? `${entry.script.assetGuid}:${point.name}` : undefined;
        if (self && latentKey !== undefined && this.isPending(self, latentKey)) continue;
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
          const result = this.invokeEntry(self, entry.script, point.name, () => (fn as (ctx: ScriptContext) => unknown)(ctx));
          if (result instanceof Promise) {
            const key = latentKey ?? `${entry.script.assetGuid}:${point.name}`;
            if (self) this.markPending(self, key);
            void result
              .catch((error) => this.reportLatentError(error, self))
              .finally(() => {
                if (self) this.clearPending(self, key);
              });
          }
        } catch (error) {
          this.services.reportError(error);
          if (isInfiniteLoopError(error)) throw error;
          failure ??= { error };
        }
      }
    }
    return failure;
  }

  private isPending(self: EngineObject, key: string): boolean {
    return this.pending.get(self)?.has(key) ?? false;
  }

  private markPending(self: EngineObject, key: string): void {
    const set = this.pending.get(self) ?? new Set<string>();
    set.add(key);
    this.pending.set(self, set);
  }

  private clearPending(self: EngineObject, key: string): void {
    this.pending.get(self)?.delete(key);
  }

  private clearFlowState(self: EngineObject | null | undefined): void {
    if (self) this.flowStates.delete(self);
  }

  private flowStateFor(
    self: EngineObject | null,
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

  /** The trace `ctx.debugTrace` reads: the debugger's sink for the instance it follows, else null. */
  private debugTraceFor(store: unknown): ScriptDebugTrace | null {
    return this.debugObject !== null && store === this.debugObject ? this.debugSink : null;
  }

  /** Runs `run` with `frame` as the `ctx.callInterface` caller, restoring the previous caller after. */
  private withInterfaceCaller<T>(frame: CallerFrame, run: () => T): T {
    const previous = this.interfaceCaller;
    this.interfaceCaller = frame;
    try {
      return run();
    } finally {
      this.interfaceCaller = previous;
    }
  }

  /**
   * A context for one script call. It owns what depends on the call (self, tick, arguments, extras, the
   * calling object's defaults) and inherits the rest from the host's shared members, so it allocates
   * only the closures that need the call's values. Inherited members never use `this`, so detaching one
   * (`const { log } = ctx`) works. Own properties are therefore only the per-call members.
   * Adding a `ScriptContext` member that is not a `HostContextKey` means assigning it in `createScriptContext`,
   * and listing it in `script-host-context.test.ts`, whose type check fails until you do.
   */
  createContext(
    self: EngineObject | null,
    deltaSeconds: number,
    tickIndex: number,
    commandArgs: Record<string, unknown> = {},
    tick?: TickContext,
    extras?: ScriptExtras,
    flowNamespace = "",
  ): ScriptContext {
    return createScriptContext(this.contextHost, self, deltaSeconds, tickIndex, commandArgs, tick, extras, flowNamespace);
  }

  private applyComponentVariable(
    component: ActorComponent,
    name: string,
    value: unknown,
    previous?: unknown,
  ): void {
    this.services.refreshComponent?.(component, name);
    // On Text Changed fires only on a change, and a text write from inside
    // that component's own handler applies without firing it again, so a
    // handler that rewrites the text cannot recurse.
    if (name === "text" && isTextComponent(component) && value !== previous &&
      !this.textChangeDispatches.has(component)) {
      this.textChangeDispatches.add(component);
      try {
        this.fireComponentOwnerEvent(component, "onTextChanged", {
          text: value,
        });
      } finally {
        this.textChangeDispatches.delete(component);
      }
    }
  }

  private fireComponentOwnerEvent(
    component: ActorComponent,
    event: string,
    args: Record<string, unknown>,
  ): void {
    const owner = component.owner;
    if (!owner) return;
    this.invokeEvent(owner.classId, event, owner, args, component.guid);
  }
}
