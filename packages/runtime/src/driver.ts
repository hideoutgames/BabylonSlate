import {
  SeqLockSnapshotPair,
  writeActorSlot,
  writeSnapshotHeader,
  type CommandMessage,
} from "@babylonslate/bridge";
import {
  ClassRegistry,
  GameInstance,
  World,
  type Actor,
} from "@babylonslate/object-model";
import {
  InputRingBuffer,
  decodeInputEvents,
  type RawInputEvent,
} from "@babylonslate/input";
import { LogRingBuffer } from "./log-ring";
import {
  SessionDiagnosticAggregator,
  type RuntimeDiagnostic,
} from "./diagnostics";
import { mapStackToAnchor, type AnchorEntry } from "./stack-map";

export type TransportMode = "in-process" | "sab" | "transferable";

export interface RuntimeDriverOptions {
  seed: number;
  dt?: number;
  maxActors?: number;
  maxCatchUpSteps?: number;
  onCommand?: (command: CommandMessage) => void;
}

export interface RuntimeDriver {
  start(): void;
  stop(): void;
  pause(): void;
  resume(): void;
  tick(): void;
  /** Fixed-step catch-up from wall/accumulated time; capped. */
  advance(elapsedSeconds: number): void;
  pushInput(events: readonly RawInputEvent[]): void;
  pushInputBuffer(buffer: ArrayBuffer): void;
  copySnapshot(out: Float32Array): boolean;
  getWorld(): World;
  getLogRing(): LogRingBuffer;
  getDiagnostics(): SessionDiagnosticAggregator;
  registerAnchors(assetGuid: string, anchors: readonly AnchorEntry[]): void;
  reportError(error: unknown, frameId?: number): RuntimeDiagnostic | null;
  readonly transportMode: TransportMode;
}

export function createInProcessRuntime(
  options: RuntimeDriverOptions,
): RuntimeDriver {
  return new InProcessRuntime(options, "in-process");
}

class InProcessRuntime implements RuntimeDriver {
  readonly transportMode: TransportMode;
  private readonly world: World;
  private readonly snapshots: SeqLockSnapshotPair;
  private readonly input = new InputRingBuffer(512);
  private readonly logs = new LogRingBuffer(512);
  private readonly diagnostics = new SessionDiagnosticAggregator();
  private readonly anchors = new Map<string, readonly AnchorEntry[]>();
  private readonly onCommand?: (command: CommandMessage) => void;
  private readonly maxCatchUp: number;
  private readonly dt: number;
  private accumulator = 0;
  private paused = false;
  private running = false;
  private frameId = 0;
  private slotByGuid = new Map<string, number>();
  private nextSlot = 0;
  private lastScriptMs = 0;
  private lastPhysicsMs = 0;

  constructor(options: RuntimeDriverOptions, mode: TransportMode) {
    this.transportMode = mode;
    this.dt = options.dt ?? 1 / 60;
    this.maxCatchUp = options.maxCatchUpSteps ?? 4;
    this.onCommand = options.onCommand;
    const maxActors = options.maxActors ?? 256;
    this.snapshots = SeqLockSnapshotPair.create(maxActors);

    const registry = new ClassRegistry();
    registry.register({
      id: "Enemy",
      parentClassId: "Actor",
      kind: "actor",
      variables: [{ name: "speed", type: "float", defaultValue: 1 }],
      implementedInterfaces: [],
    });

    let guidSeq = 0;
    this.world = new World({
      seed: options.seed,
      dt: this.dt,
      classRegistry: registry,
      guidFactory: () => `rt-${++guidSeq}`,
      onPhase: (phase, _dt, _tick) => {
        // Timing hooks measure script vs physics phases.
        void phase;
      },
    });

    this.world.setGameInstance(
      new GameInstance({
        classId: "GameInstance",
        guid: "runtime-gi",
        variables: { ticks: 0 },
        hooks: {
          onTick: (self) => {
            self.setVariable(
              "ticks",
              Number(self.getVariable("ticks")) + 1,
            );
          },
        },
      }),
    );

    this.seedDefaultActors();
  }

  private seedDefaultActors(): void {
    const actor = this.world.createActor({
      classId: "Enemy",
      variables: { speed: 1, n: 0 },
      hooks: {
        onTick: (self, ctx) => {
          const speed = Number(self.getVariable("speed") ?? 1);
          const bump = ctx.world.rngNextFloat() * speed;
          self.setVariable("n", Number(self.getVariable("n")) + bump);
          self.transform.position.x += bump;
          self.transform.position.y += bump * 0.5;
        },
      },
    });
    this.world.spawnActorNow(actor);
    this.assignSlot(actor);

    const second = this.world.createActor({
      classId: "Actor",
      variables: { tag: "follower" },
      hooks: {
        onTick: (self, ctx) => {
          self.transform.position.z += ctx.world.rngNextFloat() * 0.1;
        },
      },
    });
    this.world.spawnActorNow(second);
    this.assignSlot(second);
  }

  private assignSlot(actor: Actor): number {
    const slotId = this.nextSlot++;
    this.slotByGuid.set(actor.guid, slotId);
    this.emit({
      type: "spawn",
      slotId,
      actorGuid: actor.guid,
      classId: actor.classId,
    });
    return slotId;
  }

  private emit(command: CommandMessage): void {
    this.onCommand?.(command);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.paused = false;
    this.world.start();
  }

  stop(): void {
    this.running = false;
    this.world.end();
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  pushInput(events: readonly RawInputEvent[]): void {
    for (const event of events) {
      this.input.push(event);
    }
  }

  pushInputBuffer(buffer: ArrayBuffer): void {
    this.pushInput(decodeInputEvents(buffer));
  }

  tick(): void {
    if (!this.running || this.paused) return;
    // Consume input stamped for this tick (and earlier).
    const tickIndex = this.world.clock.tickIndex;
    const pending = this.input.drain().filter((e) => e.tick <= tickIndex + 1);
    void pending;

    const scriptStart = nowMs();
    this.world.tick();
    this.lastScriptMs = nowMs() - scriptStart;
    // Physics phase is reserved; measured separately once P7 fills it.
    this.lastPhysicsMs = 0;

    this.frameId += 1;
    this.publishSnapshot();
    this.emit({
      type: "stats",
      frameId: this.frameId,
      tickIndex: this.world.clock.tickIndex,
      scriptMs: this.lastScriptMs,
      physicsMs: this.lastPhysicsMs,
    });
  }

  advance(elapsedSeconds: number): void {
    if (!this.running || this.paused) return;
    this.accumulator += elapsedSeconds;
    let steps = 0;
    while (this.accumulator >= this.dt && steps < this.maxCatchUp) {
      this.tick();
      this.accumulator -= this.dt;
      steps += 1;
    }
    if (steps === this.maxCatchUp) {
      this.accumulator = 0;
    }
  }

  copySnapshot(out: Float32Array): boolean {
    return this.snapshots.tryRead(out);
  }

  getWorld(): World {
    return this.world;
  }

  getLogRing(): LogRingBuffer {
    return this.logs;
  }

  getDiagnostics(): SessionDiagnosticAggregator {
    return this.diagnostics;
  }

  registerAnchors(assetGuid: string, anchors: readonly AnchorEntry[]): void {
    this.anchors.set(assetGuid, anchors);
  }

  reportError(error: unknown, frameId = this.frameId): RuntimeDiagnostic | null {
    const err = error instanceof Error ? error : new Error(String(error));
    const stack = err.stack ?? "";
    const anchor = mapStackToAnchor(stack, this.anchors);
    const diag: RuntimeDiagnostic = {
      code: "runtime.uncaught",
      message: err.message,
      severity: "error",
      assetGuid: anchor?.assetGuid,
      graphId: anchor?.graphId,
      nodeId: anchor?.nodeId,
      bodyLine: anchor?.bodyLine,
      btNodeId: anchor?.btNodeId,
      stack,
      frameId,
      tickIndex: this.world.clock.tickIndex,
    };
    this.diagnostics.push(diag);
    this.logs.push({
      severity: "error",
      category: "runtime",
      message: err.message,
      frameId,
      tickIndex: this.world.clock.tickIndex,
    });
    this.emit({
      type: "diagnostic",
      code: diag.code,
      message: diag.message,
      assetGuid: diag.assetGuid,
      graphId: diag.graphId,
      nodeId: diag.nodeId,
      stack: diag.stack,
      frameId,
      severity: "error",
    });
    return diag;
  }

  private publishSnapshot(): void {
    const buf = this.snapshots.beginWrite();
    const actors = this.world.getActors();
    let count = 0;
    for (const actor of actors) {
      const slotId = this.slotByGuid.get(actor.guid);
      if (slotId === undefined) continue;
      writeActorSlot(buf, count, {
        slotId,
        position: actor.transform.position,
        rotation: actor.transform.rotation,
        scale: actor.transform.scale,
        flags: 1,
      });
      count += 1;
    }
    writeSnapshotHeader(buf, {
      frameId: this.frameId,
      tickIndex: this.world.clock.tickIndex,
      actorCount: count,
      scriptMs: this.lastScriptMs,
      physicsMs: this.lastPhysicsMs,
    });
    this.snapshots.publish();
  }
}

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
