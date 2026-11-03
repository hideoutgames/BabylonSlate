import type { CommandMessage } from "@haptic/bridge";
import {
  PARTICLE_TRANSIENT_EFFECT_BUDGET,
  rotatorToQuat,
  type SerializedComponent,
  type Transform,
} from "@haptic/core";
import type { Actor, EngineObject } from "@haptic/object-model";
import { composeActorWorldTransforms } from "./actor-world-transform";
import type { LogSeverity } from "./log-ring";
import type { RuntimeSubsystem } from "./runtime-subsystems";
import { asActor, finiteRotator, finiteVector } from "./script-host-helpers";

/** Spawn Particles At Location / Spawn Particles Attached, as the script context passes them. */
export interface ParticleEffectRequest {
  systemGuid: string;
  /** World location, or the offset from Attach To. */
  location?: unknown;
  /** World rotation (rotator, degrees), or the offset from Attach To. */
  rotation?: unknown;
  scale?: unknown;
  /** Present for Spawn Particles Attached. */
  attachTo?: unknown;
  bone?: string;
  autoDestroy: boolean;
}

interface ParticleEffectsHost {
  findActor(guid: string): Actor | undefined;
  /** Whether the guid names a Particle System the session can play (an empty catalog trusts every guid). */
  knowsParticleSystem(guid: string): boolean;
  /** An engine-internal actor of the base Actor class holding `components`, realized at once; null when it cannot spawn. */
  spawnEngineActor(options: { transform: Transform; components: SerializedComponent[]; streamOwner: EngineObject | null }): Actor | null;
  destroyActor(actor: Actor): void;
  /** `bone` empty detaches from any bone. */
  attachToBone(actor: Actor, target: Actor | null, bone: string): void;
  emit(command: CommandMessage): void;
  reportLog(message: string, severity: LogSeverity, category: string): void;
}

type Effect = {
  actor: Actor;
  componentGuid: string;
  /** Destroyed once its playback ends (also set for evicted and orphaned effects). */
  autoDestroy: boolean;
  /** Stop was sent (eviction or parent destroyed); it ends with the drain's report. */
  stopping: boolean;
};

const PARTICLE_COMPONENT_ID = "particles";

/**
 * Fire-and-forget particle effects: engine-internal actors of the base Actor class, each with one
 * ParticleComponent that plays on spawn. Auto Destroy removes the actor when the render host
 * reports its playback ended. An attached effect whose parent is destroyed stops emitting,
 * detaches with its world transform, drains and destroys itself. At most
 * `PARTICLE_TRANSIENT_EFFECT_BUDGET` live at once: beyond it the oldest is stopped (it drains,
 * then goes) and the session warns once.
 */
export class RuntimeParticleEffects implements RuntimeSubsystem {
  private readonly host: ParticleEffectsHost;
  /** Spawn order: the first is the oldest. */
  private readonly effects: Effect[] = [];
  private readonly unknownReported = new Set<string>();
  private budgetReported = false;

  constructor(host: ParticleEffectsHost) {
    this.host = host;
  }

  get count(): number {
    return this.effects.length;
  }

  spawn(request: ParticleEffectRequest, owner: EngineObject | null): Actor | null {
    const guid = String(request.systemGuid ?? "").trim();
    if (!guid || !this.host.knowsParticleSystem(guid)) {
      const key = guid || "(none)";
      if (!this.unknownReported.has(key)) {
        this.unknownReported.add(key);
        this.host.reportLog(`particle.unknown_system: Spawn Particles needs a Particle System; ${guid ? `"${guid}" is not one` : "none is set"}.`,
          "warning", "particles");
      }
      return null;
    }
    const attached = request.attachTo !== undefined;
    const parent = attached ? asActor(request.attachTo) : null;
    if (attached && (!parent || parent.destroyed)) return null;
    const rotator = finiteRotator(request.rotation as Record<string, number>);
    const transform: Transform = {
      position: finiteVector(request.location as Record<string, number>, 0) ?? { x: 0, y: 0, z: 0 },
      rotation: rotator ? rotatorToQuat(rotator) : { x: 0, y: 0, z: 0, w: 1 },
      scale: finiteVector(request.scale as Record<string, number>, 1) ?? { x: 1, y: 1, z: 1 },
    };
    const actor = this.host.spawnEngineActor({
      transform,
      components: [{ id: PARTICLE_COMPONENT_ID, classId: "ParticleComponent", properties: { particleSystemGuid: guid, playOnStart: true } }],
      streamOwner: owner,
    });
    const component = actor?.components.find((entry) => entry.classId === "ParticleComponent");
    if (!actor || !component) return null;
    if (parent) {
      // The transform is now an offset from the parent (or its bone).
      actor.setVariable("parentId", parent.guid);
      if (request.bone?.trim()) this.host.attachToBone(actor, parent, request.bone.trim());
    }
    this.effects.push({ actor, componentGuid: component.guid, autoDestroy: request.autoDestroy, stopping: false });
    this.enforceBudget();
    return actor;
  }

  /** A current `particlePlaybackEnded` report (finished, stopped or failed): Auto Destroy removes the effect. */
  ended(actorGuid: string, componentGuid: string): void {
    const effect = this.effects.find((entry) => entry.actor.guid === actorGuid && entry.componentGuid === componentGuid);
    if (!effect?.autoDestroy || effect.actor.destroyed) return;
    this.forget(effect.actor);
    this.host.destroyActor(effect.actor);
  }

  retireActor(actor: Actor): void {
    this.departed(actor);
  }

  /** A World-destroyed actor leaves at the next publish, which releases its slot. */
  releaseSlot(_slotId: number, owner: Actor | undefined): void {
    if (owner) this.departed(owner);
  }

  /**
   * An effect that leaves is forgotten. A departing parent's effects go on in the world and end:
   * children of authored actors keep their link, effects detach at their current world pose.
   */
  private departed(actor: Actor): void {
    if (this.forget(actor)) return;
    for (const effect of this.effects) {
      if (effect.actor.destroyed || effect.actor.getVariable("parentId") !== actor.guid) continue;
      // The departing parent may already be out of the World (or flagged destroyed): compose through it directly.
      const lookup = (guid: string) => (guid === actor.guid ? actor : this.host.findActor(guid));
      const world = composeActorWorldTransforms(lookup, [effect.actor]).get(effect.actor.guid);
      this.host.attachToBone(effect.actor, null, "");
      effect.actor.setVariable("parentId", null);
      if (world) {
        Object.assign(effect.actor.transform.position, world.position);
        Object.assign(effect.actor.transform.rotation, world.rotation);
        Object.assign(effect.actor.transform.scale, world.scale);
      }
      this.stop(effect);
    }
  }

  resetForSceneLoad(): void {
    this.effects.length = 0;
  }

  dispose(): void {
    this.effects.length = 0;
  }

  private enforceBudget(): void {
    let live = this.effects.filter((effect) => !effect.stopping).length;
    if (live <= PARTICLE_TRANSIENT_EFFECT_BUDGET) return;
    if (!this.budgetReported) {
      this.budgetReported = true;
      this.host.reportLog(`particle.transient_budget: more than ${PARTICLE_TRANSIENT_EFFECT_BUDGET} spawned particle effects at once; the oldest are stopped.`,
        "warning", "particles");
    }
    for (const effect of this.effects) {
      if (live <= PARTICLE_TRANSIENT_EFFECT_BUDGET) break;
      if (effect.stopping) continue;
      this.stop(effect);
      live -= 1;
    }
  }

  /** Stop emitting; the drain's report destroys it. */
  private stop(effect: Effect): void {
    effect.stopping = true;
    effect.autoDestroy = true;
    this.host.emit({ type: "setParticlePlaying", actorGuid: effect.actor.guid, componentId: effect.componentGuid, playing: false });
  }

  private forget(actor: Actor): boolean {
    const index = this.effects.findIndex((effect) => effect.actor === actor);
    if (index < 0) return false;
    this.effects.splice(index, 1);
    return true;
  }
}
