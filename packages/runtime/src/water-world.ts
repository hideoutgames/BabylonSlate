import {
  createDefaultWaterDefinition, emptyWaterSample, normalizeWaterBody,
  normalizeWaterBuoyancy, normalizeWaterDefinition, normalizeWaterRemoval, parseLandscapeProperties, quatRotateVector,
  sampleWaterSurface, waterCutAt, waterKindForClass, waterSurfaceDrift,
  type LandscapeProperties, type Transform, type Vec3, type WaterBodyProperties, type WaterCutters, type WaterDefinition, type WaterSample,
} from "@babylonslate/core";
import type { Actor, ActorComponent } from "@babylonslate/object-model";
import type { PhysicsBackend } from "@babylonslate/physics";
import { actorParentGuid, actorWorldTransforms, composeParentChildTransform } from "./actor-world-transform";

type WaterBody = { actorId: string; definition: WaterDefinition; body: WaterBodyProperties; transform: Transform };
/** Seconds over which a support's peak submersion settles before it weights horizontal drag (several wave periods). */
const WATER_DRAG_WETNESS_SECONDS = 8;
export type WaterWorldSample = WaterSample & { actorId: string | null; density: number; waterDepth: number };
type Normalized<T> = { kind: string; values: unknown[]; value: T };

/**
 * A component's normalized properties, reused while its variables hold the same values (compared by identity).
 * Scripts and the editor replace variable values, so long-lived objects such as a river's body keep their
 * caches (for example the sampled centreline) across ticks instead of being rebuilt per tick or per query.
 */
function normalized<T>(cache: WeakMap<ActorComponent, Normalized<T>>, component: ActorComponent, kind: string, normalize: () => T): T {
  const entry = cache.get(component), variables = component.variables;
  if (entry && entry.kind === kind && entry.values.length === variables.size * 2) {
    let i = 0, same = true;
    for (const [key, value] of variables) if (entry.values[i++] !== key || entry.values[i++] !== value) { same = false; break; }
    if (same) return entry.value;
  }
  const values: unknown[] = [];
  for (const [key, value] of variables) values.push(key, value);
  const value = normalize();
  cache.set(component, { kind, values, value });
  return value;
}

/** What a refresh read from an actor or component: lifetime, attachment, local transform and (components) variables. */
function readInputs(object: Actor | ActorComponent, out: unknown[]): void {
  const t = object.transform;
  out.push(object.destroyed, t.position.x, t.position.y, t.position.z, t.rotation.x, t.rotation.y, t.rotation.z, t.rotation.w, t.scale.x, t.scale.y, t.scale.z);
  if ("components" in object) { out.push(actorParentGuid(object)); return; }
  out.push(object.owner, object.parentId, object.variables.size);
  for (const [key, value] of object.variables) out.push(key, value);
}

/**
 * The actors and components one refresh depended on (water, removal and landscape components, their parent
 * components and their actors' ancestor chains) and what it read from them, so a later query in the same tick can
 * confirm cheaply that nothing changed instead of rescanning every actor.
 */
class RefreshInputs {
  private readonly objects: Array<Actor | ActorComponent> = [];
  private readonly seen = new Set<Actor | ActorComponent>();
  private readonly values: unknown[] = [];
  private readonly scratch: unknown[] = [];
  private count = 0;

  clear(count: number): void {
    this.objects.length = 0; this.values.length = 0; this.seen.clear(); this.count = count;
  }

  has(object: Actor | ActorComponent): boolean { return this.seen.has(object); }

  record(object: Actor | ActorComponent): void {
    if (this.seen.has(object)) return;
    this.seen.add(object); this.objects.push(object);
    readInputs(object, this.values);
  }

  unchanged(count: number): boolean {
    if (count !== this.count) return false;
    const now = this.scratch;
    now.length = 0;
    for (const object of this.objects) readInputs(object, now);
    if (now.length !== this.values.length) return false;
    for (let i = 0; i < now.length; i++) if (now[i] !== this.values[i]) return false;
    return true;
  }
}

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
  private readonly normalizedBodies = new WeakMap<ActorComponent, Normalized<WaterBodyProperties>>();
  private readonly normalizedRemovals = new WeakMap<ActorComponent, Normalized<ReturnType<typeof normalizeWaterRemoval>>>();
  private transforms = new Map<string, Transform>();
  private time = 0;
  /** Simulation time and actor list of the last refresh, and what it read; `sync` reuses it within a tick. */
  private refreshed: { time: number; actors: readonly Actor[] } | null = null;
  private readonly inputs = new RefreshInputs();
  private readonly defaultWater = createDefaultWaterDefinition();
  /** The body that produced the last `sample` result (null when nothing was found). */
  private sampled: WaterBody | null = null;
  private readonly fixedDrift = { x: 0, z: 0 };
  private readonly coupledDrift = { x: 0, z: 0 };
  /** Per buoyancy component: each support's recent peak submersion, which weights its horizontal drag. */
  private readonly wetness = new WeakMap<ActorComponent, Float64Array>();
  get hasBodies(): boolean { return this.bodies.length > 0; }

  setContent(content: ReadonlyMap<string, WaterDefinition> | Readonly<Record<string, WaterDefinition>>): void {
    const entries = content instanceof Map ? content.entries() : Object.entries(content);
    this.definitions = new Map(Array.from(entries, ([id, value]) => [id, normalizeWaterDefinition(value)]));
    this.refreshed = null;
  }

  /**
   * Script queries: within one simulation tick, Sample Water Surface calls reuse the last refresh unless something
   * it read changed (a water, removal or landscape component's variables or transform, an owning actor's
   * transform or parent, or the number of actors), so repeated queries never rescan or re-normalize. A water
   * component added to an existing actor mid-tick appears from the next tick.
   */
  sync(actors: readonly Actor[], time: number): void {
    if (this.refreshed?.time === time && this.refreshed.actors === actors && this.inputs.unchanged(actors.length)) return;
    this.update(actors, time);
  }

  /** Refresh bodies, transforms and cutters now. Unchanged components keep their normalized properties. */
  update(actors: readonly Actor[], time: number): void {
    this.time = time;
    this.refreshed = { time, actors };
    this.inputs.clear(actors.length);
    let transforms: Map<string, Transform> | undefined, byGuid: Map<string, Actor> | undefined;
    const record = (component: ActorComponent, actor: Actor) => {
      this.inputs.record(component);
      for (let parentId = component.parentId; parentId;) {
        const parent = actor.components.find((c) => c.guid === parentId);
        if (!parent || this.inputs.has(parent)) break;
        this.inputs.record(parent); parentId = parent.parentId;
      }
      for (let owner: Actor | undefined = actor; owner && !this.inputs.has(owner);) {
        this.inputs.record(owner);
        const parentId = actorParentGuid(owner);
        // Only attached actors need the index, so unparented water adds no per-tick map.
        owner = parentId ? (byGuid ??= new Map(actors.map((entry) => [entry.guid, entry]))).get(parentId) : undefined;
      }
    };
    this.bodies = [];
    const removals: Array<WaterCutters["removals"][number]> = [], landscapes: Array<WaterCutters["landscapes"][number]> = [];
    for (const actor of actors) {
      if (actor.destroyed || actor.sceneLayerId) continue;
      for (const component of actor.components) {
        if (component.destroyed) continue;
        if (component.classId === "WaterRemovalVolumeComponent" || component.classId === "LandscapeComponent") {
          record(component, actor);
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
            const volume = normalized(this.normalizedRemovals, component, "removal", () => normalizeWaterRemoval(Object.fromEntries(component.variables)));
            if (volume.enabled) removals.push({ volume, transform });
          }
          continue;
        }
        const kind = waterKindForClass(component.classId);
        if (!kind || component.destroyed) continue;
        record(component, actor);
        const body = normalized(this.normalizedBodies, component, kind, () => normalizeWaterBody(Object.fromEntries(component.variables), kind));
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
    this.sampled = null;
    for (const water of this.bodies) {
      if (actorId && water.actorId !== actorId) continue;
      const sample = sampleWaterSurface(water.definition, water.body, position, this.time, water.transform);
      // Removal volumes and terrain above the surface take the water away, for queries and buoyancy alike.
      if (sample.found && waterCutAt(this.cutters, { x: position.x, y: sample.height, z: position.z })) continue;
      if (sample.found && (!result.found || sample.height > result.height)) {
        result = { ...sample, actorId: water.actorId, density: water.definition.density, waterDepth: water.body.depth * Math.abs(water.transform.scale.y) };
        this.sampled = water;
      }
    }
    return result;
  }

  /**
   * Lift and point drag add to native collision impulses; authored poses are never overwritten. Drag pulls each
   * support toward the water's horizontal velocity (current plus the waves' orbital motion, so hulls sway with the
   * swell); the vertical spring follows the surface's height rate at the support's X/Z. The waves' mean-drift
   * correction is re-weighted for the hull's drag coupling (`waterSurfaceDrift`), so hulls with any drag rock in
   * place and only the current carries them.
   */
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
    const wetted: Array<{ point: Vec3; sample: WaterWorldSample; water: WaterBody; submerged: number; index: number }> = [];
    let wetness = this.wetness.get(component);
    const fresh = !wetness;
    wetness ??= new Float64Array(4);
    this.wetness.set(component, wetness);
    let index = -1;
    for (const x of [-0.5, 0.5]) for (const z of [-0.5, 0.5]) {
      index++;
      const offset = quatRotateVector(transform.rotation, {
        x: (props.offset[0] + x * props.width) * transform.scale.x,
        y: props.offset[1] * transform.scale.y,
        z: (props.offset[2] + z * props.length) * transform.scale.z,
      });
      const point = { x: transform.position.x + offset.x, y: transform.position.y + offset.y, z: transform.position.z + offset.z };
      const sample = this.sample(point, props.waterActorId);
      const found = sample.found && this.sampled !== null && sample.depth <= sample.waterDepth + height / 2;
      const submerged = found ? Math.max(0, Math.min(sample.waterDepth, sample.depth + height / 2) - Math.max(0, sample.depth - height / 2)) / height : 0;
      // Horizontal drag follows each support's recent peak submersion, which rises at once and settles over a few
      // wave periods: the instantaneous value would correlate with the orbital velocity and push hulls along the waves.
      const previous = wetness[index]!;
      wetness[index] = fresh ? submerged : Math.max(submerged, previous + (submerged - previous) * Math.min(1, dt / WATER_DRAG_WETNESS_SECONDS));
      if (submerged > 0) wetted.push({ point, sample, water: this.sampled!, submerged, index });
    }
    // The hull relaxes toward the water's horizontal velocity at this rate (1/s): each wetted support pulls with
    // min(1, drag·dt)·wetness / 4 of the body's momentum per step.
    const coupling = wetted.reduce((sum, entry) => sum + wetness[entry.index]!, 0) * Math.min(1, props.drag * dt) / (4 * dt);
    for (const { point, sample, water, submerged, index } of wetted) {
      const fixed = waterSurfaceDrift(water.definition, water.body, sample.edgeDistance, this.fixedDrift);
      const coupled = waterSurfaceDrift(water.definition, water.body, sample.edgeDistance, this.coupledDrift, coupling);
      sample.velocity.x += coupled.x - fixed.x; sample.velocity.z += coupled.z - fixed.z;
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
      const sideways = mass * Math.min(1, props.drag * dt) * wetness[index]! / 4;
      backend.addImpulseAtPoint(bodyId, {
        x: (sample.velocity.x - v.x - spin * (a.y * r.z - a.z * r.y)) * sideways,
        y: 0,
        z: (sample.velocity.z - v.z - spin * (a.x * r.y - a.y * r.x)) * sideways,
      }, point);
    }
    if (!supports.length) return;
    const afterDrag = backend.getBodyVelocity(bodyId)!;
    // All four springs share the same body's translation and rotation. Solve them
    // together using collider inertia; independent springs can flip a light hull.
    const solve = supports.map(({ r }) => supports.map(({ response }) => ({
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
        const support = supports[i]!, row = solve[i]!;
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
