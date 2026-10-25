import { BT_DEBUG_GRAPH_ID, type CommandMessage, type DebugBehaviourTree } from "@haptic/bridge";
import { eulerDegreesToQuaternion } from "@haptic/core";
import type { TraceBtState } from "@haptic/debugger";
import type { Actor, ActorComponent, EngineObject, World } from "@haptic/object-model";
import type { PhysicsWorldKind } from "@haptic/physics";
import type { AnimClipCatalogEntry } from "@haptic/anim-graph";
import {
  btEdgeId,
  evaluateBehaviourTree,
  builtinClassId,
  type BehaviourTreeDocument,
  type BlackboardDocument,
  type BlackboardValues,
  type BtEvalBreakpoints,
  type BtEvalState,
  type BtEvalTrace,
  type BtResult,
} from "@haptic/behaviour-tree";
import {
  actorChainWorldTransform,
  actorParentGuid,
  inverseQuaternion,
  multiplyQuaternion,
} from "./actor-world-transform";
import { blackboardInspectTypes, blackboardTargetPosition, copyBlackboard, sameBlackboard, snapshotBlackboard } from "./bt-blackboard";
import { behaviourTreeGuidOf, evaluatedBehaviourTreeComponent } from "./component-assets";
import type { RuntimeDiagnostic } from "./diagnostics";
import { copyPlainData, samePlainData } from "./plain-data";
import { navPointFromUnknown, type RuntimeNavigation } from "./runtime-navigation";
import type { RuntimeSubsystem } from "./runtime-subsystems";
import type { ScriptBreakpoints } from "./script-breakpoints";
import type { ScriptDebugTrace, ScriptGraphRecorder } from "./script-debug";
import type { ScriptHost } from "./script-host";
import { walkComponentOwners } from "./world-component-index";

type SpriteClip = { assetGuid: string; clipName: string; normalisedTime: number; stateId?: string };

// Shallow BT memory copies retain this live activation, while trace JSON omits
// it. A resumed task writes to its current board and cannot finish a later run.
const BT_TASK_ACTIVATION = Symbol("btTaskActivation");
type BtTaskActivation = { active: boolean; blackboard: BlackboardValues; result?: "success" | "failure" };
/** The fields of a published `btState`, kept to skip unchanged ticks. */
type BtStatePayload = Pick<BtEvalState, "status" | "btNodeId" | "lastResults" | "blackboard" | "stack">;

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
  scripts(): Pick<ScriptHost, "hasClass" | "invokeBtEvent" | "teleportActor">;
  setSpriteClip(actor: Actor, clip: SpriteClip | null): void;
  actorName(actor: Actor): string;
  recordDiagnostic(diagnostic: RuntimeDiagnostic): void;
  /** The session's node breakpoints, trees' included. */
  breakpoints(): ScriptBreakpoints;
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
  /** Every Play Sound voice each actor's tree started, oldest first. */
  private readonly voiceByActor = new Map<string, Set<string>>();
  /** The component, tree and Blackboard each slot's evaluation belongs to. */
  private readonly sourceBySlot = new Map<number, { key: string; treeGuid: string }>();
  private readonly lastState = new Map<number, BtStatePayload>();
  /**
   * Per slot, a raw copy of the Blackboard whose sanitized form equals `lastState`'s, so an
   * unchanged tick is recognised without sanitizing (a JSON round trip) the live values.
   */
  private readonly blackboardBaseline = new Map<number, BlackboardValues>();
  /**
   * The BehaviourTreeComponent the editor's graph debugger follows, and where its ticks are reported.
   * Only that component's tree reports what it ran and publishes `btState`.
   */
  private debugComponent: ActorComponent | null = null;
  private debugSink: ScriptDebugTrace | null = null;
  /** The evaluation hooks bound to the recorder of the followed tree, so a followed tick allocates none. */
  private debugTrace: { recorder: ScriptGraphRecorder; trace: BtEvalTrace } | null = null;
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
    this.sourceBySlot.delete(slotId);
    this.lastState.delete(slotId);
    this.blackboardBaseline.delete(slotId);
    this.playAnimOwnedSlots.delete(slotId);
    if (owner) this.stopPlaySound(owner.guid);
  }

  /** Stop clears the debug overlay the session was streaming. */
  dispose(): void {
    if (this.debug) this.host.emit({ type: "behaviourTreeSnapshot", trees: [] });
  }

  /**
   * Replace per-slot evaluation, Play Animation ownership and Play Sound voice
   * ownership with a trace frame's, so the Animation Graph skip, slot release,
   * task end and abort behave as in the recorded run.
   */
  restoreFromTrace(states: readonly TraceBtState[]): void {
    this.evalBySlot.clear();
    this.sourceBySlot.clear();
    this.lastState.clear();
    this.blackboardBaseline.clear();
    this.playAnimOwnedSlots.clear();
    this.voiceByActor.clear();
    const actorBySlot = new Map<number, Actor>();
    for (const actor of this.host.world().getActors()) {
      const slotId = actor.destroyed ? undefined : this.host.slot(actor);
      if (slotId !== undefined) actorBySlot.set(slotId, actor);
    }
    for (const row of states) {
      if (row.playAnimationOwned === true) this.playAnimOwnedSlots.add(row.slotId);
      const owner = actorBySlot.get(row.slotId);
      if (row.playSoundVoiceIds?.length && owner) this.voiceByActor.set(owner.guid, new Set(row.playSoundVoiceIds));
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
    const voicesBySlot = new Map<number, string[]>();
    if (this.voiceByActor.size > 0) {
      for (const actor of this.host.world().getActors()) {
        const voices = this.voiceByActor.get(actor.guid);
        const slotId = voices?.size && !actor.destroyed ? this.host.slot(actor) : undefined;
        if (voices && slotId !== undefined) voicesBySlot.set(slotId, [...voices]);
      }
    }
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
      ...(voicesBySlot.has(slotId) ? { playSoundVoiceIds: voicesBySlot.get(slotId) } : {}),
    }));
  }

  private stringGuid(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  private blackboardDefaults(guid: string | null): BlackboardValues {
    if (!guid) return {};
    const document = this.blackboards.get(guid);
    if (!document) return {};
    const values: BlackboardValues = {};
    // Each evaluation owns its data: an object default is never shared with the document or another actor,
    // while a live actor or component default still refers to that object.
    for (const key of document.keys) {
      if (key.defaultValue !== undefined) values[key.name] = copyPlainData(key.defaultValue);
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
    // The target is a world point: aim from the actor's world position, and
    // store the world heading as a rotation local to its parent.
    const world = this.host.world();
    const findActor = (guid: string) => world.findActor(guid);
    const position = actorChainWorldTransform(actor, findActor)?.position ?? actor.transform.position;
    const twoD = this.host.worldKind() === "2d";
    const yawRad = twoD
      ? Math.atan2(target.y - position.y, target.x - position.x)
      : Math.atan2(target.x - position.x, target.z - position.z);
    const yawDeg = (yawRad * 180) / Math.PI;
    const euler: [number, number, number] = twoD
      ? [0, 0, yawDeg]
      : [0, yawDeg, 0];
    const [x, y, z, w] = eulerDegreesToQuaternion(euler);
    const parentGuid = actorParentGuid(actor);
    const parent = parentGuid ? world.findActor(parentGuid) : undefined;
    const parentWorld = parent ? actorChainWorldTransform(parent, findActor) : null;
    const local = parentWorld
      ? multiplyQuaternion(inverseQuaternion(parentWorld.rotation), { x, y, z, w })
      : { x, y, z, w };
    Object.assign(actor.transform.rotation, local);
    // Trees tick after the physics step: a body must take the new heading too,
    // or its next step writes the old rotation back.
    this.host.scripts().teleportActor(actor);
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
        stateId: "bt.playAnimation",
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
      const voices = this.voiceByActor.get(actor.guid) ?? new Set<string>();
      // Re-adding moves a replayed voice to the end, keeping the set oldest first.
      voices.delete(voiceId);
      voices.add(voiceId);
      this.voiceByActor.set(actor.guid, voices);
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

  /** Stop one Play Sound task's voice, or every voice the actor's tree started. */
  private stopPlaySound(actorGuid: string, nodeId?: string): void {
    const voices = this.voiceByActor.get(actorGuid);
    if (nodeId !== undefined) {
      const voiceId = `bt:${actorGuid}:${nodeId}`;
      this.host.emit({ type: "stopSound", voiceId });
      voices?.delete(voiceId);
      if (voices?.size === 0) this.voiceByActor.delete(actorGuid);
      return;
    }
    if (!voices) return;
    for (const voiceId of voices) this.host.emit({ type: "stopSound", voiceId });
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
    // Only an actor that owns a BehaviourTreeComponent has an evaluation to run or reset: a slot
    // evaluation is created for, and released with, the actor that owns the component.
    walkComponentOwners(this.host.world(), "BehaviourTreeComponent", () => this.host.stopped(),
      (actor) => this.tickActor(actor, dtSeconds));
  }

  private tickActor(actor: Actor, dtSeconds: number): void {
    if (!this.host.canTick(actor)) return;
    const slotId = this.host.slot(actor);
    if (slotId === undefined) return;
    const component = evaluatedBehaviourTreeComponent(actor);
    const guid = component ? behaviourTreeGuidOf(component) : null;
    const document = guid ? this.documents.get(guid) : undefined;
    if (!component || !guid || !document) {
      // A removed BehaviourTreeComponent, or one switched to no tree or to one that is not
      // loaded, takes its old tree's running work with it.
      if (this.sourceBySlot.has(slotId)) this.resetEvaluation(actor, slotId, dtSeconds);
      if (component) this.emitMissing(actor.guid, guid ? `Behaviour tree not loaded: ${guid}` : "BehaviourTreeComponent has no treeGuid");
      return;
    }
    const blackboardGuid = this.stringGuid(component.getVariable("blackboardGuid")) ?? document.blackboardGuid;
    const source = `${component.guid}\0${guid}\0${blackboardGuid ?? ""}`;
    if (this.sourceBySlot.get(slotId)?.key !== source) {
      if (this.sourceBySlot.has(slotId)) this.resetEvaluation(actor, slotId, dtSeconds);
      this.sourceBySlot.set(slotId, { key: source, treeGuid: guid });
    }
    this.assetGuid = guid;
    const previous = this.evalBySlot.get(slotId) ?? null;
    // Evaluation copies its Blackboard input, so the previous state's is passed as is.
    const blackboard: BlackboardValues = previous ? previous.blackboard : this.blackboardDefaults(blackboardGuid);
    const followed = component === this.debugComponent;
    const next = evaluateBehaviourTree(document, previous, dtSeconds, {
      seed: this.host.seed(),
      trace: followed ? this.followedTrace(guid) : undefined,
      breakpoints: this.treeBreakpoints(guid, component, actor),
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
    if (followed) this.publishState(slotId, next);
  }

  /** The tree's breakpoints as `component` evaluates it, or undefined when it has none. */
  private treeBreakpoints(treeGuid: string, component: ActorComponent, actor: Actor): BtEvalBreakpoints | undefined {
    const breakpoints = this.host.breakpoints().graph(treeGuid, BT_DEBUG_GRAPH_ID);
    if (!breakpoints) return undefined;
    return {
      has: (nodeId) => breakpoints.has(nodeId),
      hit: (nodeId, event) => breakpoints.hit(nodeId, "", component, { owner: actor, event }),
    };
  }

  /**
   * The editor's graph debugger follows `object` (a BehaviourTreeComponent; anything else follows
   * nothing here) and reports into `sink`. Only that component's tree reports the nodes and links
   * each evaluation touched and publishes `btState`, which feeds the Behaviour Tree editor's node
   * status and Blackboard watch; every other tree, and an unobserved session, sanitizes, compares
   * and sends nothing. Following publishes the tree's current state at once, so the editor is not
   * blank until the next change; what was published for an earlier follow is forgotten, so a new
   * one is sent fresh state.
   */
  setDebugTrace(object: EngineObject | null, sink: ScriptDebugTrace | null): void {
    const component = object?.classId === "BehaviourTreeComponent" ? object as ActorComponent : null;
    this.debugComponent = sink ? component : null;
    this.debugSink = this.debugComponent ? sink : null;
    this.debugTrace = null;
    this.lastState.clear();
    this.blackboardBaseline.clear();
    const owner = this.debugComponent?.owner;
    const slotId = owner && !owner.destroyed ? this.host.slot(owner) : undefined;
    const state = slotId === undefined ? undefined : this.evalBySlot.get(slotId);
    if (slotId !== undefined && state) this.publishState(slotId, state);
  }

  /** The hooks that report an evaluation of the followed tree into its recorder, or none once the follow has ended. */
  private followedTrace(treeGuid: string): BtEvalTrace | undefined {
    const recorder = this.debugSink?.graph(treeGuid, BT_DEBUG_GRAPH_ID) ?? null;
    if (!recorder) return undefined;
    if (this.debugTrace?.recorder !== recorder) {
      this.debugTrace = {
        recorder,
        trace: {
          visit: (nodeId) => recorder.exec(nodeId),
          link: (parentId, childId) => recorder.edge(btEdgeId(parentId, childId)),
        },
      };
    }
    return this.debugTrace.trace;
  }

  /** Emit the slot's `btState` unless it equals the one last published. */
  private publishState(slotId: number, next: BtEvalState): void {
    const followed = this.debugComponent;
    if (!followed) return;
    const last = this.lastState.get(slotId);
    const baseline = this.blackboardBaseline.get(slotId);
    // The sanitized Blackboard last published equals the sanitized baseline copy (below), so
    // a live Blackboard that still equals that copy needs no sanitizing to know it is unchanged.
    if (last && baseline && last.status === next.status && last.btNodeId === next.btNodeId &&
      samePlainData(last.lastResults, next.lastResults) && samePlainData(last.stack, next.stack) &&
      sameBlackboard(baseline, next.blackboard)) return;
    // Evaluation copies its inputs, so the published objects stay as emitted.
    const state: BtStatePayload = {
      status: next.status,
      btNodeId: next.btNodeId,
      lastResults: next.lastResults,
      blackboard: snapshotBlackboard(next.blackboard),
      stack: next.stack,
    };
    this.blackboardBaseline.set(slotId, copyBlackboard(next.blackboard));
    if (samePlainData(last, state)) return;
    this.lastState.set(slotId, state);
    this.host.emit({ type: "btState", instanceId: followed.guid, slotId, ...state });
  }

  /**
   * The slot's BehaviourTreeComponent, tree or Blackboard changed, or it has
   * no loaded tree any more: abort the old tree's running tasks and drop its
   * evaluation and Play Animation ownership, so a new source starts at its
   * root with fresh Blackboard defaults. A tree the source catalog already
   * dropped has no nodes left to abort; its slot state still clears.
   */
  private resetEvaluation(actor: Actor, slotId: number, dtSeconds: number): void {
    const previous = this.evalBySlot.get(slotId);
    const treeGuid = this.sourceBySlot.get(slotId)?.treeGuid;
    const document = treeGuid ? this.documents.get(treeGuid) : undefined;
    if (previous && document) {
      this.assetGuid = treeGuid!;
      for (const node of document.nodes) {
        if (node.kind === "task" && previous.lastResults[node.id] === "running") {
          this.abortTask(actor, node, previous.blackboard, previous.nodeMemory[node.id] ?? {}, dtSeconds);
        }
      }
      this.assetGuid = null;
    }
    this.evalBySlot.delete(slotId);
    this.sourceBySlot.delete(slotId);
    this.lastState.delete(slotId);
    this.blackboardBaseline.delete(slotId);
    this.playAnimOwnedSlots.delete(slotId);
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
      const component = evaluatedBehaviourTreeComponent(actor);
      if (!component) continue;
      const treeGuid = behaviourTreeGuidOf(component);
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
