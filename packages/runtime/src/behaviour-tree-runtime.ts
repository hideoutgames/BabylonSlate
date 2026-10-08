import type { CommandMessage, DebugBehaviourTree } from "@babylonslate/bridge";
import { eulerDegreesToQuaternion } from "@babylonslate/core";
import type { TraceBtState } from "@babylonslate/debugger";
import type { Actor, World } from "@babylonslate/object-model";
import type { PhysicsWorldKind } from "@babylonslate/physics";
import type { AnimClipCatalogEntry } from "@babylonslate/anim-graph";
import {
  evaluateBehaviourTree,
  builtinClassId,
  type BehaviourTreeDocument,
  type BlackboardDocument,
  type BlackboardValues,
  type BtEvalState,
  type BtResult,
} from "@babylonslate/behaviour-tree";
import { blackboardInspectTypes, blackboardTargetPosition, snapshotBlackboard } from "./bt-blackboard";
import type { RuntimeDiagnostic } from "./diagnostics";
import { navPointFromUnknown, type RuntimeNavigation } from "./runtime-navigation";
import type { RuntimeSubsystem } from "./runtime-subsystems";
import type { ScriptHost } from "./script-host";

type SpriteClip = { assetGuid: string; clipName: string; normalisedTime: number };

// Shallow BT memory copies retain this live activation, while trace JSON omits
// it. A resumed task writes to its current board and cannot finish a later run.
const BT_TASK_ACTIVATION = Symbol("btTaskActivation");
type BtTaskActivation = { active: boolean; blackboard: BlackboardValues; result?: "success" | "failure" };

interface BehaviourTreeRuntimeHost {
  world(): World;
  /** Frame index (live actor per guid) shared with the crowd tick. */
  frameActors(): ReadonlyMap<string, Actor> | undefined;
  stopped(): boolean;
  canTick(actor: Actor): boolean;
  /** The render slot this actor's own commands target. */
  slot(actor: Actor): number | undefined;
  /** MoveTo tasks steer the actor's crowd agent; Rotate To Face turns it. */
  navigation(): RuntimeNavigation;
  /** The main Scene's physics world kind; 2D faces in XY. */
  worldKind(): PhysicsWorldKind;
  seed(): number;
  frameId(): number;
  tickIndex(): number;
  scripts(): Pick<ScriptHost, "hasClass" | "invokeBtEvent">;
  setSpriteClip(actor: Actor, clip: SpriteClip | null): void;
  actorName(actor: Actor): string;
  recordDiagnostic(diagnostic: RuntimeDiagnostic): void;
  emit(command: CommandMessage): void;
}

/**
 * BehaviourTree and Blackboard documents, per-slot evaluation state, the
 * built-in and script task/decorator/service hosts, and the BT debug stream.
 */
export class BehaviourTreeRuntime implements RuntimeSubsystem {
  private readonly documents = new Map<string, BehaviourTreeDocument>();
  private readonly blackboards = new Map<string, BlackboardDocument>();
  private readonly evalBySlot = new Map<number, BtEvalState>();
  private readonly missingWarned = new Set<string>();
  private nodeId: string | null = null;
  private assetGuid: string | null = null;
  /** Audio asset guids known to this Play session (PlaySound fail-on-missing). */
  private readonly audioAssetGuids = new Set<string>();
  /** Animation / Sprite Animation clip metadata for Play Animation. */
  private readonly animClipCatalog = new Map<string, AnimClipCatalogEntry>();
  private readonly playAnimOwnedSlots = new Set<number>();
  private readonly voiceByActor = new Map<string, string>();
  private readonly lastStateJson = new Map<number, string>();
  private debug = false;
  private lastDebugMs = -Infinity;
  private readonly host: BehaviourTreeRuntimeHost;
  private readonly now: () => number;

  constructor(host: BehaviourTreeRuntimeHost, now: () => number) {
    this.host = host;
    this.now = now;
  }

  /** Any tree is loaded, so ticks build the shared frame index. */
  get hasTrees(): boolean {
    return this.documents.size > 0;
  }

  /** The task node being ticked, for diagnostics raised from its script. */
  get currentNodeId(): string | null {
    return this.nodeId;
  }

  /** The tree being ticked, for diagnostics raised from its scripts. */
  get currentAssetGuid(): string | null {
    return this.assetGuid;
  }

  register(guid: string, document: BehaviourTreeDocument): void {
    this.documents.set(guid, document);
  }

  registerBlackboard(guid: string, document: BlackboardDocument): void {
    this.blackboards.set(guid, document);
  }

  /** Drop trees and blackboards a replaced source catalog no longer retains. */
  retain(retained: ReadonlySet<string>): void {
    for (const map of [this.documents, this.blackboards]) for (const guid of map.keys()) if (!retained.has(guid)) map.delete(guid);
  }

  replaceAudioAssets(guids: Iterable<string>): void {
    this.audioAssetGuids.clear();
    for (const guid of guids) this.audioAssetGuids.add(guid);
  }

  replaceAnimClipCatalog(entries: Iterable<AnimClipCatalogEntry>): void {
    this.animClipCatalog.clear();
    for (const entry of entries) this.animClipCatalog.set(entry.guid, entry);
  }

  /** A Play Animation task owns this slot's animation state. */
  playAnimationOwns(slotId: number): boolean {
    return this.playAnimOwnedSlots.has(slotId);
  }

  /**
   * The slot's actor left: its evaluation, last published state and Play
   * Animation ownership go with it, so a later actor's Animation Graph runs.
   * Its Play Sound voice stops, as its AudioComponent voices do. Only slot
   * owners tick trees, and Destroy Actor releases the slot without retiring
   * the actor, so this hook covers every removal.
   */
  releaseSlot(slotId: number, owner: Actor | undefined): void {
    this.evalBySlot.delete(slotId);
    this.lastStateJson.delete(slotId);
    this.playAnimOwnedSlots.delete(slotId);
    if (owner) this.stopPlaySound(owner.guid);
  }

  /** Stop clears the debug overlay the session was streaming. */
  dispose(): void {
    if (this.debug) this.host.emit({ type: "behaviourTreeSnapshot", trees: [] });
  }

  /**
   * Replace per-slot evaluation and Play Animation ownership with a trace
   * frame's, so the Animation Graph skip, slot release and task end behave as
   * in the recorded run.
   */
  restoreFromTrace(states: readonly TraceBtState[]): void {
    this.evalBySlot.clear();
    this.lastStateJson.clear();
    this.playAnimOwnedSlots.clear();
    for (const row of states) {
      if (row.playAnimationOwned === true) this.playAnimOwnedSlots.add(row.slotId);
      this.evalBySlot.set(row.slotId, {
        stack: row.stack.map((frame) => ({ ...frame })),
        status: row.status as BtEvalState["status"],
        lastResults: { ...row.lastResults } as BtEvalState["lastResults"],
        btNodeId: row.btNodeId,
        blackboard: { ...row.blackboard },
        nodeMemory: Object.fromEntries(
          Object.entries(row.nodeMemory ?? {}).map(([id, memory]) => [
            id,
            { ...memory },
          ]),
        ),
      });
    }
  }

  /** Per-slot evaluation state recorded with each trace frame. */
  traceStates(): TraceBtState[] {
    return [...this.evalBySlot.entries()].map(([slotId, state]) => ({
      slotId,
      status: state.status,
      btNodeId: state.btNodeId,
      lastResults: { ...state.lastResults },
      blackboard: snapshotBlackboard(state.blackboard),
      stack: state.stack.map((frame) => ({ ...frame })),
      nodeMemory: Object.fromEntries(
        Object.entries(state.nodeMemory).map(([id, memory]) => [
          id,
          { ...memory },
        ]),
      ),
      ...(this.playAnimOwnedSlots.has(slotId) ? { playAnimationOwned: true } : {}),
    }));
  }

  private stringGuid(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  private treeGuid(component: {
    assetGuid: string | null;
    getVariable(name: string): unknown;
  }): string | null {
    return this.stringGuid(component.getVariable("treeGuid")) ?? component.assetGuid;
  }

  private blackboardDefaults(guid: string | null): BlackboardValues {
    if (!guid) return {};
    const document = this.blackboards.get(guid);
    if (!document) return {};
    const values: BlackboardValues = {};
    for (const key of document.keys) {
      if (key.defaultValue !== undefined) values[key.name] = key.defaultValue;
    }
    return values;
  }

  private tickTask(
    actor: Actor,
    node: { id: string; classId: string; properties?: Record<string, unknown> },
    blackboard: BlackboardValues,
    dtSeconds: number,
    memory: Record<string, unknown>,
  ): BtResult {
    this.nodeId = node.id;
    if (builtinClassId(node.classId) === "bt.task.moveTo") {
      return this.host.navigation().tickMoveTo(actor, node, memory, navPointFromUnknown(node.properties?.destination));
    }
    if (builtinClassId(node.classId) === "bt.task.moveToBlackboardKey") {
      const key = typeof node.properties?.key === "string" ? node.properties.key : "";
      return this.host.navigation().tickMoveTo(actor, node, memory, blackboardTargetPosition(
        blackboard[key], this.host.world(), this.host.frameActors(),
      ));
    }
    if (builtinClassId(node.classId) === "bt.task.rotateToFace") {
      return this.tickRotateToFace(actor, node);
    }
    if (builtinClassId(node.classId) === "bt.task.playAnimation") {
      return this.tickPlayAnimation(actor, node, dtSeconds, memory);
    }
    if (builtinClassId(node.classId) === "bt.task.playSound") {
      return this.tickPlaySound(actor, node, memory);
    }
    const scripts = this.host.scripts();
    if (!scripts.hasClass(node.classId)) return "failure";
    const liveMemory = memory as Record<string | symbol, unknown>;
    let activation = liveMemory[BT_TASK_ACTIVATION] as BtTaskActivation | undefined;
    if (!activation) {
      activation = { active: true, blackboard };
      liveMemory[BT_TASK_ACTIVATION] = activation;
      memory.__activated = false;
    }
    activation.blackboard = blackboard;
    const current = activation;
    const isLive = () => current.active && !actor.destroyed && !this.host.stopped();
    const extras = {
      btFinish: (result: "success" | "failure") => {
        if (isLive()) current.result = result;
      },
      btEvaluate: () => undefined,
      getBlackboard: (key: string) => current.blackboard[key],
      setBlackboard: (key: string, value: unknown) => {
        if (isLive()) current.blackboard[key] = value;
      },
    };
    if (memory.__activated !== true) {
      memory.__activated = true;
      scripts.invokeBtEvent(
        node.classId,
        "onActivate",
        actor,
        dtSeconds,
        extras,
      );
    }
    scripts.invokeBtEvent(node.classId, "onBtTick", actor, dtSeconds, extras);
    const result = current.result;
    if (result === "success" || result === "failure") {
      current.active = false;
      memory.__btResult = result;
      return result;
    }
    return "running";
  }

  private tickRotateToFace(
    actor: Actor,
    node: { properties?: Record<string, unknown> },
  ): BtResult {
    const target = navPointFromUnknown(node.properties?.target);
    if (!target) return "failure";
    const position = actor.transform.position;
    const twoD = this.host.worldKind() === "2d";
    const yawRad = twoD
      ? Math.atan2(target.y - position.y, target.x - position.x)
      : Math.atan2(target.x - position.x, target.z - position.z);
    const yawDeg = (yawRad * 180) / Math.PI;
    const euler: [number, number, number] = twoD
      ? [0, 0, yawDeg]
      : [0, yawDeg, 0];
    const quat = eulerDegreesToQuaternion(euler);
    actor.transform.rotation.x = quat[0];
    actor.transform.rotation.y = quat[1];
    actor.transform.rotation.z = quat[2];
    actor.transform.rotation.w = quat[3];
    this.host.navigation().faceYaw(actor.guid, yawRad);
    return "success";
  }

  private resolvePlayAnimationClip(
    properties: Record<string, unknown> | undefined,
  ): {
    guid: string;
    clipName: string;
    clipKind: "animation" | "sprite";
    durationMs: number;
  } | null {
    const guid =
      typeof properties?.clipAssetGuid === "string"
        ? properties.clipAssetGuid.trim()
        : "";
    if (!guid) return null;
    const entry = this.animClipCatalog.get(guid);
    if (!entry) return null;
    const requested =
      properties?.clipKind === "sprite"
        ? "sprite"
        : properties?.clipKind === "animation"
          ? "animation"
          : entry.type === "SpriteAnimation"
            ? "sprite"
            : "animation";
    if (requested === "sprite" && entry.type !== "SpriteAnimation") return null;
    if (requested === "animation" && entry.type !== "Animation") return null;
    const durationMs = entry.durationMs;
    if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs <= 0) {
      return null;
    }
    const clipName =
      requested === "animation" && typeof entry.clipName === "string"
        ? entry.clipName
        : "";
    return { guid, clipName, clipKind: requested, durationMs };
  }

  private tickPlayAnimation(
    actor: Actor,
    node: { properties?: Record<string, unknown> },
    dtSeconds: number,
    memory: Record<string, unknown>,
  ): BtResult {
    const clip = this.resolvePlayAnimationClip(node.properties);
    const slotId = this.host.slot(actor);
    if (!clip || slotId === undefined) {
      if (slotId !== undefined) this.playAnimOwnedSlots.delete(slotId);
      return "failure";
    }
    const elapsed =
      (typeof memory.elapsedMs === "number" ? memory.elapsedMs : 0) +
      dtSeconds * 1000;
    memory.elapsedMs = elapsed;
    const normalisedTime = Math.min(1, elapsed / clip.durationMs);
    const justFinished = normalisedTime >= 1;
    this.playAnimOwnedSlots.add(slotId);
    if (clip.clipKind === "sprite") {
      this.host.setSpriteClip(actor, {
        assetGuid: clip.guid,
        clipName: clip.clipName,
        normalisedTime,
      });
    } else {
      this.host.setSpriteClip(actor, null);
    }
    this.host.emit({
      type: "animState",
      slotId,
      stateId: "bt.playAnimation",
      normalisedTime,
      blendWeights: { "bt.playAnimation": 1 },
      clipName: clip.clipName,
      clipKind: clip.clipKind,
      clipAssetGuid: clip.guid,
      justFinished,
      justLooped: false,
      layers: [
        {
          stateId: "bt.playAnimation",
          clipAssetGuid: clip.guid,
          clipName: clip.clipName,
          clipKind: clip.clipKind,
          normalisedTime,
          weight: 1,
        },
      ],
    });
    if (!justFinished) return "running";
    this.playAnimOwnedSlots.delete(slotId);
    return "success";
  }

  private tickPlaySound(
    actor: Actor,
    node: { id: string; properties?: Record<string, unknown> },
    memory: Record<string, unknown>,
  ): BtResult {
    const guid =
      typeof node.properties?.audioAssetGuid === "string"
        ? node.properties.audioAssetGuid.trim()
        : "";
    if (!guid || !this.audioAssetGuids.has(guid)) return "failure";
    const volumeRaw = Number(node.properties?.volume ?? 1);
    const volume = Number.isFinite(volumeRaw)
      ? Math.min(1, Math.max(0, volumeRaw))
      : 1;
    const voiceId = `bt:${actor.guid}:${node.id}`;
    if (memory.__soundPlayed !== true) {
      memory.__soundPlayed = true;
      this.voiceByActor.set(actor.guid, voiceId);
      this.host.emit({
        type: "playSound",
        assetGuid: guid,
        volume,
        frameId: this.host.frameId(),
        emitterActorGuid: actor.guid,
        voiceId,
      });
    }
    return "success";
  }

  private stopPlaySound(actorGuid: string, nodeId?: string): void {
    const voiceId =
      nodeId !== undefined
        ? `bt:${actorGuid}:${nodeId}`
        : this.voiceByActor.get(actorGuid);
    if (!voiceId) return;
    this.host.emit({ type: "stopSound", voiceId });
    this.voiceByActor.delete(actorGuid);
  }

  private abortPlayAnimation(actor: Actor, memory: Record<string, unknown>): void {
    delete memory.elapsedMs;
    const slotId = this.host.slot(actor);
    if (slotId !== undefined) this.playAnimOwnedSlots.delete(slotId);
    this.host.setSpriteClip(actor, null);
  }

  private abortTask(
    actor: Actor,
    node: { id: string; classId: string },
    blackboard: BlackboardValues,
    memory: Record<string, unknown>,
    dtSeconds: number,
  ): void {
    const liveMemory = memory as Record<string | symbol, unknown>;
    const activation = liveMemory[BT_TASK_ACTIVATION] as BtTaskActivation | undefined;
    if (activation) activation.active = false;
    delete liveMemory[BT_TASK_ACTIVATION];
    memory.__activated = false;
    delete memory.__btResult;
    delete memory.__moveRequested;
    delete memory.__soundPlayed;
    const classId = builtinClassId(node.classId);
    if (classId === "bt.task.moveTo" || classId === "bt.task.moveToBlackboardKey") {
      this.host.navigation().stopAgent(actor.guid);
    }
    if (classId === "bt.task.playAnimation") {
      this.abortPlayAnimation(actor, memory);
    }
    if (classId === "bt.task.playSound") {
      this.stopPlaySound(actor.guid, node.id);
    } else if (this.voiceByActor.has(actor.guid)) {
      this.stopPlaySound(actor.guid);
    }
    this.host.scripts().invokeBtEvent(node.classId, "onAbort", actor, dtSeconds, {
      btFinish: () => undefined,
      btEvaluate: () => undefined,
      getBlackboard: (key) => blackboard[key],
      setBlackboard: (key, value) => {
        blackboard[key] = value;
      },
    });
  }

  private evaluateDecorator(
    actor: Actor,
    classId: string,
    blackboard: BlackboardValues,
    dtSeconds: number,
  ): boolean {
    const scripts = this.host.scripts();
    if (!scripts.hasClass(classId)) return true;
    let result = true;
    scripts.invokeBtEvent(classId, "onEvaluate", actor, dtSeconds, {
      btFinish: () => undefined,
      btEvaluate: (value) => {
        result = Boolean(value);
      },
      getBlackboard: (key) => blackboard[key],
      setBlackboard: (key, value) => {
        blackboard[key] = value;
      },
    });
    return result;
  }

  private emitMissing(actorGuid: string, message: string): void {
    if (this.missingWarned.has(actorGuid)) return;
    this.missingWarned.add(actorGuid);
    const frameId = this.host.frameId();
    const diag: RuntimeDiagnostic = {
      code: "bt.missing_tree",
      message,
      severity: "error",
      frameId,
      tickIndex: this.host.tickIndex(),
    };
    this.host.recordDiagnostic(diag);
    this.host.emit({
      type: "diagnostic",
      code: diag.code,
      message: diag.message,
      frameId,
      severity: "error",
    });
  }

  /** One tick; `dtSeconds` is the tick's captured step, fixed for the whole tick. */
  tick(dtSeconds: number): void {
    for (const actor of this.host.world().getActors()) {
      if (this.host.stopped()) return;
      if (!this.host.canTick(actor)) continue;
      const slotId = this.host.slot(actor);
      if (slotId === undefined) continue;
      const component = actor.components.find(
        (entry) =>
          entry.classId === "BehaviourTreeComponent" && !entry.destroyed,
      );
      if (!component) continue;
      const guid = this.treeGuid(component);
      if (!guid) {
        this.emitMissing(actor.guid, "BehaviourTreeComponent has no treeGuid");
        continue;
      }
      this.assetGuid = guid;
      const document = this.documents.get(guid);
      if (!document) {
        this.emitMissing(actor.guid, `Behaviour tree not loaded: ${guid}`);
        continue;
      }
      const blackboardGuid = this.stringGuid(component.getVariable("blackboardGuid")) ?? document.blackboardGuid;
      const previous = this.evalBySlot.get(slotId) ?? null;
      const blackboard: BlackboardValues = previous
        ? { ...previous.blackboard }
        : this.blackboardDefaults(blackboardGuid);
      const next = evaluateBehaviourTree(document, previous, dtSeconds, {
        seed: this.host.seed(),
        blackboard,
        host: {
          tick: (node, board, dtSeconds, memory) =>
            this.tickTask(actor, node, board, dtSeconds, memory),
          abort: (node, board, memory) =>
            this.abortTask(actor, node, board, memory, dtSeconds),
        },
        decoratorHost: {
          evaluate: (decorator, _node, board) =>
            this.evaluateDecorator(actor, decorator.classId, board, dtSeconds),
        },
        serviceHost: {
          tick: (service, _node, board, dtSeconds) => {
            this.host.scripts().invokeBtEvent(
              service.classId,
              "onBtTick",
              actor,
              dtSeconds,
              {
                btFinish: () => undefined,
                btEvaluate: () => undefined,
                getBlackboard: (key) => board[key],
                setBlackboard: (key, value) => {
                  board[key] = value;
                },
              },
            );
          },
        },
      });
      this.evalBySlot.set(slotId, next);
      this.nodeId = null;
      this.assetGuid = null;
      const blackboardSnapshot = snapshotBlackboard(next.blackboard);
      const payload = JSON.stringify({
        status: next.status,
        btNodeId: next.btNodeId,
        lastResults: next.lastResults,
        blackboard: blackboardSnapshot,
        stack: next.stack,
      });
      if (this.lastStateJson.get(slotId) === payload) continue;
      this.lastStateJson.set(slotId, payload);
      this.host.emit({
        type: "btState",
        slotId,
        status: next.status,
        btNodeId: next.btNodeId,
        lastResults: next.lastResults,
        blackboard: blackboardSnapshot,
        stack: next.stack,
      });
    }
  }

  /** `bt.debug` console toggle. */
  setDebug(enabled: boolean): void {
    this.debug = enabled;
    this.host.emit({ type: "setBehaviourTreeDebug", enabled });
    if (enabled) this.emitSnapshot(true);
    else this.host.emit({ type: "behaviourTreeSnapshot", trees: [] });
  }

  /** Stream tree state while the debug view is on, at most every 200 ms unless forced. */
  emitSnapshot(force = false): void {
    if (!this.debug) return;
    const now = this.now();
    if (!force && now - this.lastDebugMs < 200) return;
    this.lastDebugMs = now;
    const trees: DebugBehaviourTree[] = [];
    for (const actor of this.host.world().getActors()) {
      if (actor.destroyed) continue;
      const slotId = this.host.slot(actor);
      if (slotId === undefined) continue;
      const component = actor.components.find((entry) =>
        entry.classId === "BehaviourTreeComponent" && !entry.destroyed);
      if (!component) continue;
      const treeGuid = this.treeGuid(component);
      const document = treeGuid ? this.documents.get(treeGuid) : null;
      if (!treeGuid || !document) continue;
      const state = this.evalBySlot.get(slotId);
      const blackboardGuid = this.stringGuid(component.getVariable("blackboardGuid")) ?? document.blackboardGuid;
      const blackboardTypes = blackboardInspectTypes(blackboardGuid ? this.blackboards.get(blackboardGuid) : undefined);
      trees.push({
        actorGuid: actor.guid,
        actorName: this.host.actorName(actor),
        treeGuid,
        treeName: document.name || treeGuid,
        slotId,
        status: state?.status ?? "idle",
        btNodeId: state?.btNodeId ?? null,
        lastResults: { ...state?.lastResults },
        blackboard: snapshotBlackboard(state?.blackboard ?? this.blackboardDefaults(blackboardGuid)),
        ...(blackboardTypes ? { blackboardTypes } : {}),
        stack: state?.stack.map((frame) => ({ ...frame })) ?? [],
        nodes: document.nodes.map((node) => ({
          id: node.id, kind: node.kind, classId: node.classId,
          children: [...node.children],
          decorators: node.decorators.map(({ id, classId }) => ({ id, classId })),
          services: node.services.map(({ id, classId }) => ({ id, classId })),
        })),
      });
    }
    this.host.emit({ type: "behaviourTreeSnapshot", trees });
  }
}
