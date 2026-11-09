import {
  identityTransform,
  parseSpringArmProperties,
  SPRING_ARM_COMPONENT_CLASS_ID,
  stepSpringArmProbeLength,
  type SpringArmProperties,
} from "@haptic/core";
import type { CommandMessage } from "@haptic/bridge";
import type { Actor, ActorComponent, World } from "@haptic/object-model";
import type { LineTraceOptions, PhysicsTransform } from "@haptic/physics";
import { actorParentGuid, composeParentChildTransform } from "./actor-world-transform";
import type { RuntimeSubsystem } from "./runtime-subsystems";
import { setProbedSpringArmLength } from "./spring-arm-socket";
import { componentWorldTransform } from "./tween-transforms";

/** The channel-aware sweep of the main physics world (`PhysicsWorldSync.shapeSweep`). */
export interface SpringArmProbePhysics {
  shapeSweep(
    shape: { kind: "sphere"; radius: number },
    start: PhysicsTransform,
    end: PhysicsTransform,
    options?: LineTraceOptions & { channel?: string },
  ): { hit: boolean; distance: number };
}

interface SpringArmProbeHost {
  world: World;
  physics: () => SpringArmProbePhysics;
  eligible: (actor: Actor) => boolean;
  slot: (actor: Actor) => number | undefined;
  emit: (command: CommandMessage) => void;
}

type ProbeState = {
  /** World destruction clears component.owner before the actor's slot retires. */
  owner: Actor | null;
  /** The probed arm length, or null while the probe is off. */
  length: number | null;
  sentLength: number | null;
  sentSlot: number;
};

type ProbeUpdate = { slotId: number; componentId: string; length: number | null };

const IDENTITY_ROTATION = { x: 0, y: 0, z: 0, w: 1 } as const;
/** An arm shorter than this has nothing to probe. */
const MIN_PROBE_SPAN = 1e-6;

/**
 * Spring Arm Camera Probe (Play). After each physics step it sweeps a sphere
 * from every probing arm's pivot to its socket, ignoring the arm's own actor
 * and the actors it is attached to, and shortens the arm to the first hit:
 * at once when blocked, easing back at Probe Return Speed when clear. The
 * length goes to the renderer (`springArmProbe`) and to worker-side poses
 * (`springArmSocketOffset`). Arms register as their visuals are assigned.
 */
export class SpringArmProbeSync implements RuntimeSubsystem {
  private readonly arms = new Map<ActorComponent, ProbeState>();
  private readonly host: SpringArmProbeHost;
  private readonly start: PhysicsTransform = { position: { x: 0, y: 0, z: 0 }, rotation: IDENTITY_ROTATION };
  private readonly end: PhysicsTransform = { position: { x: 0, y: 0, z: 0 }, rotation: IDENTITY_ROTATION };
  private readonly findActor = (guid: string) => this.host.world.findActor(guid);

  constructor(host: SpringArmProbeHost) {
    this.host = host;
  }

  assign(component: ActorComponent): void {
    if (component.classId !== SPRING_ARM_COMPONENT_CLASS_ID || this.arms.has(component)) return;
    this.arms.set(component, { owner: component.owner, length: null, sentLength: null, sentSlot: -1 });
  }

  step(dt: number, frameId: number): void {
    let updates: ProbeUpdate[] | null = null;
    for (const [component, state] of this.arms) {
      const actor = component.owner;
      if (component.destroyed || !actor || actor.destroyed || !actor.components.includes(component)) {
        this.forget(component);
        continue;
      }
      state.owner = actor;
      // Spring arms are World-scene components; a Scene Layer's arm keeps its full length.
      if (actor.sceneLayerId || !this.host.eligible(actor)) continue;
      const properties = parseSpringArmProperties(Object.fromEntries(component.variables));
      state.length = properties.cameraProbe ? this.probe(component, actor, properties, state.length, dt) : null;
      setProbedSpringArmLength(component, state.length);
      const slotId = this.host.slot(actor) ?? -1;
      const slotChanged = slotId !== state.sentSlot;
      state.sentSlot = slotId;
      // A new slot needs the probed length again; an arm without a probe has nothing for it to clear.
      if (state.length === state.sentLength && !(slotChanged && state.length !== null)) continue;
      state.sentLength = state.length;
      if (slotId >= 0) (updates ??= []).push({ slotId, componentId: component.guid, length: state.length });
    }
    if (updates) this.host.emit({ type: "springArmProbe", frameId, arms: updates });
  }

  retireActor(actor: Actor): void {
    for (const [component, state] of this.arms) {
      if (state.owner === actor) this.forget(component);
    }
  }

  releaseSlot(_slotId: number, owner: Actor | undefined): void {
    if (owner) this.retireActor(owner);
  }

  dispose(): void {
    for (const component of this.arms.keys()) setProbedSpringArmLength(component, null);
    this.arms.clear();
  }

  private forget(component: ActorComponent): void {
    setProbedSpringArmLength(component, null);
    this.arms.delete(component);
  }

  private probe(
    component: ActorComponent,
    actor: Actor,
    properties: SpringArmProperties,
    current: number | null,
    dt: number,
  ): number | null {
    const pivot = componentWorldTransform(component, this.findActor);
    if (!pivot) return current;
    const socket = composeParentChildTransform(pivot, {
      ...identityTransform(),
      position: { x: 0, y: 0, z: -properties.armLength },
    });
    const dx = socket.position.x - pivot.position.x;
    const dy = socket.position.y - pivot.position.y;
    const dz = socket.position.z - pivot.position.z;
    const span = Math.hypot(dx, dy, dz);
    let target = properties.armLength;
    if (span > MIN_PROBE_SPAN) {
      Object.assign(this.start.position, pivot.position);
      Object.assign(this.end.position, socket.position);
      const hit = this.host.physics().shapeSweep(
        { kind: "sphere", radius: properties.probeSize },
        this.start,
        this.end,
        { channel: properties.probeChannel, ignoreActorIds: this.attachmentChain(actor), includeTriggers: false },
      );
      // Distance is sphere-centre travel, so the camera stops a probe radius clear of the hit.
      if (hit.hit) target = properties.armLength * Math.min(1, Math.max(0, hit.distance / span));
    }
    return stepSpringArmProbeLength(current, target, properties.probeReturnSpeed, dt);
  }

  /** The arm's actor and every actor it is attached to: a camera never collides with its own rig. */
  private attachmentChain(actor: Actor): string[] {
    const ids: string[] = [];
    for (let current: Actor | undefined = actor; current && !ids.includes(current.guid);) {
      ids.push(current.guid);
      const parentId = actorParentGuid(current);
      current = parentId ? this.findActor(parentId) : undefined;
    }
    return ids;
  }
}
