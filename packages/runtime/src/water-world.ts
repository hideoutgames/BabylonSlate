import {
  createDefaultWaterDefinition, emptyWaterSample, normalizeWaterBody,
  normalizeWaterBuoyancy, normalizeWaterDefinition, quatRotateVector,
  sampleWaterSurface, waterKindForClass,
  type Transform, type Vec3, type WaterBodyProperties, type WaterDefinition, type WaterSample,
} from "@babylonslate/core";
import type { Actor, ActorComponent } from "@babylonslate/object-model";
import type { PhysicsBackend } from "@babylonslate/physics";
import { actorWorldTransforms, composeParentChildTransform } from "./actor-world-transform";

type WaterBody = { actorId: string; definition: WaterDefinition; body: WaterBodyProperties; transform: Transform };
export type WaterWorldSample = WaterSample & { actorId: string | null; density: number; waterDepth: number };

/** Component attachments have the same transform meaning in physics and rendering. */
function componentWorldTransform(component: ActorComponent, actor: Actor, world: Transform): Transform {
  const chain = [component.transform];
  const seen = new Set([component.guid]);
  let parentId = component.parentId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = actor.components.find((c) => c.guid === parentId && !c.destroyed);
    if (!parent) break;
    chain.push(parent.transform);
    parentId = parent.parentId;
  }
  let result = world;
  for (let i = chain.length - 1; i >= 0; i--) result = composeParentChildTransform(result, chain[i]!);
  return result;
}

export class WaterWorld {
  private definitions = new Map<string, WaterDefinition>();
  private bodies: WaterBody[] = [];
  private transforms = new Map<string, Transform>();
  private time = 0;
  private readonly defaultWater = createDefaultWaterDefinition();
  get hasBodies(): boolean { return this.bodies.length > 0; }

  setContent(content: ReadonlyMap<string, WaterDefinition> | Readonly<Record<string, WaterDefinition>>): void {
    const entries = content instanceof Map ? content.entries() : Object.entries(content);
    this.definitions = new Map(Array.from(entries, ([id, value]) => [id, normalizeWaterDefinition(value)]));
  }

  update(actors: readonly Actor[], time: number): void {
    this.time = time;
    this.transforms = actorWorldTransforms(actors);
    this.bodies = [];
    for (const actor of actors) {
      if (actor.destroyed || actor.sceneLayerId) continue;
      for (const component of actor.components) {
        const kind = waterKindForClass(component.classId);
        if (!kind || component.destroyed) continue;
        const body = normalizeWaterBody(Object.fromEntries(component.variables), kind);
        if (!body.enabled) continue;
        const definition = body.assetGuid ? (this.definitions.get(body.assetGuid) ?? this.defaultWater) : this.defaultWater;
        if (!definition) continue;
        this.bodies.push({ actorId: actor.guid, definition, body,
          transform: componentWorldTransform(component, actor, this.transforms.get(actor.guid)!),
        });
      }
    }
  }

  sample(position: Vec3, actorId: string | null = null): WaterWorldSample {
    let result: WaterWorldSample = { ...emptyWaterSample(), actorId: null, density: 0, waterDepth: 0 };
    for (const water of this.bodies) {
      if (actorId && water.actorId !== actorId) continue;
      const sample = sampleWaterSurface(water.definition, water.body, position, this.time, water.transform);
      if (sample.found && (!result.found || sample.height > result.height)) {
        result = { ...sample, actorId: water.actorId, density: water.definition.density, waterDepth: water.body.depth * Math.abs(water.transform.scale.y) };
      }
    }
    return result;
  }

  /** Lift and point drag add to native collision impulses; authored poses are never overwritten. */
  applyBuoyancy(actor: Actor, bodyId: string, backend: PhysicsBackend, mass: number, gravity: number, dt: number): void {
    if (backend.kind !== "3d" || dt <= 0 || mass <= 0) return;
    const component = actor.components.find((c) => c.classId === "WaterBuoyancyComponent" && !c.destroyed && c.getVariable("enabled") !== false);
    if (!component) return;
    const props = normalizeWaterBuoyancy(Object.fromEntries(component.variables));
    const actorTransform = this.transforms.get(actor.guid);
    const pose = backend.getBodyTransform(bodyId), velocity = backend.getBodyVelocity(bodyId);
    if (!actorTransform || !pose || !velocity) return;
    const transform = componentWorldTransform(component, actor, { ...actorTransform, ...pose });
    const height = props.height * Math.abs(transform.scale.y);
    for (const x of [-0.5, 0.5]) for (const z of [-0.5, 0.5]) {
      const offset = quatRotateVector(transform.rotation, {
        x: (props.offset[0] + x * props.width) * transform.scale.x,
        y: props.offset[1] * transform.scale.y,
        z: (props.offset[2] + z * props.length) * transform.scale.z,
      });
      const point = { x: transform.position.x + offset.x, y: transform.position.y + offset.y, z: transform.position.z + offset.z };
      const sample = this.sample(point, props.waterActorId);
      if (!sample.found || sample.depth > sample.waterDepth + height / 2) continue;
      const submerged = Math.max(0, Math.min(sample.waterDepth, sample.depth + height / 2) - Math.max(0, sample.depth - height / 2)) / height;
      if (submerged === 0) continue;
      const volume = props.volume > 0 ? props.volume * Math.abs(transform.scale.x * transform.scale.y * transform.scale.z) : 2 * mass / sample.density;
      const r = { x: point.x - pose.position.x, y: point.y - pose.position.y, z: point.z - pose.position.z };
      const a = velocity.angular, v = velocity.linear;
      const drag = mass * Math.min(1, props.drag * dt) * submerged / 4;
      const spin = props.angularDrag;
      backend.addImpulseAtPoint(bodyId, {
        x: (sample.velocity.x - v.x - spin * (a.y * r.z - a.z * r.y)) * drag,
        y: sample.density * volume * Math.max(0, gravity) * submerged * dt / 4 + (sample.velocity.y - v.y - spin * (a.z * r.x - a.x * r.z)) * drag,
        z: (sample.velocity.z - v.z - spin * (a.x * r.y - a.y * r.x)) * drag,
      }, point);
    }
  }
}
