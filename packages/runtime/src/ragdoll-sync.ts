import { parseRagdollProperties, type RagdollProperties, type Transform } from "@babylonslate/core";
import type { CommandMessage, ControlMessage } from "@babylonslate/bridge";
import type { Actor, ActorComponent, World } from "@babylonslate/object-model";
import { RagdollPhysics, type Vec3 } from "@babylonslate/physics";
import { actorWorldTransforms } from "./actor-world-transform";
import { actorLocalPhysicsTransform, type PhysicsWorldSync } from "./physics-sync";
import { sameDescriptor } from "./physics-preparation";

type CapturedPose = Extract<ControlMessage, { type: "ragdollPoseCaptured" }>;

interface RagdollState {
  actor: Actor;
  component: ActorComponent;
  descriptor: readonly unknown[];
  properties: RagdollProperties | null;
  slotId: number;
  requestId: string;
  requestedAt: number;
  phase: "pending" | "active" | "failed";
  physics: RagdollPhysics | null;
  offset: Vec3;
  rotation: Transform["rotation"];
}

/** Renderer captures animation; only the worker creates and steps ragdoll bodies. */
export class RagdollWorldSync {
  private readonly states = new Map<Actor, RagdollState>();
  private sequence = 0;

  constructor(private readonly host: {
    world: World;
    physics: () => PhysicsWorldSync;
    slot: (actor: Actor) => number | undefined;
    eligible: (actor: Actor) => boolean;
    deferNative: boolean;
    emit: (command: CommandMessage) => void;
    error: (error: Error) => void;
  }) {}

  sync(): void {
    const actors = this.host.world.getActors();
    const live = new Set(actors);
    for (const [actor] of this.states) {
      if (!live.has(actor) || actor.destroyed) this.retire(actor);
    }
    const transforms = actorWorldTransforms(actors);
    for (const actor of actors) {
      if (!this.host.eligible(actor)) {
        this.retire(actor);
        continue;
      }
      const enabledComponents = actor.components.filter((entry) => !entry.destroyed && entry.owner === actor && entry.classId === "RagdollComponent" && entry.getVariable("enabled") === true);
      const component = enabledComponents[0];
      const old = this.states.get(actor);
      if (!component || component.getVariable("enabled") !== true) {
        this.retire(actor);
        continue;
      }
      const slotId = this.host.slot(actor);
      if (slotId === undefined) continue;
      const scale = transforms.get(actor.guid)?.scale ?? actor.transform.scale;
      const descriptor = sourceDescriptor(actor, component, scale);
      if (old?.component === component && old.slotId === slotId && sameDescriptor(old.descriptor, descriptor)) {
        if (old.phase === "pending" && this.host.world.clock.tickIndex - old.requestedAt > 600) {
          this.fail(old, new Error("The renderer did not provide a skeletal pose within 600 simulation ticks"));
        }
        continue;
      }
      this.retire(actor);
      const state: RagdollState = {
        actor, component, descriptor, slotId,
        requestId: `ragdoll:${++this.sequence}:${actor.guid}:${component.guid}`,
        requestedAt: this.host.world.clock.tickIndex,
        properties: null, phase: "pending", physics: null,
        offset: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 },
      };
      this.states.set(actor, state);
      component.setVariable("status", "pending");
      try {
        if (enabledComponents.length > 1) throw new Error("An actor can have only one enabled RagdollComponent");
        state.properties = parseRagdollProperties(Object.fromEntries(component.variables));
        if (actor.sceneLayerId || this.host.physics().getBackend().kind !== "3d") throw new Error("Skeletal ragdolls require a 3D physics world");
        if (!this.host.physics().getBackend().supportsConstraints) {
          if (this.host.deferNative) {
            this.states.delete(actor);
            continue;
          }
          throw new Error("Skeletal ragdolls require the native Havok physics backend");
        }
        if (![scale.x, scale.y, scale.z].every((value) => Number.isFinite(value) && value > 0)) {
          throw new Error("Ragdoll actor scale must be finite and positive");
        }
        this.host.emit({ type: "captureRagdollPose", slotId, requestId: state.requestId, boneNames: state.properties.boneNames });
      } catch (error) { this.fail(state, error); }
    }
  }

  accept(message: CapturedPose): void {
    // Recheck authored enable/model state before accepting an asynchronous reply.
    this.sync();
    const state = [...this.states.values()].find((entry) => entry.slotId === message.slotId && entry.requestId === message.requestId);
    if (!state || !state.properties || !this.host.eligible(state.actor)) return;
    if (message.error && state.phase !== "failed") {
      this.fail(state, new Error(message.error));
      return;
    }
    if (state.phase !== "pending") return;
    if (!message.bones) {
      this.fail(state, new Error(message.error || "No skeletal pose was captured"));
      return;
    }
    let physics: RagdollPhysics | null = null;
    try {
      physics = new RagdollPhysics(this.host.physics().getBackend(), state.actor.guid, state.requestId, message.bones, state.properties);
      const root = physics.readPose().find((bone) => bone.name === physics!.rootBoneName);
      if (!root) throw new Error("The ragdoll has no root bone pose");
      const transform = actorWorldTransforms(this.host.world.getActors()).get(state.actor.guid)!;
      state.offset = { x: transform.position.x - root.position.x, y: transform.position.y - root.position.y, z: transform.position.z - root.position.z };
      state.rotation = { ...transform.rotation };
      this.host.physics().suppressActorBody(state.actor, true);
      state.physics = physics;
      state.phase = "active";
      state.component.setVariable("status", "active");
      this.host.emit({ type: "setRagdollPose", slotId: state.slotId, requestId: state.requestId, bones: physics.readPose() });
    } catch (error) {
      physics?.dispose();
      this.fail(state, error);
    }
  }

  afterStep(): void {
    const transforms = actorWorldTransforms(this.host.world.getActors());
    for (const state of this.states.values()) {
      if (!state.physics || !this.host.eligible(state.actor)) continue;
      const bones = state.physics.readPose();
      const root = bones.find((bone) => bone.name === state.physics!.rootBoneName);
      if (!root) continue;
      const position = { x: root.position.x + state.offset.x, y: root.position.y + state.offset.y, z: root.position.z + state.offset.z };
      const local = actorLocalPhysicsTransform({ position, rotation: state.rotation }, state.actor, transforms);
      Object.assign(state.actor.transform.position, local.position);
      Object.assign(state.actor.transform.rotation, local.rotation);
      transforms.set(state.actor.guid, { position, rotation: state.rotation, scale: transforms.get(state.actor.guid)!.scale });
      this.host.emit({ type: "setRagdollPose", slotId: state.slotId, requestId: state.requestId, bones });
    }
  }

  addImpulse(actor: Actor, impulse: Vec3, strength?: number): boolean {
    const physics = this.states.get(actor)?.physics;
    if (!physics) return false;
    physics.addImpulse(impulse, strength);
    return true;
  }

  retire(actor: Actor): void {
    const state = this.states.get(actor);
    if (!state) return;
    state.physics?.dispose();
    this.host.physics().suppressActorBody(actor, false);
    this.states.delete(actor);
    state.component.setVariable("status", "disabled");
    this.host.emit({ type: "clearRagdollPose", slotId: state.slotId, requestId: state.requestId });
  }

  dispose(): void {
    for (const actor of this.states.keys()) this.retire(actor);
  }

  private fail(state: RagdollState, error: unknown): void {
    state.physics?.dispose();
    state.physics = null;
    state.phase = "failed";
    state.component.setVariable("status", "failed");
    this.host.physics().suppressActorBody(state.actor, false);
    this.host.emit({ type: "clearRagdollPose", slotId: state.slotId, requestId: state.requestId });
    this.host.error(new Error(`Ragdoll ${state.component.guid} on actor ${state.actor.guid}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
  }
}

function sourceDescriptor(actor: Actor, component: ActorComponent, scale: Vec3): unknown[] {
  const descriptor: unknown[] = [scale.x, scale.y, scale.z];
  for (const name of ["enabled", "totalMass", "radius", "angularLimit", "linearDamping", "angularDamping", "friction", "restitution", "layer", "mask"]) {
    descriptor.push(component.getVariable(name));
  }
  const names = component.getVariable("boneNames");
  descriptor.push(names);
  if (Array.isArray(names)) descriptor.push(...names);
  for (const mesh of actor.components) {
    if (mesh.classId === "RagdollComponent") {
      descriptor.push(mesh, mesh.destroyed, mesh.owner, mesh.getVariable("enabled"));
    }
    if (mesh.classId !== "MeshComponent" || mesh.destroyed || mesh.owner !== actor) continue;
    descriptor.push(mesh, mesh.assetGuid, mesh.getVariable("assetGuid"), mesh.getVariable("meshKind"));
    const { position, rotation, scale: localScale } = mesh.transform;
    descriptor.push(position.x, position.y, position.z, rotation.x, rotation.y, rotation.z, rotation.w, localScale.x, localScale.y, localScale.z);
  }
  return descriptor;
}
