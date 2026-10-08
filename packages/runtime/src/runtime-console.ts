import type { CommandMessage, GameSessionMode } from "@babylonslate/bridge";
import {
  DEFAULT_PLAY_FRAME_CAP,
  type RenderPath,
  type RenderPathStatus,
  type ScalabilityRequest,
  type ScalabilitySession,
} from "@babylonslate/core";
import {
  createCommandRegistry,
  createUserCommand,
  isReservedConsoleCommandName,
  matchCommandName,
  parseCommandArgs,
  tokenize,
  type CommandRegistry,
  type CommandResult,
  type ConsoleCommandHost,
  type RegisteredCommand,
  type UserCommandDef,
} from "@babylonslate/debugger";
import { Actor, type DebugInspectSnapshot, type World } from "@babylonslate/object-model";
import type { RuntimeAssetPreloads } from "./asset-preloads";
import type { AudioParticleEmitter } from "./audio-particle-emitter";
import type { BehaviourTreeRuntime } from "./behaviour-tree-runtime";
import { formatDumpActors, formatInspectActor } from "./console-inspect";
import type { LogRingBuffer } from "./log-ring";
import type { RuntimeNavigation } from "./runtime-navigation";
import type { RuntimePhysicsWorlds } from "./runtime-physics-worlds";
import type { SceneRealizer } from "./scene-realizer";
import type { ScriptHost } from "./script-host";
import type { SnapshotPublisher } from "./snapshot-publisher";
import type { TickPipeline } from "./tick-pipeline";

interface RuntimeConsoleOptions {
  /** When false, debug-tier commands are stripped. */
  includeDebug: boolean;
  /** User commands acquire their Class asset on demand before they run. */
  demandAssetCatalog: boolean;
}

interface RuntimeConsoleHost {
  world(): World;
  stopped(): boolean;
  sessionMode(): GameSessionMode;
  /** The asset guid of a Class, when known. */
  classAssetGuid(classId: string): string | undefined;
  scriptHost(): Pick<ScriptHost, "invokeCommand" | "invokeCommandAsync">;
  assetPreloads(): Pick<RuntimeAssetPreloads, "getState" | "acquire" | "release">;
  sceneRealizer(): Pick<SceneRealizer, "change">;
  scalability(): Pick<ScalabilitySession, "executeQuality" | "requested">;
  requestScalability(request: ScalabilityRequest): void;
  projectRenderPath(): RenderPath;
  renderPathStatus(): RenderPathStatus | null;
  physics(): Pick<RuntimePhysicsWorlds, "setShowCollision" | "main" | "overlay" | "emitDebugColliders">;
  navigation(): Pick<RuntimeNavigation, "setShowPathfinding" | "setShowNavAgent">;
  behaviourTrees(): Pick<BehaviourTreeRuntime, "setDebug">;
  audioParticles(): Pick<AudioParticleEmitter, "stopAudio" | "stopParticles">;
  ticks(): Pick<TickPipeline, "processing" | "startTrace" | "finalizeTrace">;
  snapshots(): Pick<SnapshotPublisher, "publish">;
  /** The driver's log ring, which `emit()` and every log line write. */
  logs(): Pick<LogRingBuffer, "entries">;
  inspectWorld(): DebugInspectSnapshot;
  actorSlot(actor: Actor): number | undefined;
  possessCamera(actor: Actor): void;
  stop(): void;
  pause(): void;
  resume(): void;
  tick(): void;
  paused(): boolean;
  /** Whether the user pause reason is held. */
  userPaused(): boolean;
  timeDilation(): number;
  setTimeDilation(rate: number): void;
  emit(command: CommandMessage): void;
}

/**
 * The Play console host on the driver side: the command registry (builtins
 * and user commands), user command Class bindings with on-demand asset
 * preparation and the session-lifetime abort signal, the `ConsoleCommandHost`
 * adapter that runs builtins against driver subsystems, console actor lookup
 * and the console volume. Parsing, dispatch and builtin handlers live in
 * `@babylonslate/debugger`. The driver keeps the log ring and time dilation,
 * and calls `stop()` explicitly in Stop. It is not a registered subsystem.
 */
export class RuntimeConsole {
  private readonly commands: CommandRegistry;
  private readonly commandClasses = new Map<string, { classId: string; assetGuid: string }>();
  private readonly lifetime = new AbortController();
  private readonly demandAssetCatalog: boolean;
  private flushingActors = false;
  private volume = 1;
  private readonly host: RuntimeConsoleHost;

  constructor(options: RuntimeConsoleOptions, host: RuntimeConsoleHost) {
    this.commands = createCommandRegistry({ includeDebug: options.includeDebug });
    this.demandAssetCatalog = options.demandAssetCatalog;
    this.host = host;
  }

  execute(command: string): { success: boolean; output: string } {
    const { name } = matchCommandName(tokenize(command.trim()), new Set(this.commands.list().map(entry => entry.name.toLowerCase())));
    const user = this.commandClasses.get(name);
    if (this.demandAssetCatalog && user && this.host.assetPreloads().getState(user.assetGuid) !== "ready") {
      return { success: false, output: `Command ${name} is not prepared; use executeConsoleCommandAsync` };
    }
    return this.commands.execute(command, this.commandHost());
  }

  async executeAsync(command: string): Promise<CommandResult> {
    if (this.host.stopped()) return { success: false, output: "The runtime session has ended" };
    const { name, rest } = matchCommandName(tokenize(command.trim()), new Set(this.commands.list().map(entry => entry.name.toLowerCase())));
    const user = this.commandClasses.get(name);
    if (!user) return this.execute(command);
    const definition = this.commands.get(name);
    if (!definition) return { success: false, output: `Unknown command: ${name}` };
    const parsed = parseCommandArgs(rest, definition.parameters);
    if (!parsed.ok) return { success: false, output: parsed.output };
    let preloadId = "";
    try {
      if (this.demandAssetCatalog) {
        const result = await this.host.assetPreloads().acquire([user.assetGuid], `Console Command ${name}`);
        if (!result.success) return { success: false, output: `Command ${name} (${user.assetGuid}): ${result.errorMessage}` };
        preloadId = result.preloadId;
      }
      this.lifetime.signal.throwIfAborted();
      return await this.host.scriptHost().invokeCommandAsync(user.classId, parsed.args, this.lifetime.signal);
    } catch (error) {
      return { success: false, output: `Command ${name}: ${error instanceof Error ? error.message : String(error)}` };
    } finally {
      if (preloadId) this.host.assetPreloads().release(preloadId);
    }
  }

  register(def: UserCommandDef): void {
    this.commands.register(createUserCommand(def));
  }

  bind(def: Omit<UserCommandDef, "run"> & { classId: string }): void {
    if (isReservedConsoleCommandName(def.name.toLowerCase())) return;
    const guid = this.host.classAssetGuid(def.classId);
    if (guid) this.commandClasses.set(def.name.toLowerCase(), { classId: def.classId, assetGuid: guid });
    this.register({
      ...def,
      run: (args) => this.host.scriptHost().invokeCommand(def.classId, args),
    });
  }

  list(): readonly RegisteredCommand[] {
    return this.commands.list();
  }

  /** Stop: end the session lifetime, cancelling pending user command preparation. */
  stop(): void {
    this.lifetime.abort(new Error("The runtime session has ended"));
  }

  private commandHost(): ConsoleCommandHost {
    const host = this.host;
    return {
      changeScene: (scene) => host.sceneRealizer().change(scene),
      quality: (group, choice, value) => host.scalability().executeQuality(group, choice, value),
      setRenderPath: (path) => {
        host.requestScalability({ kind: "patch", render: { renderPath: path ?? host.projectRenderPath() } });
      },
      getRenderPath: () => host.renderPathStatus(),
      setLightsDebug: (enabled) => host.emit({ type: "setLightsDebug", enabled }),
      setFrameCap: (fps) => {
        host.requestScalability({ kind: "patch", frameCap: fps > 0 ? fps : DEFAULT_PLAY_FRAME_CAP });
      },
      getFrameCap: () => host.scalability().requested.frameCap,
      setVolume: (volume) => {
        this.volume = Number(volume);
        host.emit({ type: "setGlobalVolume", volume: this.volume });
      },
      getVolume: () => this.volume,
      quit: () => {
        host.stop();
      },
      setShowFps: (enabled) => {
        host.emit({ type: "setShowFps", enabled: Boolean(enabled) });
      },
      setStat: (name, enabled) => {
        if (enabled) host.emit({ type: "setShowFps", enabled: true });
        host.emit({ type: "setStat", name, enabled: Boolean(enabled) });
      },
      setShowCollision: (enabled) => host.physics().setShowCollision(enabled),
      setShowBounds: (enabled) => {
        host.emit({ type: "setShowBounds", enabled: Boolean(enabled) });
      },
      setWireframe: (enabled) => {
        host.emit({ type: "setWireframe", enabled: Boolean(enabled) });
      },
      setShowNav: (enabled) => {
        host.emit({ type: "setShowNav", enabled: Boolean(enabled) });
      },
      setShowPathfinding: (enabled) => host.navigation().setShowPathfinding(enabled),
      setShowNavAgent: (enabled) => host.navigation().setShowNavAgent(enabled),
      setBehaviourTreeDebug: (enabled) => host.behaviourTrees().setDebug(enabled),
      setShowAudioDebug: (enabled) => {
        host.emit({ type: "setShowAudioDebug", enabled: Boolean(enabled) });
      },
      dumpActors: () => formatDumpActors(host.inspectWorld()),
      inspectActor: (query) =>
        formatInspectActor(host.inspectWorld(), query, null),
      possessActorCamera: (query) => {
        const target = this.resolveActor(query);
        if (!(target instanceof Actor)) return target;
        if (!target.components.some((component) =>
          component.classId === "CameraComponent" && !component.destroyed,
        ) || host.actorSlot(target) === undefined) {
          return { success: false, output: `actor '${query}' has no live camera` };
        }
        host.emit({ type: "setFreeCam", enabled: false });
        host.possessCamera(target);
        return { success: true, output: `possessed ${target.guid}` };
      },
      destroyActor: (query) => {
        const target = this.resolveActor(query);
        if (!(target instanceof Actor)) return target;
        host.audioParticles().stopAudio(target);
        host.audioParticles().stopParticles(target);
        host.world().destroyActor(target.guid);
        if (!host.ticks().processing && !this.flushingActors) {
          this.flushingActors = true;
          try {
            const world = host.world();
            world.flushPending();
            host.physics().main.syncFromWorld(world);
            host.physics().overlay.syncFromWorld(world);
            host.snapshots().publish();
            host.physics().emitDebugColliders();
          } finally {
            this.flushingActors = false;
          }
        }
        return { success: true, output: `destroyed ${target.guid}` };
      },
      setFreeCam: (enabled) => {
        host.emit({ type: "setFreeCam", enabled: Boolean(enabled) });
      },
      pause: () => {
        host.pause();
        host.emit({ type: "sessionPaused", paused: host.paused() });
      },
      resume: () => {
        host.resume();
        host.emit({ type: "sessionPaused", paused: host.paused() });
      },
      step: () => {
        const wasPaused = host.userPaused();
        host.resume();
        host.tick();
        if (wasPaused) host.pause();
      },
      setTimeDilation: (rate) => {
        host.setTimeDilation(Math.min(8, Math.max(0, Number(rate))));
      },
      getTimeDilation: () => host.timeDilation(),
      dumpLog: () =>
        host.logs()
          .entries()
          .map((entry) => entry.message)
          .join("\n"),
      startSnapshot: () => {
        if (host.sessionMode() === "simulate") return { success: false, output: "Use Play or Preview Build to record diagnostics." };
        return host.ticks().startTrace();
      },
      stopSnapshot: () => {
        host.ticks().finalizeTrace();
      },
    };
  }

  private resolveActor(query: string): Actor | CommandResult {
    const key = query.trim();
    if (!key) return { success: false, output: "an actor GUID or unique exact name is required" };
    const actors = this.host.world().getActors().filter((actor) => !actor.destroyed);
    const byGuid = actors.find((actor) => actor.guid === key);
    if (byGuid) return byGuid;
    const matches = actors.filter((actor) => {
      const name = actor.getVariable("name");
      return (typeof name === "string" && name.length > 0 ? name : actor.classId) === key;
    });
    if (matches.length === 1) return matches[0]!;
    return {
      success: false,
      output: matches.length > 1
        ? `actor name '${key}' is ambiguous; use its GUID`
        : `no live actor matches '${key}'`,
    };
  }
}
