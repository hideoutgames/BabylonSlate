import {
  animPoseScriptClassId,
  animRuleScriptClassId,
  animTransitionEdgeId,
  defaultAnimVariableValue,
  evaluateAnimGraph,
  type AnimEvalState,
  type AnimGraphDocument,
  type AnimGraphVariable,
} from "@haptic/anim-graph";
import type { ScriptBundleEntry } from "@haptic/bridge";
import type { GraphRunEvent, GraphRunTrace } from "@haptic/graph-ui";
import { ClassRegistry } from "@haptic/object-model";
import { ScriptHost, type ScriptHostServices } from "@haptic/runtime";

/** What compiled Get Variable nodes read (the runtime's variable store): values by variable name. */
type VariableStore = { getVariable(name: string): unknown; setVariable(name: string, value: unknown): void };

/** Speeds the Preview offers, as multiples of real time. */
export const ANIM_PREVIEW_SPEEDS = [0.25, 0.5, 1, 1.5, 2] as const;
/** One Step: a 60 Hz tick, as the game's fixed step. */
export const ANIM_PREVIEW_STEP_SECONDS = 1 / 60;
/** A transition whose rule is not loaded. */
const CLOSED_RULE = { enter: false, exit: false } as const;
/** A frame that took longer (a hidden tab, a breakpoint) advances no further than this. */
const MAX_FRAME_SECONDS = 0.1;

export interface AnimGraphPreviewSnapshot {
  /** The last evaluation: active state, its facts, blend weights and clip layers. Null before the first. */
  readonly state: AnimEvalState | null;
  readonly playing: boolean;
  readonly speed: number;
  /** Preview Values: each variable's value by name, standing in for what the Animation Object would set. */
  readonly values: Readonly<Record<string, unknown>>;
  /** True while the Preview window runs the session, so the State Machine canvas lights what it plays. */
  readonly active: boolean;
}

/** Whether a stored value still fits a variable of this type; a changed type starts from its default. */
function fitsVariable(variable: AnimGraphVariable, value: unknown): boolean {
  switch (variable.typeId) {
    case "bool":
      return typeof value === "boolean";
    case "int":
    case "float":
    case "tag":
      return typeof value === "number";
    case "string":
      return typeof value === "string";
    case "struct":
      return !!value && typeof value === "object";
  }
}

function previewHostServices(): ScriptHostServices {
  return {
    classRegistry: new ClassRegistry(),
    log: () => {},
    print: () => {},
    destroyActor: () => {},
    executeConsoleCommand: () => ({ success: false, output: "Console commands are not available in the Preview." }),
    delay: () => Promise.resolve(),
    // A rule that throws counts as not passing, as in a game; the Compiler Results list its graph's errors.
    reportError: () => {},
  };
}

/**
 * An Animation Graph run in the editor for its Preview window: the graph's evaluator with its compiled transition
 * rules and pose-data modules, on Preview Values instead of the Animation Object (which needs an actor in a world).
 * The Preview window drives `tick` from its clock; the State Machine canvas reads `runTrace`.
 */
export class AnimGraphPreviewSession {
  private doc: AnimGraphDocument | null = null;
  private graphGuid = "";
  private host: ScriptHost | null = null;
  private hostGeneration = 0;
  private values: Record<string, unknown> = {};
  private snapshot: AnimGraphPreviewSnapshot = { state: null, playing: true, speed: 1, values: {}, active: false };
  private readonly listeners = new Set<() => void>();
  private readonly runListeners = new Set<(run: GraphRunEvent) => void>();
  private readonly holdListeners = new Set<(held: boolean) => void>();
  private readonly variableStore: VariableStore = {
    getVariable: (name) => this.values[name],
    setVariable: (name, value) => {
      this.values = { ...this.values, [name]: value };
    },
  };

  /** Lights the states the Preview plays and the transitions it takes; holds the last ones while paused. */
  readonly runTrace: GraphRunTrace = {
    subscribe: (listener) => {
      this.runListeners.add(listener);
      return () => this.runListeners.delete(listener);
    },
    value: () => undefined,
    subscribeHold: (listener) => {
      this.holdListeners.add(listener);
      listener(!this.snapshot.playing);
      return () => this.holdListeners.delete(listener);
    },
  };

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): AnimGraphPreviewSnapshot => this.snapshot;

  /**
   * The graph to run (clips resolved, so players know their lengths). Preview Values follow its variables: a new
   * variable starts at its default, and one whose type changed starts over.
   */
  setDocument(doc: AnimGraphDocument, graphGuid: string): void {
    this.doc = doc;
    this.graphGuid = graphGuid;
    const values: Record<string, unknown> = {};
    for (const variable of doc.variables) {
      const current = this.values[variable.name];
      values[variable.name] = current !== undefined && fitsVariable(variable, current)
        ? current
        : variable.defaultValue ?? defaultAnimVariableValue(variable.typeId, variable.typeClassId);
    }
    this.values = values;
    this.publish({ values });
  }

  /** Loads the graph's compiled rule and pose-data scripts into a fresh host; the previous one keeps running until then. */
  async loadScripts(bundles: readonly ScriptBundleEntry[]): Promise<void> {
    const generation = ++this.hostGeneration;
    const prefixes = [`AnimRule:${this.graphGuid}:`, `AnimPose:${this.graphGuid}:`];
    const host = new ScriptHost(previewHostServices());
    for (const script of bundles) {
      if (!prefixes.some((prefix) => script.classId.startsWith(prefix))) continue;
      await host.load(script);
      if (generation !== this.hostGeneration) return;
    }
    this.host = host;
  }

  /** Advances the graph by `dtSeconds` of game time (already scaled by Speed), or 0 to show where it stands. */
  tick(dtSeconds: number): void {
    const doc = this.doc;
    if (!doc) return;
    const previous = this.snapshot.state;
    const host = this.host;
    const guid = this.graphGuid;
    const state = evaluateAnimGraph(doc, previous, Math.max(0, dtSeconds), {
      // A rule not loaded yet (or that failed to compile) holds its transition shut, rather than passing as a game's
      // missing rule would.
      decideTransition: (transition, facts) =>
        host?.invokeAnimRule(animRuleScriptClassId(guid, transition.id), null, { variableStore: this.variableStore, animFacts: facts })
          ?? CLOSED_RULE,
      poseData: (key, facts) =>
        host?.invokeAnimPose(animPoseScriptClassId(guid, key), null, {
          variableStore: this.variableStore,
          ...(facts ? { animFacts: facts } : {}),
        }),
    });
    this.publish({ state, values: this.values });
    if (!this.snapshot.active) return;
    const nodes = [state.stateId, ...Object.keys(state.blendWeights).filter((id) => id !== state.stateId && state.blendWeights[id]! > 0)];
    const edge = previous && previous.stateId !== state.stateId
      ? animTransitionEdgeId(doc.stateMachine.transitions, previous.stateId, state.stateId)
      : undefined;
    const run: GraphRunEvent = { nodes, edges: edge ? [edge] : [] };
    for (const listener of this.runListeners) listener(run);
  }

  /** Advances one game tick and pauses. */
  step(): void {
    this.setPlaying(false);
    this.tick(ANIM_PREVIEW_STEP_SECONDS);
  }

  /** Starts over in the entry state, keeping Preview Values. */
  restart(): void {
    this.snapshot = { ...this.snapshot, state: null };
    this.tick(0);
  }

  /** Feeds a frame of real time from the Preview window's clock; nothing advances while paused. */
  advanceRealTime(seconds: number): void {
    if (!this.snapshot.playing) return;
    this.tick(Math.min(MAX_FRAME_SECONDS, Math.max(0, seconds)) * this.snapshot.speed);
  }

  setPlaying(playing: boolean): void {
    if (this.snapshot.playing === playing) return;
    this.publish({ playing });
    for (const listener of this.holdListeners) listener(!playing);
  }

  setSpeed(speed: number): void {
    this.publish({ speed });
  }

  setValue(name: string, value: unknown): void {
    this.values = { ...this.values, [name]: value };
    this.publish({ values: this.values });
  }

  /** Every Preview Value back to its variable's default. */
  resetValues(): void {
    this.values = {};
    if (this.doc) this.setDocument(this.doc, this.graphGuid);
  }

  /** The Preview window is open: its clock runs the session and the canvas lights what it plays. */
  setActive(active: boolean): void {
    if (this.snapshot.active === active) return;
    this.publish({ active });
  }

  dispose(): void {
    this.hostGeneration += 1;
    this.host = null;
    this.listeners.clear();
    this.runListeners.clear();
    this.holdListeners.clear();
  }

  private publish(patch: Partial<AnimGraphPreviewSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
}
