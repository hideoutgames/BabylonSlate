import {
  createDefaultWaterDefinition, emptyWaterSample, normalizeWaterBody,
  normalizeWaterBuoyancy, normalizeWaterDefinition, normalizeWaterRemoval, parseLandscapeProperties, quatRotateVector,
  sampleWaterSurface, waterCutAt, waterKindForClass,
  type LandscapeProperties, type Transform, type Vec3, type WaterBodyProperties, type WaterCutters, type WaterDefinition, type WaterSample,
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
  private cutters: WaterCutters = { removals: [], landscapes: [] };
  /** Parsed terrain per authored heights array; sculpting replaces the array. */
  private readonly terrain = new WeakMap<object, { size: string; data: LandscapeProperties }>();
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
    let transforms: Map<string, Transform> | undefined;
    this.bodies = [];
    const removals: Array<WaterCutters["removals"][number]> = [], landscapes: Array<WaterCutters["landscapes"][number]> = [];
    for (const actor of actors) {
      if (actor.destroyed || actor.sceneLayerId) continue;
      for (const component of actor.components) {
        if (component.destroyed) continue;
        if (component.classId === "WaterRemovalVolumeComponent" || component.classId === "LandscapeComponent") {
          transforms ??= actorWorldTransforms(actors);
          const transform = componentWorldTransform(component, actor, transforms.get(actor.guid)!);
          if (component.classId === "LandscapeComponent") {
            const heights = component.getVariable("heights");
            const key = Array.isArray(heights) ? heights : component;
            const size = ["width", "depth", "subdivisions"].map((name) => String(component.getVariable(name))).join(":");
            let entry = this.terrain.get(key);
            if (entry?.size !== size) {
              entry = { size, data: parseLandscapeProperties(Object.fromEntries(component.variables)) };
              this.terrain.set(key, entry);
            }
            landscapes.push({ data: entry.data, transform });
          } else {
            const volume = normalizeWaterRemoval(Object.fromEntries(component.variables));
            if (volume.enabled) removals.push({ volume, transform });
          }
          continue;
        }
        const kind = waterKindForClass(component.classId);
        if (!kind || component.destroyed) continue;
        const body = normalizeWaterBody(Object.fromEntries(component.variables), kind);
        if (!body.enabled) continue;
        const definition = body.assetGuid ? (this.definitions.get(body.assetGuid) ?? this.defaultWater) : this.defaultWater;
        transforms ??= actorWorldTransforms(actors);
        this.bodies.push({ actorId: actor.guid, definition, body,
          transform: componentWorldTransform(component, actor, transforms.get(actor.guid)!),
        });
      }
    }
    this.transforms = transforms ?? new Map();
    this.cutters = { removals, landscapes };
  }

  sample(position: Vec3, actorId: string | null = null): WaterWorldSample {
    let result: WaterWorldSample = { ...emptyWaterSample(), actorId: null, density: 0, waterDepth: 0 };
    for (const water of this.bodies) {
      if (actorId && water.actorId !== actorId) continue;
      const sample = sampleWaterSurface(water.definition, water.body, position, this.time, water.transform);
      // Removal volumes and terrain above the surface take the water away, for queries and buoyancy alike.
      if (sample.found && waterCutAt(this.cutters, { x: position.x, y: sample.height, z: position.z })) continue;
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
    if (height < 1e-6) return;
    const supports: Array<{
      point: Vec3; r: Vec3; sample: WaterWorldSample; drag: number; stiffness: number; maximumLift: number;
      response: { linear: Vec3; angular: Vec3 };
    }> = [];
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
      const response = backend.getBodyImpulseResponse?.(bodyId, { x: 0, y: 1, z: 0 }, point);
      const center = response?.centerOfMass ?? pose.position;
      const r = { x: point.x - center.x, y: point.y - center.y, z: point.z - center.z };
      const a = velocity.angular, v = velocity.linear;
      const drag = mass * Math.min(1, props.drag * dt) * submerged / 4;
      const spin = props.angularDrag;
      const lift = sample.density * volume * Math.max(0, gravity) / 4;
      supports.push({ point, r, sample, drag, stiffness: lift / height,
        maximumLift: lift * Math.min(1, sample.waterDepth / height, (sample.waterDepth - sample.depth + height / 2) / height) * dt,
        // Custom backends without inertia queries retain unit-inertia behavior.
        response: response ?? { linear: { x: 0, y: 1 / mass, z: 0 }, angular: { x: -r.z / mass, y: 0, z: r.x / mass } },
      });
      backend.addImpulseAtPoint(bodyId, {
        x: (sample.velocity.x - v.x - spin * (a.y * r.z - a.z * r.y)) * drag,
        y: 0,
        z: (sample.velocity.z - v.z - spin * (a.x * r.y - a.y * r.x)) * drag,
      }, point);
    }
    if (!supports.length) return;
    const afterDrag = backend.getBodyVelocity(bodyId)!;
    // All four springs share the same body's translation and rotation. Solve them
    // together using collider inertia; independent springs can flip a light hull.
    const coupling = supports.map(({ r }) => supports.map(({ response }) => ({
      linear: response.linear.y, angular: response.angular.z * r.x - response.angular.x * r.z,
    })));
    const free = supports.map(({ r, sample }) => ({
      linear: afterDrag.linear.y - sample.velocity.y - Math.max(0, gravity) * dt,
      angular: afterDrag.angular.z * r.x - afterDrag.angular.x * r.z,
    }));
    const impulses = supports.map(() => 0);
    // Projected Gauss-Seidel for the dry, surface and fully immersed branches.
    // The implicit solve bounds high-stiffness response without capping capacity.
    for (let iteration = 0; iteration < 32; iteration++) {
      let change = 0;
      for (let n = 0; n < supports.length; n++) {
        const i = iteration % 2 ? supports.length - n - 1 : n;
        const support = supports[i]!, row = coupling[i]!;
        let relative = free[i]!.linear + free[i]!.angular;
        let dragVelocity = free[i]!.linear + props.angularDrag * free[i]!.angular;
        for (let j = 0; j < supports.length; j++) if (j !== i) {
          relative += (row[j]!.linear + row[j]!.angular) * impulses[j]!;
          dragVelocity += (row[j]!.linear + props.angularDrag * row[j]!.angular) * impulses[j]!;
        }
        const dragFactor = 1 + support.drag * (row[i]!.linear + props.angularDrag * row[i]!.angular);
        const dragImpulse = -support.drag * dragVelocity;
        const next = Math.max(dragImpulse / dragFactor, Math.min(
          (support.maximumLift + dragImpulse) / dragFactor,
          (support.stiffness * dt * (support.sample.depth + height / 2 - relative * dt) + dragImpulse)
            / (dragFactor + support.stiffness * dt * dt * (row[i]!.linear + row[i]!.angular)),
        ));
        change = Math.max(change, Math.abs(next - impulses[i]!));
        impulses[i] = next;
      }
      if (change < mass * 1e-7) break;
    }
    supports.forEach(({ point }, i) => backend.addImpulseAtPoint(bodyId, { x: 0, y: impulses[i]!, z: 0 }, point));
  }
}
