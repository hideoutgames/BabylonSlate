import { ANIM_STATE_MACHINE_DEBUG_GRAPH_ID, type CommandMessage } from "@haptic/bridge";
import type { TraceAnimGraphState } from "@haptic/debugger";
import { Actor, ActorComponent, type EngineObject, type World } from "@haptic/object-model";
import {
  animEvalWithJump,
  animGraphDimension,
  animGraphScriptClassId,
  animPoseScriptClassId,
  animRuleScriptClassId,
  animTransitionEdgeId,
  defaultAnimVariableValue,
  evaluateAnimGraph,
  ANIM_DEFAULT_SLOT,
  type AnimClipCatalogEntry,
  type AnimSlotClip,
  type AnimSlotEvent,
  type AnimSlotRequest,
  type AnimEvalState,
  type AnimFiredEvent,
  type AnimGraphDocument,
  type AnimGraphInputs,
  type AnimRootMotionDelta,
  type AnimTransition,
} from "@haptic/anim-graph";
import { ANIM_NOTIFY_EVENT } from "@haptic/scripting";
import { ANIMATION_TICK_MODE_PROPERTY, parseAnimationTickMode } from "@haptic/core";
import { animGraphGuidOf } from "./component-assets";
import type { RuntimeSubsystem } from "./runtime-subsystems";
import type { ScriptBreakpoints } from "./script-breakpoints";
import type { ScriptDebugTrace, ScriptGraphRecorder } from "./script-debug";
import type { SpriteClipState } from "./sprite-clip-trace";
import type { AnimGraphControl, ScriptHost, SlotClipLoader } from "./script-host";
import { walkComponentOwners } from "./world-component-index";
import { TickWait } from "./tick-wait";

type SpriteClip = SpriteClipState;
/** Stops on the State Machine's state or transition when it has a breakpoint. */
type StateMachineHit = (id: string, event: "entered" | "taken") => void;
type EvaluationCallbacks = Pick<AnimGraphInputs, "decideTransition" | "poseData"> & { guid: string; actor: Actor };

interface AnimGraphRuntimeHost {
  world(): World;
  stopped(): boolean;
  canTick(actor: Actor): boolean;
  /** The render slot this actor's own commands target. */
  slot(actor: Actor): number | undefined;
  /** Whether the actor holds a render slot when a script asks for control. */
  hasRenderSlot(actor: Actor): boolean;
  /** A Behaviour Tree Play Animation task owns this slot's animation state. */
  playAnimationOwns(slotId: number): boolean;
  scripts(): Pick<ScriptHost, "invokeAnimEvent" | "invokeAnimRule" | "invokeAnimPose">;
  setSpriteClip(actor: Actor, clip: SpriteClip | null): void;
  /** The session's node breakpoints, the State Machine's included. */
  breakpoints(): ScriptBreakpoints;
  /** Where a component the debugger does not follow records, while breakpoints are set, should one stop it. */
  frameTrace(object: EngineObject): ScriptDebugTrace | null;
  emit(command: CommandMessage): void;
  /** An Animation Event's Play Sound: the sound from the actor. */
  playEventSound(actor: Actor, assetGuid: string, volume: number): void;
  /** An Animation Event's Spawn Particle System: on the actor, at `bone` when it names one. */
  spawnEventParticles(actor: Actor, assetGuid: string, bone: string): void;
  /** Moves the actor by a tick's root motion: travel along its own X and Z (in its units) and a turn about Y. */
  applyRootMotion(actor: Actor, motion: AnimRootMotionDelta, dtSeconds: number): void;
}

/** An ended play's handle stays this many ticks for a script still to ask how it ended (On Completed). */
const ENDED_SLOT_PLAY_TICKS = 600;

/** A Play Slot Animation's handle while scripts may wait on it. */
interface SlotPlay {
  component: string;
  /** Its clip is still loading: it has not started, so ending it now runs neither output. */
  loading?: boolean;
  blendedOut: boolean;
  ended?: "completed" | "interrupted";
  /** Ticks since it ended: a handle nothing waited on goes after `ENDED_SLOT_PLAY_TICKS`. */
  endedTicks?: number;
  waits: Array<{ phase: "blendOut" | "completed"; resolve: (value: boolean) => void }>;
}

/** AnimationGraph documents and per-component evaluation state for Play. */
export class AnimGraphRuntime implements RuntimeSubsystem {
  private readonly documents = new Map<string, AnimGraphDocument>();
  private readonly evalByComponent = new Map<string, AnimEvalState>();
  /** The graph guid each component last ran `onInitializeAnimation` for. */
  private readonly initializedGraphByComponent = new Map<string, string>();
  /** The graph guid of each component the current tick visited. */
  private readonly liveGraphByComponent = new Map<string, string>();
  private readonly pendingJumpByComponent = new Map<string, string>();
  /** Play and Stop Slot Animation requests since a component's last evaluation, in order. */
  private readonly slotRequestsByComponent = new Map<string, AnimSlotRequest[]>();
  /** Each Play Slot Animation's handle: its component, whether it began blending out, how it ended, and its waits. */
  private readonly slotPlays = new Map<number, SlotPlay>();
  /** The play waiting for its clip to load, by component and slot: only the slot's latest request waits. */
  private readonly loadingSlotPlays = new Map<string, Map<string, number>>();
  private nextSlotPlayId = 1;
  /** Animations and Sprite Animations by guid, which Play Slot Animation plays. */
  private readonly clipCatalog = new Map<string, AnimClipCatalogEntry>();
  /** The graph guid a component's evaluation and queued jump belong to. */
  private readonly graphByComponent = new Map<string, string>();
  /** The document and variables revision each component's graph variables were last filled at. */
  private readonly seededVariables = new WeakMap<ActorComponent, { document: AnimGraphDocument; revision: number }>();
  private readonly callbacksByComponent = new WeakMap<ActorComponent, EvaluationCallbacks>();
  /** The AnimationGraphComponent the editor's graph debugger follows, and where its State Machine reports. */
  private debugComponent: EngineObject | null = null;
  private debugSink: ScriptDebugTrace | null = null;
  private readonly host: AnimGraphRuntimeHost;

  constructor(host: AnimGraphRuntimeHost) { this.host = host; }

  register(guid: string, document: AnimGraphDocument): void {
    this.documents.set(guid, document);
  }

  replaceAnimClipCatalog(entries: Iterable<AnimClipCatalogEntry>): void {
    this.clipCatalog.clear();
    for (const entry of entries) if (entry.guid) this.clipCatalog.set(entry.guid, entry);
  }

  /** The clip a slot plays for `guid`: an Animation in a 3D graph, a Sprite Animation in a 2D one. */
  private slotClip(guid: string, document: AnimGraphDocument): AnimSlotClip | null {
    const entry = this.clipCatalog.get(guid);
    const sprite = animGraphDimension(document) === "2d";
    if (!entry || entry.type !== (sprite ? "SpriteAnimation" : "Animation")) return null;
    const durationMs = typeof entry.durationMs === "number" && entry.durationMs > 0 ? entry.durationMs : 1000;
    return {
      assetGuid: guid,
      clipName: sprite ? "" : entry.clipName ?? "",
      clipKind: sprite ? "sprite" : "animation",
      durationMs,
      ...(entry.events && entry.events.length > 0 ? { events: [...entry.events] } : {}),
      ...(!sprite && entry.rootMotion ? { rootMotion: entry.rootMotion } : {}),
    };
  }

  /**
   * Waits for a Play Slot Animation to reach `phase`: true once it begins blending out, or (for `completed`) once
   * it has played through; false when it never started, or ended early for `completed`.
   */
  waitSlot(handle: number, phase: "blendOut" | "completed"): PromiseLike<boolean> | boolean {
    const play = this.slotPlays.get(handle);
    if (!play) return false;
    if (phase === "blendOut" && (play.blendedOut || play.ended)) return play.blendedOut;
    if (phase === "completed" && play.ended) {
      this.slotPlays.delete(handle);
      return play.ended === "completed";
    }
    return TickWait.start<boolean>((resolve) => {
      play.waits.push({ phase, resolve });
    });
  }

  /** A play's blend out or end: resolves its waits; an ended play's handle is dropped once nothing waits on it. */
  private settleSlotEvent(event: AnimSlotEvent): void {
    const play = this.slotPlays.get(event.id);
    if (!play) return;
    if (event.phase === "blendOut") play.blendedOut = true;
    else play.ended = event.phase;
    const waits = play.waits.splice(0);
    for (const wait of waits) {
      if (wait.phase === "blendOut" && play.blendedOut) wait.resolve(true);
      else if (wait.phase === "completed" && play.ended) wait.resolve(play.ended === "completed");
      else if (wait.phase === "blendOut" && play.ended) wait.resolve(false);
      else play.waits.push(wait);
    }
  }

  /** Ends every play of a component that will not run again: their waits answer false. */
  private dropSlotPlays(componentGuid: string): void {
    this.slotRequestsByComponent.delete(componentGuid);
    this.loadingSlotPlays.delete(componentGuid);
    for (const [handle, play] of this.slotPlays) {
      if (play.component !== componentGuid) continue;
      if (!play.ended) {
        // A play still loading its clip never started: it does not blend out.
        if (!play.blendedOut && !play.loading) this.settleSlotEvent({ id: handle, phase: "blendOut" });
        this.settleSlotEvent({ id: handle, phase: "interrupted" });
      }
      this.slotPlays.delete(handle);
    }
  }

  /**
   * Ends the play waiting on the slot for its clip, superseded by a later Play or Stop Slot Animation there (or its
   * load failed): it never started, so its waits answer false and its late load plays nothing.
   */
  private endLoadingSlotPlay(componentGuid: string, slot: string): void {
    const loading = this.loadingSlotPlays.get(componentGuid);
    const handle = loading?.get(slot);
    if (!loading || handle === undefined) return;
    loading.delete(slot);
    if (loading.size === 0) this.loadingSlotPlays.delete(componentGuid);
    const play = this.slotPlays.get(handle);
    if (play && !play.ended) this.settleSlotEvent({ id: handle, phase: "interrupted" });
  }

  /**
   * The editor's graph debugger follows `object` (an AnimationGraphComponent; anything else follows
   * nothing here). Only that component reports the states it samples and the transitions it takes.
   * Its Animation Object graph reports through `ctx.debugTrace`, which `ScriptHost` routes.
   */
  setDebugTrace(object: EngineObject | null, sink: ScriptDebugTrace | null): void {
    const followed = sink && object?.classId === "AnimationGraphComponent";
    this.debugComponent = followed ? object : null;
    this.debugSink = followed ? sink : null;
  }

  /** Drop documents a replaced source catalog no longer retains. */
  retain(retained: ReadonlySet<string>): void {
    for (const guid of this.documents.keys()) if (!retained.has(guid)) this.documents.delete(guid);
  }

  /** Stop, phase 1: every Play Slot Animation ends, so its waits answer false and their continuations go. */
  cancelPending(): void {
    for (const componentGuid of new Set([...this.slotPlays.values()].map((play) => play.component))) this.dropSlotPlays(componentGuid);
    this.slotRequestsByComponent.clear();
    this.loadingSlotPlays.clear();
  }

  /** Stop, phase 2: forget every graph, clip, component state and debug follower the session held. */
  dispose(): void {
    this.cancelPending();
    this.documents.clear();
    this.clipCatalog.clear();
    this.evalByComponent.clear();
    this.initializedGraphByComponent.clear();
    this.liveGraphByComponent.clear();
    this.pendingJumpByComponent.clear();
    this.graphByComponent.clear();
    this.debugComponent = null;
    this.debugSink = null;
  }

  /** Forget a removed actor's component evaluations, pending jumps and initialization. */
  retireActor(actor: Actor): void {
    for (const component of actor.components) {
      this.dropSlotPlays(component.guid);
      this.evalByComponent.delete(component.guid);
      this.pendingJumpByComponent.delete(component.guid);
      this.graphByComponent.delete(component.guid);
      this.initializedGraphByComponent.delete(component.guid);
    }
  }

  /** Per-component evaluation, initialization and pending jumps recorded with each trace frame. */
  traceStates(): TraceAnimGraphState[] {
    const rows = new Map<string, TraceAnimGraphState>();
    for (const [componentGuid, state] of this.evalByComponent) {
      const graphGuid = this.initializedGraphByComponent.get(componentGuid);
      if (graphGuid === undefined) continue;
      rows.set(componentGuid, {
        componentGuid,
        graphGuid,
        state: structuredClone(state) as unknown as Record<string, unknown>,
      });
    }
    for (const [componentGuid, stateId] of this.pendingJumpByComponent) {
      const row = rows.get(componentGuid) ?? { componentGuid };
      row.pendingJumpStateId = stateId;
      rows.set(componentGuid, row);
    }
    return [...rows.values()];
  }

  /**
   * Bind a component's evaluation and queued jump to `graphGuid`. When the
   * component switches to another graph, the old graph's state and jump are
   * dropped so the new graph starts at its entry state. A first binding keeps
   * a jump queued before the graph was evaluated.
   */
  private bindGraph(componentGuid: string, graphGuid: string): void {
    const bound = this.graphByComponent.get(componentGuid);
    if (bound === graphGuid) return;
    this.graphByComponent.set(componentGuid, graphGuid);
    if (bound === undefined) return;
    this.evalByComponent.delete(componentGuid);
    this.pendingJumpByComponent.delete(componentGuid);
    this.dropSlotPlays(componentGuid);
  }

  /** Script-facing control of one AnimationGraphComponent. */
  control(target: unknown): AnimGraphControl | null {
    if (
      !(target instanceof ActorComponent) ||
      target.classId !== "AnimationGraphComponent" ||
      target.destroyed
    ) {
      return null;
    }
    const owner = target.owner;
    if (!(owner instanceof Actor) || owner.destroyed) return null;
    const hasSlot = this.host.hasRenderSlot(owner);
    const guid = animGraphGuidOf(target);
    const document = guid ? this.documents.get(guid) : undefined;
    const evalKey = target.guid;
    return {
      getVariable: (name) => target.getVariable(name),
      setVariable: (name, value) => {
        target.setVariable(name, value);
      },
      getCurrentState: () => {
        const evalState = guid && this.graphByComponent.get(evalKey) === guid
          ? this.evalByComponent.get(evalKey)
          : undefined;
        const machine = document?.stateMachine;
        const stateId = evalState?.stateId ?? machine?.entryStateId;
        if (!stateId || !machine) return null;
        const state = machine.states.find((row) => row.id === stateId);
        return { id: stateId, name: state?.name ?? stateId };
      },
      jumpToState: (state) => {
        if (!document || !hasSlot) return;
        const match = document.stateMachine.states.find(
          (row) => row.id === state || row.name === state,
        );
        if (!match || !guid) return;
        this.bindGraph(evalKey, guid);
        this.pendingJumpByComponent.set(evalKey, match.id);
      },
      playSlotAnimation: (request, clips) => {
        if (!document || !guid || !hasSlot) return 0;
        const slot = request.slot.trim() || ANIM_DEFAULT_SLOT;
        const queue = (id: number, clip: AnimSlotClip) => this.queueSlotRequest(evalKey, {
          kind: "play", id, slot, clip,
          blendInSeconds: request.blendInSeconds, blendOutSeconds: request.blendOutSeconds,
          playRate: request.playRate, loopCount: request.loopCount, startSeconds: request.startSeconds,
        });
        const asset = request.animation.trim();
        if (asset && clips?.needsLoad(asset)) return this.loadSlotPlay(target, guid, slot, asset, clips, queue);
        const clip = this.slotClip(asset, document);
        if (!clip) return 0;
        this.bindGraph(evalKey, guid);
        // The latest request on a slot wins: one still waiting for its clip never starts.
        this.endLoadingSlotPlay(evalKey, slot);
        const id = this.nextSlotPlayId++;
        this.slotPlays.set(id, { component: evalKey, blendedOut: false, waits: [] });
        queue(id, clip);
        return id;
      },
      stopSlotAnimation: (slot, blendOutSeconds) => {
        if (!guid || !document) return;
        const name = slot.trim() || ANIM_DEFAULT_SLOT;
        this.endLoadingSlotPlay(evalKey, name);
        this.queueSlotRequest(evalKey, { kind: "stop", slot: name, blendOutSeconds });
      },
      isSlotActive: (slot) => {
        const name = slot.trim() || ANIM_DEFAULT_SLOT;
        // A play waiting for its clip, or queued since the last evaluation, already counts.
        if (this.loadingSlotPlays.get(evalKey)?.has(name)) return true;
        const requests = this.slotRequestsByComponent.get(evalKey) ?? [];
        for (let i = requests.length - 1; i >= 0; i--) {
          const request = requests[i]!;
          if (request.slot === name) return request.kind === "play";
        }
        const evalState = guid && this.graphByComponent.get(evalKey) === guid ? this.evalByComponent.get(evalKey) : undefined;
        return evalState?.slots?.[name]?.active !== undefined;
      },
    };
  }

  /**
   * A Play Slot Animation whose clip its owner did not load: its handle at once, and the play queued once the clip
   * has loaded, while it is still the slot's latest request and its component still runs `graphGuid`; the slot shows
   * what it showed meanwhile. A later Play or Stop Slot Animation on the slot, the graph's switch or end, or a failed
   * load ends it unstarted, so its waits answer false.
   */
  private loadSlotPlay(
    component: ActorComponent, graphGuid: string, slot: string, asset: string, clips: SlotClipLoader,
    queue: (id: number, clip: AnimSlotClip) => void,
  ): number {
    const evalKey = component.guid;
    this.bindGraph(evalKey, graphGuid);
    this.endLoadingSlotPlay(evalKey, slot);
    const id = this.nextSlotPlayId++;
    this.slotPlays.set(id, { component: evalKey, loading: true, blendedOut: false, waits: [] });
    let loading = this.loadingSlotPlays.get(evalKey);
    if (!loading) this.loadingSlotPlays.set(evalKey, loading = new Map());
    loading.set(slot, id);
    const current = () => this.loadingSlotPlays.get(evalKey)?.get(slot) === id;
    clips.loadSlotClip(component, asset, {
      current,
      ready: () => {
        if (!current()) return;
        const document = this.graphByComponent.get(evalKey) === graphGuid ? this.documents.get(graphGuid) : undefined;
        const clip = document ? this.slotClip(asset, document) : null;
        const play = this.slotPlays.get(id);
        // An asset that is no clip for this graph (another type, or a Sprite Animation in a 3D graph) plays nothing.
        if (!clip || !play) { this.endLoadingSlotPlay(evalKey, slot); return; }
        const waiting = this.loadingSlotPlays.get(evalKey)!;
        waiting.delete(slot);
        if (waiting.size === 0) this.loadingSlotPlays.delete(evalKey);
        delete play.loading;
        queue(id, clip);
      },
      failed: () => { if (current()) this.endLoadingSlotPlay(evalKey, slot); },
    });
    return id;
  }

  private queueSlotRequest(componentGuid: string, request: AnimSlotRequest): void {
    const requests = this.slotRequestsByComponent.get(componentGuid);
    if (requests) requests.push(request);
    else this.slotRequestsByComponent.set(componentGuid, [request]);
  }

  /**
   * Fills the graph's variables the component lacks. Only a variable write can remove one, so while the component's
   * variables revision and document are what the last seeding saw, there is nothing to fill.
   */
  private seedVariables(
    component: ActorComponent,
    document: AnimGraphDocument,
  ): void {
    const seeded = this.seededVariables.get(component);
    if (seeded?.document === document && seeded.revision === component.variablesRevision) return;
    for (const variable of document.variables) {
      if (component.getVariable(variable.name) !== undefined) continue;
      // Each component owns its copy: an object default must not be shared with the document or other components.
      component.setVariable(
        variable.name,
        variable.defaultValue !== undefined
          ? structuredClone(variable.defaultValue)
          : defaultAnimVariableValue(variable.typeId, variable.typeClassId),
      );
    }
    this.seededVariables.set(component, { document, revision: component.variablesRevision });
  }

  /** The script callbacks a component's evaluation calls, made once per component and graph. */
  private evaluationCallbacks(component: ActorComponent, actor: Actor, guid: string): EvaluationCallbacks {
    const cached = this.callbacksByComponent.get(component);
    if (cached?.guid === guid && cached.actor === actor) return cached;
    const callbacks: EvaluationCallbacks = {
      guid,
      actor,
      decideTransition: (transition, facts) =>
        this.host.scripts().invokeAnimRule(
          animRuleScriptClassId(guid, transition.id),
          actor,
          { variableStore: component, animFacts: facts },
        ),
      // Each state graph's wired data inputs, with its state's facts.
      poseData: (graphKey, facts) =>
        this.host.scripts().invokeAnimPose(
          animPoseScriptClassId(guid, graphKey),
          actor,
          { variableStore: component, ...(facts ? { animFacts: facts } : {}) },
        ),
    };
    this.callbacksByComponent.set(component, callbacks);
    return callbacks;
  }

  /** One tick; `dtSeconds` is the tick's captured step, fixed for the whole tick. */
  tick(dtSeconds: number): void {
    if (this.documents.size === 0) return;
    const live = this.liveGraphByComponent;
    live.clear();
    // Only an actor that owns an AnimationGraphComponent has a graph to run.
    const completed = walkComponentOwners(this.host.world(), "AnimationGraphComponent", () => this.host.stopped(),
      (actor) => this.tickActor(actor, dtSeconds));
    if (!completed) return;
    // Deleting the visited entry keeps Map iteration valid, so prune in place.
    // A component the walk missed, or reached with another graph, initializes again when it next runs.
    for (const [evalKey, graphGuid] of this.initializedGraphByComponent) {
      if (live.get(evalKey) !== graphGuid) this.initializedGraphByComponent.delete(evalKey);
    }
    for (const evalKey of this.slotRequestsByComponent.keys()) {
      if (!live.has(evalKey)) this.dropSlotPlays(evalKey);
    }
    for (const [handle, play] of this.slotPlays) {
      if (!live.has(play.component)) this.dropSlotPlays(play.component);
      else if (play.ended && play.waits.length === 0 && (play.endedTicks = (play.endedTicks ?? 0) + 1) > ENDED_SLOT_PLAY_TICKS) {
        this.slotPlays.delete(handle);
      }
    }
    for (const byComponent of [this.graphByComponent, this.evalByComponent, this.pendingJumpByComponent]) {
      for (const evalKey of byComponent.keys()) {
        if (!live.has(evalKey)) byComponent.delete(evalKey);
      }
    }
    live.clear();
  }

  /**
   * What the followed component's State Machine did this tick, under its debug graph: every state it sampled (the
   * active one, and the one a blend is leaving, whether or not they play a clip) and, when the active state changed,
   * the transition taken. A Jump To State replaces the previous evaluation, so it is no transition.
   */
  private reportStateMachine(
    recorder: ScriptGraphRecorder | null | undefined,
    document: AnimGraphDocument,
    previous: AnimEvalState | null,
    next: AnimEvalState,
  ): void {
    if (!recorder) return;
    recorder.exec(next.stateId);
    for (const stateId in next.blendWeights) {
      if (stateId !== next.stateId && next.blendWeights[stateId]! > 0) recorder.exec(stateId);
    }
    if (previous && previous.stateId !== next.stateId) {
      const edge = animTransitionEdgeId(document.stateMachine.transitions, previous.stateId, next.stateId);
      if (edge !== undefined) recorder.edge(edge);
    }
  }

  /** Stops on `graphGuid`'s states and transitions as `component` runs them, or null when the session has no breakpoints. */
  private stateMachineBreakpoints(graphGuid: string, component: ActorComponent, actor: Actor): StateMachineHit | null {
    const breakpoints = this.host.breakpoints();
    if (breakpoints.empty) return null;
    return (id, event) => {
      const graph = breakpoints.graph(graphGuid, ANIM_STATE_MACHINE_DEBUG_GRAPH_ID);
      if (graph?.has(id)) graph.hit(id, "", component, { owner: actor, event });
    };
  }

  /**
   * In order: the state a new evaluation started in, then the transition the State Machine took and the state that
   * entered.
   */
  private reportStateBreakpoints(
    hit: StateMachineHit,
    previous: AnimEvalState | null,
    next: AnimEvalState,
    taken: AnimTransition | null,
  ): void {
    if (!previous) hit(taken?.fromStateId ?? next.stateId, "entered");
    if (!taken) return;
    hit(taken.id, "taken");
    hit(taken.toStateId, "entered");
  }

  /**
   * The Animation Events a tick fired, in order: each one's own action (Play Sound, Spawn Particle System), then its
   * event in the graph's Animation Object, which runs the Animation Event node of that name.
   */
  private fireEvents(
    events: readonly AnimFiredEvent[],
    objectClassId: string,
    actor: Actor,
    dtSeconds: number,
    extras: { variableStore: EngineObject; animFacts: AnimEvalState["facts"] },
  ): void {
    for (const event of events) {
      if (event.action?.kind === "playSound") this.host.playEventSound(actor, event.action.assetGuid, event.action.volume);
      else if (event.action?.kind === "spawnParticles") this.host.spawnEventParticles(actor, event.action.assetGuid, event.action.bone);
      this.host.scripts().invokeAnimEvent(objectClassId, ANIM_NOTIFY_EVENT, actor, dtSeconds, extras, {
        name: event.name,
        phase: event.phase,
        animation: event.clipAssetGuid,
      });
    }
  }

  private tickActor(actor: Actor, dtSeconds: number): void {
    const slotId = this.host.slot(actor);
    // A graph skipped this tick (owner not admitted, no slot, or a Behaviour
    // Tree Play Animation owns the slot) keeps its state and resumes later.
    const runs = slotId !== undefined && this.host.canTick(actor) && !this.host.playAnimationOwns(slotId);
    for (const component of actor.components) {
      if (
        component.classId !== "AnimationGraphComponent" ||
        component.destroyed
      ) {
        continue;
      }
      const guid = animGraphGuidOf(component);
      if (!guid) continue;
      const document = this.documents.get(guid);
      if (!document) continue;
      const evalKey = component.guid;
      this.liveGraphByComponent.set(evalKey, guid);
      this.bindGraph(evalKey, guid);
      if (!runs || slotId === undefined || !this.host.canTick(actor)) continue;
      const tickMode = parseAnimationTickMode(component.getVariable(ANIMATION_TICK_MODE_PROPERTY));
      // Never: the graph keeps its state and its actor its pose, and nothing fires, until it runs again.
      if (tickMode === "never") continue;
      this.seedVariables(component, document);
      const hit = this.stateMachineBreakpoints(guid, component, actor);
      const jumpTo = this.pendingJumpByComponent.get(evalKey);
      if (jumpTo) {
        this.pendingJumpByComponent.delete(evalKey);
        const jumped = animEvalWithJump(document, this.evalByComponent.get(evalKey) ?? null, jumpTo);
        if (jumped) {
          this.evalByComponent.set(evalKey, jumped);
          hit?.(jumpTo, "entered");
        }
      }
      const extras = {
        variableStore: component,
        animFacts: this.evalByComponent.get(evalKey)?.facts,
      };
      const objectClassId = animGraphScriptClassId(guid);
      if (this.initializedGraphByComponent.get(evalKey) !== guid) {
        this.host.scripts().invokeAnimEvent(
          objectClassId,
          "onInitializeAnimation",
          actor,
          0,
          extras,
        );
        this.initializedGraphByComponent.set(evalKey, guid);
      }
      this.host.scripts().invokeAnimEvent(
        objectClassId,
        "onUpdateAnimation",
        actor,
        dtSeconds,
        extras,
      );
      const previous = this.evalByComponent.get(evalKey) ?? null;
      const slotRequests = this.slotRequestsByComponent.get(evalKey);
      this.slotRequestsByComponent.delete(evalKey);
      let taken: AnimTransition | null = null;
      const callbacks = this.evaluationCallbacks(component, actor, guid);
      const next = evaluateAnimGraph(
        document,
        previous,
        dtSeconds,
        {
          decideTransition: callbacks.decideTransition,
          transitionTaken: hit ? (transition) => { taken = transition; } : undefined,
          poseData: callbacks.poseData,
          slotRequests,
        },
      );
      this.evalByComponent.set(evalKey, next);
      if (next.rootMotion) this.host.applyRootMotion(actor, next.rootMotion, dtSeconds);
      // A play's waits resume their scripts here, in the tick it blended out or ended.
      for (const event of next.slotEvents ?? []) this.settleSlotEvent(event);
      if (next.events) this.fireEvents(next.events, objectClassId, actor, dtSeconds, { variableStore: component, animFacts: next.facts });
      if (hit) this.reportStateBreakpoints(hit, previous, next, taken);
      // The followed component reports to the debugger; another, while breakpoints are set, for the frame a stop shows.
      const sink = component === this.debugComponent ? this.debugSink : this.host.frameTrace(component);
      if (sink) this.reportStateMachine(sink.graph(guid, ANIM_STATE_MACHINE_DEBUG_GRAPH_ID), document, previous, next);
      // The frame a 2D graph shows most: its heaviest Sprite Animation layer.
      let sprite: (typeof next.layers)[number] | undefined;
      for (const layer of next.layers) {
        if (layer.clipKind === "sprite" && (!sprite || layer.weight > sprite.weight)) sprite = layer;
      }
      if (sprite) {
        this.host.setSpriteClip(actor, {
          assetGuid: sprite.clipAssetGuid,
          clipName: sprite.clipName,
          normalisedTime: sprite.normalisedTime,
          stateId: sprite.stateId,
          ...(sprite.flipX ? { flipX: true } : {}),
          ...(sprite.flipY ? { flipY: true } : {}),
        });
      } else {
        this.host.setSpriteClip(actor, null);
      }
      const currentLayer =
        next.layers.find((layer) => layer.stateId === next.stateId) ??
        next.layers[next.layers.length - 1];
      this.host.emit({
        type: "animState",
        slotId,
        stateId: next.stateId,
        normalisedTime: next.normalisedTime,
        blendWeights: next.blendWeights,
        clipName: currentLayer?.clipName,
        clipKind: currentLayer?.clipKind,
        clipAssetGuid: currentLayer?.clipAssetGuid,
        justFinished: next.facts.justFinished,
        justLooped: next.facts.justLooped,
        layers: next.layers,
        ...(next.layerBlends ? { layerBlends: next.layerBlends } : {}),
        ...(next.boneModifiers ? { boneModifiers: next.boneModifiers } : {}),
        // The graph ran all the same; render poses the actor only while it can be seen.
        ...(tickMode === "whenVisible" ? { whenVisible: true } : {}),
      });
    }
  }
}
