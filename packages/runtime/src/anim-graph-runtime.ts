import type { CommandMessage } from "@babylonslate/bridge";
import { Actor, ActorComponent } from "@babylonslate/object-model";
import {
  animGraphScriptClassId,
  animRuleScriptClassId,
  clipForState,
  defaultAnimVariableValue,
  evaluateAnimGraph,
  type AnimEvalState,
  type AnimGraphDocument,
  type AnimGraphInputs,
} from "@babylonslate/anim-graph";
import type { AnimGraphControl, ScriptHost } from "./script-host";

type SpriteClip = { assetGuid: string; clipName: string; normalisedTime: number };

interface AnimGraphRuntimeHost {
  actors(): readonly Actor[];
  stopped(): boolean;
  canTick(actor: Actor): boolean;
  /** The render slot this actor's own commands target. */
  slot(actor: Actor): number | undefined;
  /** Whether the actor holds a render slot when a script asks for control. */
  hasRenderSlot(actor: Actor): boolean;
  /** A Behaviour Tree Play Animation task owns this slot's animation state. */
  playAnimationOwns(slotId: number): boolean;
  dt(): number;
  scripts(): Pick<ScriptHost, "invokeAnimEvent" | "invokeAnimRule">;
  setSpriteClip(actor: Actor, clip: SpriteClip | null): void;
  emit(command: CommandMessage): void;
}

/** AnimationGraph documents and per-component evaluation state for Play. */
export class AnimGraphRuntime {
  private readonly documents = new Map<string, AnimGraphDocument>();
  private readonly evalByComponent = new Map<string, AnimEvalState>();
  private readonly initializedBySlot = new Set<string>();
  private readonly liveInitKeys = new Set<string>();
  private readonly liveEvalKeys = new Set<string>();
  private readonly pendingJumpByComponent = new Map<string, string>();
  private readonly host: AnimGraphRuntimeHost;

  constructor(host: AnimGraphRuntimeHost) { this.host = host; }

  register(guid: string, document: AnimGraphDocument): void {
    this.documents.set(guid, document);
  }

  /** Drop documents a replaced source catalog no longer retains. */
  retain(retained: ReadonlySet<string>): void {
    for (const guid of this.documents.keys()) if (!retained.has(guid)) this.documents.delete(guid);
  }

  /** Forget a removed component's evaluation, pending jump and initialization. */
  forgetComponent(component: ActorComponent): void {
    this.evalByComponent.delete(component.guid);
    this.pendingJumpByComponent.delete(component.guid);
    for (const key of this.initializedBySlot) {
      if (key.startsWith(`${component.guid}:`)) this.initializedBySlot.delete(key);
    }
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
    const guid = this.graphGuid(target);
    const document = guid ? this.documents.get(guid) : undefined;
    const evalKey = target.guid;
    return {
      getVariable: (name) => target.getVariable(name),
      setVariable: (name, value) => {
        target.setVariable(name, value);
      },
      getCurrentState: () => {
        const evalState = this.evalByComponent.get(evalKey);
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
        if (!match) return;
        this.pendingJumpByComponent.set(evalKey, match.id);
      },
    };
  }

  private graphGuid(component: {
    assetGuid: string | null;
    getVariable(name: string): unknown;
  }): string | null {
    const graphGuid = component.getVariable("graphGuid");
    if (typeof graphGuid === "string" && graphGuid.length > 0) return graphGuid;
    return component.assetGuid;
  }

  private inputsFromComponent(component: {
    getVariable(name: string): unknown;
  }): AnimGraphInputs {
    const conditions: Record<string, boolean> = {};
    const raw = component.getVariable("conditions");
    if (raw && typeof raw === "object") {
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        conditions[key] = value === true;
      }
    }
    return { conditions };
  }

  private seedVariables(
    component: ActorComponent,
    document: AnimGraphDocument,
  ): void {
    for (const variable of document.variables) {
      if (component.getVariable(variable.name) !== undefined) continue;
      component.setVariable(
        variable.name,
        variable.defaultValue !== undefined
          ? variable.defaultValue
          : defaultAnimVariableValue(variable.typeId),
      );
    }
  }

  private variablesFromComponent(
    component: ActorComponent,
    document: AnimGraphDocument,
  ): Record<string, unknown> {
    const variables: Record<string, unknown> = {
      ...this.inputsFromComponent(component).conditions,
    };
    for (const variable of document.variables) {
      const value = component.getVariable(variable.name);
      if (value !== undefined) variables[variable.name] = value;
    }
    return variables;
  }

  tick(): void {
    if (this.documents.size === 0) return;
    const liveKeys = this.liveInitKeys;
    const liveEvalKeys = this.liveEvalKeys;
    liveKeys.clear();
    liveEvalKeys.clear();
    for (const actor of this.host.actors()) {
      if (this.host.stopped()) return;
      if (!this.host.canTick(actor)) continue;
      const slotId = this.host.slot(actor);
      if (slotId === undefined) continue;
      if (this.host.playAnimationOwns(slotId)) continue;
      for (const component of actor.components) {
        if (!this.host.canTick(actor)) break;
        if (
          component.classId !== "AnimationGraphComponent" ||
          component.destroyed
        ) {
          continue;
        }
        const guid = this.graphGuid(component);
        if (!guid) continue;
        const document = this.documents.get(guid);
        if (!document) continue;
        const evalKey = component.guid;
        const initKey = `${evalKey}:${guid}`;
        liveKeys.add(initKey);
        liveEvalKeys.add(evalKey);
        this.seedVariables(component, document);
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
          this.host.dt(),
          extras,
        );
        const next = evaluateAnimGraph(
          document,
          this.evalByComponent.get(evalKey) ?? null,
          this.host.dt(),
          {
            variables: this.variablesFromComponent(component, document),
            ...this.inputsFromComponent(component),
            decideTransition: (transition, facts) =>
              this.host.scripts().invokeAnimRule(
                animRuleScriptClassId(guid, transition.id),
                actor,
                { variableStore: component, animFacts: facts },
              ),
          },
        );
        this.evalByComponent.set(evalKey, next);
        const clip = clipForState(document, next.stateId);
        if (clip?.kind === "sprite" && clip.assetGuid) {
          this.host.setSpriteClip(actor, {
            assetGuid: clip.assetGuid,
            clipName: clip.clipName,
            normalisedTime: next.normalisedTime,
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
    // Deleting the visited entry keeps Set/Map iteration valid, so prune in place.
    for (const key of this.initializedBySlot) {
      if (!liveKeys.has(key)) this.initializedBySlot.delete(key);
    }
    for (const evalKey of this.evalByComponent.keys()) {
      if (!liveEvalKeys.has(evalKey)) this.evalByComponent.delete(evalKey);
    }
    liveKeys.clear();
    liveEvalKeys.clear();
  }
}
