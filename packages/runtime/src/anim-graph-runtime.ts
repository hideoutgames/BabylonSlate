import { ANIM_STATE_MACHINE_DEBUG_GRAPH_ID, type CommandMessage } from "@haptic/bridge";
import type { TraceAnimGraphState } from "@haptic/debugger";
import { Actor, ActorComponent, type EngineObject, type World } from "@haptic/object-model";
import {
  animEvalWithJump,
  animGraphScriptClassId,
  animPoseScriptClassId,
  animRuleScriptClassId,
  animTransitionEdgeId,
  defaultAnimVariableValue,
  evaluateAnimGraph,
  type AnimEvalState,
  type AnimGraphDocument,
  type AnimTransition,
} from "@haptic/anim-graph";
import { animGraphGuidOf } from "./component-assets";
import type { RuntimeSubsystem } from "./runtime-subsystems";
import type { ScriptBreakpoints } from "./script-breakpoints";
import type { ScriptDebugTrace, ScriptGraphRecorder } from "./script-debug";
import type { SpriteClipState } from "./sprite-clip-trace";
import type { AnimGraphControl, ScriptHost } from "./script-host";
import { walkComponentOwners } from "./world-component-index";

type SpriteClip = SpriteClipState;
/** Stops on the State Machine's state or transition when it has a breakpoint. */
type StateMachineHit = (id: string, event: "entered" | "taken") => void;

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
  /** The graph guid a component's evaluation and queued jump belong to. */
  private readonly graphByComponent = new Map<string, string>();
  /** The AnimationGraphComponent the editor's graph debugger follows, and where its State Machine reports. */
  private debugComponent: EngineObject | null = null;
  private debugSink: ScriptDebugTrace | null = null;
  private readonly host: AnimGraphRuntimeHost;

  constructor(host: AnimGraphRuntimeHost) { this.host = host; }

  register(guid: string, document: AnimGraphDocument): void {
    this.documents.set(guid, document);
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

  /** Forget a removed actor's component evaluations, pending jumps and initialization. */
  retireActor(actor: Actor): void {
    for (const component of actor.components) {
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
    };
  }

  private seedVariables(
    component: ActorComponent,
    document: AnimGraphDocument,
  ): void {
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
      let taken: AnimTransition | null = null;
      const next = evaluateAnimGraph(
        document,
        previous,
        dtSeconds,
        {
          decideTransition: (transition, facts) =>
            this.host.scripts().invokeAnimRule(
              animRuleScriptClassId(guid, transition.id),
              actor,
              { variableStore: component, animFacts: facts },
            ),
          transitionTaken: hit ? (transition) => { taken = transition; } : undefined,
          // Each state graph's wired data inputs, with its state's facts.
          poseData: (graphKey, facts) =>
            this.host.scripts().invokeAnimPose(
              animPoseScriptClassId(guid, graphKey),
              actor,
              { variableStore: component, ...(facts ? { animFacts: facts } : {}) },
            ),
        },
      );
      this.evalByComponent.set(evalKey, next);
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
      });
    }
  }
}
