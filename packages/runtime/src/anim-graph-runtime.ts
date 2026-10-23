import { ANIM_STATE_MACHINE_DEBUG_GRAPH_ID, type CommandMessage } from "@haptic/bridge";
import type { TraceAnimGraphState } from "@haptic/debugger";
import { Actor, ActorComponent, type BObject, type World } from "@haptic/object-model";
import {
  animGraphScriptClassId,
  animRuleScriptClassId,
  animTransitionEdgeId,
  clipForState,
  defaultAnimVariableValue,
  evaluateAnimGraph,
  type AnimEvalState,
  type AnimGraphDocument,
  type AnimTransition,
} from "@haptic/anim-graph";
import { animGraphGuidOf } from "./component-assets";
import type { RuntimeSubsystem } from "./runtime-subsystems";
import type { ScriptBreakpoints } from "./script-breakpoints";
import type { ScriptDebugTrace } from "./script-debug";
import type { AnimGraphControl, ScriptHost } from "./script-host";
import { walkComponentOwners } from "./world-component-index";

type SpriteClip = { assetGuid: string; clipName: string; normalisedTime: number; stateId?: string };
/** Stops on a state or transition when it has a breakpoint. */
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
  scripts(): Pick<ScriptHost, "invokeAnimEvent" | "invokeAnimRule">;
  setSpriteClip(actor: Actor, clip: SpriteClip | null): void;
  /** The session's node breakpoints, State Machines' included. */
  breakpoints(): ScriptBreakpoints;
  emit(command: CommandMessage): void;
}

/** AnimationGraph documents and per-component evaluation state for Play. */
export class AnimGraphRuntime implements RuntimeSubsystem {
  private readonly documents = new Map<string, AnimGraphDocument>();
  private readonly evalByComponent = new Map<string, AnimEvalState>();
  private readonly initializedBySlot = new Set<string>();
  private readonly liveInitKeys = new Set<string>();
  private readonly liveEvalKeys = new Set<string>();
  private readonly pendingJumpByComponent = new Map<string, string>();
  /** The graph guid a component's evaluation and queued jump belong to. */
  private readonly graphByComponent = new Map<string, string>();
  /** The AnimationGraphComponent the editor's graph debugger follows, and where its State Machine reports. */
  private debugComponent: BObject | null = null;
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
  setDebugTrace(object: BObject | null, sink: ScriptDebugTrace | null): void {
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
      for (const key of this.initializedBySlot) {
        if (key.startsWith(`${component.guid}:`)) this.initializedBySlot.delete(key);
      }
    }
  }

  /** Per-component evaluation, initialization and pending jumps recorded with each trace frame. */
  traceStates(): TraceAnimGraphState[] {
    const rows = new Map<string, TraceAnimGraphState>();
    for (const [componentGuid, state] of this.evalByComponent) {
      const prefix = `${componentGuid}:`;
      const initKey = [...this.initializedBySlot].find((key) => key.startsWith(prefix));
      if (initKey === undefined) continue;
      rows.set(componentGuid, {
        componentGuid,
        graphGuid: initKey.slice(prefix.length),
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
   * Replace evaluation, initialization and pending jumps with a trace frame's,
   * so each graph continues mid-state without re-running its initialization.
   */
  restoreFromTrace(rows: readonly TraceAnimGraphState[]): void {
    this.evalByComponent.clear();
    this.initializedBySlot.clear();
    this.pendingJumpByComponent.clear();
    this.graphByComponent.clear();
    for (const row of rows) {
      if (row.graphGuid !== undefined && row.state) {
        this.evalByComponent.set(row.componentGuid, structuredClone(row.state) as unknown as AnimEvalState);
        this.initializedBySlot.add(`${row.componentGuid}:${row.graphGuid}`);
        this.graphByComponent.set(row.componentGuid, row.graphGuid);
      }
      if (row.pendingJumpStateId) this.pendingJumpByComponent.set(row.componentGuid, row.pendingJumpStateId);
    }
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
        const stateId = evalState?.stateId ?? document?.entryStateId;
        if (!stateId || !document) return null;
        const state = document.states.find((row) => row.id === stateId);
        return { id: stateId, name: state?.name ?? stateId };
      },
      jumpToState: (state) => {
        if (!document || !hasSlot) return;
        const match = document.states.find(
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
    const liveKeys = this.liveInitKeys;
    const liveEvalKeys = this.liveEvalKeys;
    liveKeys.clear();
    liveEvalKeys.clear();
    // Only an actor that owns an AnimationGraphComponent has a graph to run.
    const completed = walkComponentOwners(this.host.world(), "AnimationGraphComponent", () => this.host.stopped(),
      (actor) => this.tickActor(actor, dtSeconds));
    if (!completed) return;
    // Deleting the visited entry keeps Set/Map iteration valid, so prune in place.
    for (const key of this.initializedBySlot) {
      if (!liveKeys.has(key)) this.initializedBySlot.delete(key);
    }
    for (const byComponent of [this.graphByComponent, this.evalByComponent, this.pendingJumpByComponent]) {
      for (const evalKey of byComponent.keys()) {
        if (!liveEvalKeys.has(evalKey)) byComponent.delete(evalKey);
      }
    }
    liveKeys.clear();
    liveEvalKeys.clear();
  }

  /**
   * What the followed component's State Machine did this tick: every state it sampled (the active
   * one, and the one a blend is leaving) and, when the active state changed, the transition taken.
   * A Jump To State replaces the previous evaluation, so it is no transition.
   */
  private reportStateMachine(
    graphGuid: string,
    document: AnimGraphDocument,
    previous: AnimEvalState | null,
    next: AnimEvalState,
  ): void {
    const recorder = this.debugSink?.graph(graphGuid, ANIM_STATE_MACHINE_DEBUG_GRAPH_ID);
    if (!recorder) return;
    recorder.exec(next.stateId);
    for (const layer of next.layers) recorder.exec(layer.stateId);
    if (previous && previous.stateId !== next.stateId) {
      const edge = animTransitionEdgeId(document.transitions, previous.stateId, next.stateId);
      if (edge !== undefined) recorder.edge(edge);
    }
  }

  /** Stops on `graphGuid`'s states and transitions as `component` runs them, or null when it has no breakpoints. */
  private stateMachineBreakpoints(graphGuid: string, component: ActorComponent, actor: Actor): StateMachineHit | null {
    const breakpoints = this.host.breakpoints().graph(graphGuid, ANIM_STATE_MACHINE_DEBUG_GRAPH_ID);
    if (!breakpoints) return null;
    return (id, event) => {
      if (breakpoints.has(id)) breakpoints.hit(id, "", component, { owner: actor, event });
    };
  }

  /** In order: the state a new evaluation started in, then the transition it took and the state that entered. */
  private reportStateBreakpoints(
    hit: StateMachineHit,
    previous: AnimEvalState | null,
    next: AnimEvalState,
    taken: AnimTransition | undefined,
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
      const initKey = `${evalKey}:${guid}`;
      this.liveInitKeys.add(initKey);
      this.liveEvalKeys.add(evalKey);
      this.bindGraph(evalKey, guid);
      if (!runs || slotId === undefined || !this.host.canTick(actor)) continue;
      this.seedVariables(component, document);
      const hit = this.stateMachineBreakpoints(guid, component, actor);
      const jumpTo = this.pendingJumpByComponent.get(evalKey);
      if (jumpTo) {
        this.pendingJumpByComponent.delete(evalKey);
        const jumped = document.states.find((state) => state.id === jumpTo);
        if (jumped) {
          this.evalByComponent.set(evalKey, {
            stateId: jumped.id,
            normalisedTime: 0,
            blendWeights: { [jumped.id]: 1 },
            timeMs: 0,
            facts: {
              elapsedSeconds: 0,
              durationSeconds: 0,
              normalisedTime: 0,
              remainingSeconds: 0,
              remainingRatio: 1,
              looping: jumped.loop,
              loopCount: 0,
              justLooped: false,
              justFinished: false,
              totalNormalisedTime: 0,
              previousTotalNormalisedTime: 0,
            },
            layers: [],
            blendFromStateId: null,
            blendFromTimeMs: 0,
            blendElapsedMs: 0,
            blendSeconds: 0,
            loopCount: 0,
          });
          hit?.(jumped.id, "entered");
        }
      }
      const extras = {
        variableStore: component,
        animFacts: this.evalByComponent.get(evalKey)?.facts,
      };
      const objectClassId = animGraphScriptClassId(guid);
      if (!this.initializedBySlot.has(initKey)) {
        this.host.scripts().invokeAnimEvent(
          objectClassId,
          "onInitializeAnimation",
          actor,
          0,
          extras,
        );
        this.initializedBySlot.add(initKey);
      }
      this.host.scripts().invokeAnimEvent(
        objectClassId,
        "onUpdateAnimation",
        actor,
        dtSeconds,
        extras,
      );
      const previous = this.evalByComponent.get(evalKey) ?? null;
      let taken: AnimTransition | undefined;
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
        },
      );
      this.evalByComponent.set(evalKey, next);
      if (hit) this.reportStateBreakpoints(hit, previous, next, taken);
      if (component === this.debugComponent) this.reportStateMachine(guid, document, previous, next);
      const clip = clipForState(document, next.stateId);
      if (clip?.kind === "sprite" && clip.assetGuid) {
        this.host.setSpriteClip(actor, {
          assetGuid: clip.assetGuid,
          clipName: clip.clipName,
          normalisedTime: next.normalisedTime,
          stateId: next.stateId,
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
        clipName: currentLayer?.clipName || clip?.clipName,
        clipKind: currentLayer?.clipKind ?? clip?.kind,
        clipAssetGuid: currentLayer?.clipAssetGuid || clip?.assetGuid,
        justFinished: next.facts.justFinished,
        justLooped: next.facts.justLooped,
        layers: next.layers,
      });
    }
  }
}
