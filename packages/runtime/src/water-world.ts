import {
  createDefaultWaterDefinition, emptyWaterSample, normalizeWaterBody,
  normalizeWaterBuoyancy, normalizeWaterDefinition, normalizeWaterRemoval, parseLandscapeProperties, quatRotateVector,
  sampleWaterSurface, waterCutAt, waterKindForClass, waterSurfaceDrift,
  type LandscapeProperties, type Transform, type Vec3, type WaterBodyProperties, type WaterCutters, type WaterDefinition, type WaterSample,
} from "@babylonslate/core";
import type { Actor, ActorComponent } from "@babylonslate/object-model";
import type { PhysicsBackend } from "@babylonslate/physics";
import { actorParentGuid, actorWorldTransforms, composeActorWorldTransformsInto, composeParentChildTransform } from "./actor-world-transform";

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

/** One evaluation of the water: enabled surfaces, cutters, their composed poses and clock. */
class WaterState {
  readonly bodies: WaterBody[] = [];
  readonly removals: Array<WaterCutters["removals"][number]> = [];
  readonly landscapes: Array<WaterCutters["landscapes"][number]> = [];
  readonly cutters: WaterCutters = { removals: this.removals, landscapes: this.landscapes };
  transforms = new Map<string, Transform>();
  time = 0;
  /** The body that produced the last `sample` result (null when nothing was found). */
  sampled: WaterBody | null = null;

  sample(position: Vec3, actorId: string | null): WaterWorldSample {
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
  /** Parsed terrain per authored heights array; sculpting replaces the array. */
  private readonly terrain = new WeakMap<object, { size: string; data: LandscapeProperties }>();
  private readonly normalizedBodies = new WeakMap<ActorComponent, Normalized<WaterBodyProperties>>();
  private readonly normalizedRemovals = new WeakMap<ActorComponent, Normalized<ReturnType<typeof normalizeWaterRemoval>>>();
  /**
   * The physics step's evaluation: water sources, cutters and buoyant actors
   * (with ancestors) at the step clock. Buoyancy reads it during the step.
   */
  private readonly stepState = new WaterState();
  /**
   * Script queries evaluate into their own state, so a query between steps
   * never replaces the poses, surfaces or clock the step evaluated.
   */
  private readonly queryState = new WaterState();
  /**
   * The query state's simulation time, actor list and water actor filter, and what its evaluation read: later
   * queries in the same tick reuse it while nothing it read changed (`query`).
   */
  private queriedTime = NaN;
  private queriedActors: readonly Actor[] | null = null;
  private queriedActorId: string | null = null;
  private readonly queryInputs = new RefreshInputs();
  // Per-evaluation scratch: surfaces and cutters awaiting a pose, the actors to compose, and the guid index.
  private readonly sourceActors: Actor[] = [];
  private readonly sourceComponents: ActorComponent[] = [];
  private readonly sourceBodies: Array<WaterBodyProperties | null> = [];
  private readonly composed: Actor[] = [];
  private readonly byGuid = new Map<string, Actor>();
  private readonly defaultWater = createDefaultWaterDefinition();
  private readonly fixedDrift = { x: 0, z: 0 };
  private readonly coupledDrift = { x: 0, z: 0 };
  /** Per buoyancy component: each support's recent peak submersion, which weights its horizontal drag. */
  private readonly wetness = new WeakMap<ActorComponent, Float64Array>();
  get hasBodies(): boolean { return this.stepState.bodies.length > 0; }

  setContent(content: ReadonlyMap<string, WaterDefinition> | Readonly<Record<string, WaterDefinition>>): void {
    const entries = content instanceof Map ? content.entries() : Object.entries(content);
    this.definitions = new Map(Array.from(entries, ([id, value]) => [id, normalizeWaterDefinition(value)]));
    this.queriedActors = null;
  }

  /**
   * The physics step's evaluation. Water, removal volumes, landscapes and
   * buoyant actors compose only their own ancestor chains. Without an enabled
   * water surface nothing can be sampled, so cutters and poses are left empty
   * and no transform is composed. Unchanged components keep their normalized
   * properties.
   */
  update(actors: readonly Actor[], time: number): void {
    this.evaluate(this.stepState, actors, time, true, null, null);
  }

  /**
   * A script query at call time, in its own state: current surfaces, cutters and poses at `time`, without the
   * buoyant actors only the step needs. With `actorId`, only that water actor's surfaces compose. Within one
   * simulation tick, later queries reuse the evaluation unless something it read changed (a water, removal or
   * landscape component's variables or transform, an owning actor's transform or parent, or the number of actors),
   * so repeated queries never rescan or re-normalize; an unfiltered evaluation also serves filtered queries. A water
   * component added to an existing actor mid-tick appears from the next tick. Samples equal the step state's for
   * the same world and time.
   */
  query(actors: readonly Actor[], time: number, position: Vec3, actorId: string | null = null): WaterWorldSample {
    const reusable = this.queriedActors === actors && this.queriedTime === time
      && (this.queriedActorId === null || this.queriedActorId === actorId) && this.queryInputs.unchanged(actors.length);
    if (!reusable) {
      this.evaluate(this.queryState, actors, time, false, actorId, this.queryInputs);
      this.queriedActors = actors; this.queriedTime = time; this.queriedActorId = actorId;
    }
    return this.queryState.sample(position, actorId);
  }

  private evaluate(
    state: WaterState,
    actors: readonly Actor[],
    time: number,
    buoyancy: boolean,
    waterActorId: string | null,
    inputs: RefreshInputs | null,
  ): void {
    state.time = time;
    inputs?.clear(actors.length);
    const { bodies, removals, landscapes } = state;
    const { sourceActors, sourceComponents, sourceBodies, composed } = this;
    bodies.length = removals.length = landscapes.length = 0;
    let water = false;
    for (const actor of actors) {
      const surfaces = !actor.destroyed && !actor.sceneLayerId;
      for (const component of actor.components) {
        if (component.destroyed) continue;
        // Buoyancy reads its actor's pose from the step state during the physics step.
        if (buoyancy && component.classId === "WaterBuoyancyComponent") composed.push(actor);
        if (!surfaces) continue;
        let body: WaterBodyProperties | null = null;
        if (component.classId !== "WaterRemovalVolumeComponent" && component.classId !== "LandscapeComponent") {
          const kind = waterKindForClass(component.classId);
          if (!kind || (waterActorId && actor.guid !== waterActorId)) continue;
          // A disabled surface is read too: enabling it must reach the next query.
          inputs?.record(component);
          body = normalized(this.normalizedBodies, component, kind, () => normalizeWaterBody(Object.fromEntries(component.variables), kind));
          if (!body.enabled) continue;
          water = true;
        }
        sourceActors.push(actor);
        sourceComponents.push(component);
        sourceBodies.push(body);
        composed.push(actor);
      }
    }
    if (water) {
      const transforms = this.composeSources(state, actors);
      for (let index = 0; index < sourceActors.length; index++) {
        const actor = sourceActors[index]!, component = sourceComponents[index]!, body = sourceBodies[index];
        if (inputs) this.recordChain(inputs, component, actor);
        const transform = componentWorldTransform(component, actor, transforms.get(actor.guid)!);
        if (body) {
          const definition = body.assetGuid ? (this.definitions.get(body.assetGuid) ?? this.defaultWater) : this.defaultWater;
          bodies.push({ actorId: actor.guid, definition, body, transform });
        } else if (component.classId === "LandscapeComponent") {
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
      }
    } else {
      state.transforms.clear();
    }
    sourceActors.length = sourceComponents.length = sourceBodies.length = composed.length = 0;
    this.byGuid.clear();
  }

  /**
   * Records what a source's pose read: the component, its parent components and its actor's ancestor chain (looked
   * up in the guid index `composeSources` filled), so `query` can confirm cheaply that none of them changed.
   */
  private recordChain(inputs: RefreshInputs, component: ActorComponent, actor: Actor): void {
    inputs.record(component);
    for (let parentId = component.parentId; parentId;) {
      const parent = actor.components.find((c) => c.guid === parentId);
      if (!parent || inputs.has(parent)) break;
      inputs.record(parent); parentId = parent.parentId;
    }
    for (let owner: Actor | undefined = actor; owner && !inputs.has(owner);) {
      inputs.record(owner);
      const parentId = actorParentGuid(owner);
      owner = parentId ? this.byGuid.get(parentId) : undefined;
    }
  }

  /** Compose the selected sources; a parent cycle falls back to the whole-world pass. */
  private composeSources(state: WaterState, actors: readonly Actor[]): Map<string, Transform> {
    const byGuid = this.byGuid;
    byGuid.clear();
    for (const actor of actors) byGuid.set(actor.guid, actor);
    const transforms = state.transforms;
    transforms.clear();
    // A parent cycle makes poses depend on world order.
    if (!composeActorWorldTransformsInto((guid) => byGuid.get(guid), this.composed, transforms)) return transforms;
    state.transforms = actorWorldTransforms(actors);
    return state.transforms;
  }

  /** Sample the physics step's evaluation (the last `update`). */
  sample(position: Vec3, actorId: string | null = null): WaterWorldSample {
    return this.stepState.sample(position, actorId);
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
    const actorTransform = this.stepState.transforms.get(actor.guid);
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
      const sample = this.stepState.sample(point, props.waterActorId);
      const found = sample.found && this.stepState.sampled !== null && sample.depth <= sample.waterDepth + height / 2;
      const submerged = found ? Math.max(0, Math.min(sample.waterDepth, sample.depth + height / 2) - Math.max(0, sample.depth - height / 2)) / height : 0;
      // Horizontal drag follows each support's recent peak submersion, which rises at once and settles over a few
      // wave periods: the instantaneous value would correlate with the orbital velocity and push hulls along the waves.
      const previous = wetness[index]!;
      wetness[index] = fresh ? submerged : Math.max(submerged, previous + (submerged - previous) * Math.min(1, dt / WATER_DRAG_WETNESS_SECONDS));
      if (submerged > 0) wetted.push({ point, sample, water: this.stepState.sampled!, submerged, index });
    }
    // The hull relaxes toward the water's horizontal velocity at this rate (1/s): each wetted support pulls with
    // min(1, drag·dt)·wetness / 4 of the body's momentum per step.
    const coupling = wetted.reduce((sum, entry) => sum + wetness[entry.index]!, 0) * Math.min(1, props.drag * dt) / (4 * dt);
    for (const { point, sample, water, submerged, index } of wetted) {
      const fixed = waterSurfaceDrift(water.definition, water.body, sample.edgeDistance, this.fixedDrift, 0, point.x, point.z);
      const coupled = waterSurfaceDrift(water.definition, water.body, sample.edgeDistance, this.coupledDrift, coupling, point.x, point.z);
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
