import {
  createDefaultWaterDefinition, DEFAULT_WATER_BLEND_DISTANCE, emptyWaterSample, normalizeWaterBlendDistance, normalizeWaterBody,
  normalizeWaterBuoyancy, normalizeWaterDefinition, normalizeWaterRemoval, parseLandscapeProperties, quatRotateVector,
  sampleWaterBlend, sampleWaterSurface, WaterBlendIndex, waterBankFadeLength, waterBankGain, waterCutAt, waterKindForClass, waterSpectrum,
  waterSpectrumDrift,
  waterSurfaceFrame,
  type LandscapeProperties, type Transform, type Vec3, type WaterBodyProperties, type WaterCutters,
  type WaterDefinition, type WaterSample, type WaterSurfaceFrame,
} from "@haptic/core";
import type { Actor, ActorComponent, World } from "@haptic/object-model";
import type { PhysicsBackend } from "@haptic/physics";
import { actorParentGuid, actorWorldTransforms, composeActorWorldTransformsInto, composeParentChildTransform } from "./actor-world-transform";
import { worldComponentIndex, type WorldComponentIndex } from "./world-component-index";

/**
 * `frame` is derived from `transform` on the first sample. A body lives for one evaluation and its transform is a
 * snapshot taken then, so every sample of that evaluation shares it however the actors move in between.
 */
type WaterBody = { actorId: string; definition: WaterDefinition; body: WaterBodyProperties; transform: Transform; frame?: WaterSurfaceFrame };
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
  /**
   * Which bodies blend with which (`WaterBlendIndex`): `evaluate` hands it this state's bodies every time, and it
   * rebuilds only when a body, its pose or the Water Blend Distance changed.
   */
  readonly blend = new WaterBlendIndex();
  /** The body that produced the last `sample` result (null when nothing was found). */
  sampled: WaterBody | null = null;
  private readonly surfacePoint: Vec3 = { x: 0, y: 0, z: 0 };

  /**
   * The highest surface over `position`. Blending bodies answer with the blended surface, and only the body owning the
   * point does, so a seam has one surface; a query filtered to one water actor reads that actor's blended surface.
   */
  sample(position: Vec3, actorId: string | null): WaterWorldSample {
    let result: WaterWorldSample = { ...emptyWaterSample(), actorId: null, density: 0, waterDepth: 0 };
    this.sampled = null;
    for (let index = 0; index < this.bodies.length; index++) {
      const water = this.bodies[index]!;
      if (actorId && water.actorId !== actorId) continue;
      const sample = this.blend.neighbours(index).length
        ? sampleWaterBlend(this.blend, index, position, this.time, !actorId)
        : sampleWaterSurface(water.definition, water.body, position, this.time, water.transform, water.frame ??= waterSurfaceFrame(water.transform));
      // Removal volumes and terrain above the surface take the water away, for queries and buoyancy alike.
      if (sample.found) {
        const surface = this.surfacePoint;
        surface.x = position.x; surface.y = sample.height; surface.z = position.z;
        if (waterCutAt(this.cutters, surface)) continue;
      }
      if (sample.found && (!result.found || sample.height > result.height)) {
        result = { ...sample, actorId: water.actorId, density: water.definition.density, waterDepth: water.body.depth * Math.abs(water.transform.scale.y) };
        this.sampled = water;
      }
    }
    return result;
  }
}

/**
 * The session's simulated water time: it advances by each tick's captured (dilated) step, so waves, drift,
 * buoyancy and script queries slow down with time dilation and stop while paused. Advanced once per World tick,
 * alongside the World clock, whether or not the main Scene steps. A run of ticks with the same step is computed as
 * `start + ticks × step`, so an undilated session reproduces the former `tickIndex × dt` clock exactly.
 */
export class WaterClock {
  /** Water time at the start of the current tick: the physics step (and buoyancy) evaluates the water here. */
  stepTime = 0;
  /** Water time including the current tick (after it, between ticks): script queries sample here. */
  time = 0;
  private start = 0;
  private ticks = 0;
  private step = NaN;

  advance(step: number): void {
    this.stepTime = this.time;
    if (step !== this.step) { this.start = this.time; this.ticks = 0; this.step = step; }
    this.time = this.start + ++this.ticks * step;
  }
}

/** The component classes an evaluation reacts to: water surfaces, removal volumes, landscapes and buoyancy. */
function reactsToClass(classId: string): boolean {
  return waterKindForClass(classId) !== null || classId === "WaterRemovalVolumeComponent" ||
    classId === "LandscapeComponent" || classId === "WaterBuoyancyComponent";
}

/** Component attachments have the same transform meaning in physics and rendering. */
function componentWorldTransform(component: ActorComponent, actor: Actor, world: Transform): Transform {
  // An unattached component composes once, as the chain below would.
  if (!component.parentId) return composeParentChildTransform(world, component.transform);
  const chain = [component.transform];
  const seen = new Set([component.guid]);
  let parentId: string | null = component.parentId;
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

/** The world up axis a support's vertical impulse response is measured along. */
const UP: Readonly<Vec3> = Object.freeze({ x: 0, y: 1, z: 0 });

/**
 * Fixed storage for one buoyancy solve: a body has at most four supports, so the solve rows (4×4) and every
 * per-support value live in typed arrays instead of per-step objects.
 */
class BuoyancySupports {
  /** Each corner's world point, in corner order. */
  readonly points: Vec3[] = Array.from({ length: 4 }, () => ({ x: 0, y: 0, z: 0 }));
  /** Per support (a submerged corner, in corner order): its corner, sample and water body. */
  readonly corner = new Int8Array(4);
  readonly samples: Array<WaterWorldSample | null> = [null, null, null, null];
  readonly waters: Array<WaterBody | null> = [null, null, null, null];
  readonly submerged = new Float64Array(4);
  readonly rx = new Float64Array(4);
  readonly rz = new Float64Array(4);
  readonly drag = new Float64Array(4);
  readonly stiffness = new Float64Array(4);
  readonly maximumLift = new Float64Array(4);
  readonly responseLinear = new Float64Array(4);
  readonly responseAngularX = new Float64Array(4);
  readonly responseAngularZ = new Float64Array(4);
  readonly solveLinear = new Float64Array(16);
  readonly solveAngular = new Float64Array(16);
  readonly freeLinear = new Float64Array(4);
  readonly freeAngular = new Float64Array(4);
  readonly impulses = new Float64Array(4);

  /** Drop the samples and water bodies, so the scratch keeps no evaluation alive. */
  release(): void {
    this.samples.fill(null);
    this.waters.fill(null);
  }
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
  /** The world whose own registry answers the current evaluation's guid lookups; null: `byGuid` indexes its actors. */
  private lookupWorld: World | null = null;
  private readonly actorByGuid = (guid: string): Actor | undefined =>
    this.lookupWorld ? this.lookupWorld.findActor(guid) : this.byGuid.get(guid);
  private readonly defaultWater = createDefaultWaterDefinition();
  private readonly worldOf: (actors: readonly Actor[]) => World | null;
  /** The world structure last scanned for components water reacts to, and its actors that own one, in world order. */
  private scannedIndex: WorldComponentIndex | null = null;
  private reactiveActors: readonly Actor[] = [];
  /** Per buoyancy component: each support's recent peak submersion, which weights its horizontal drag. */
  private readonly wetness = new WeakMap<ActorComponent, Float64Array>();
  private readonly normalizedBuoyancy = new WeakMap<ActorComponent, Normalized<ReturnType<typeof normalizeWaterBuoyancy>>>();
  /** `applyBuoyancy`'s per-body scratch: never kept past one call, which nothing re-enters. */
  private readonly supports = new BuoyancySupports();
  private readonly bodyPose: Transform = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } };
  private readonly drift = { x: 0, z: 0 };
  private readonly bankGain = new Float64Array(2);
  /** Water Blend Distance (project setting): bodies this close blend, for the step and script queries alike. */
  private blendDistance = DEFAULT_WATER_BLEND_DISTANCE;
  get hasBodies(): boolean { return this.stepState.bodies.length > 0; }
  /** The world structure last scanned for water surface components, and whether it held any. */
  private surfaceIndex: WorldComponentIndex | null = null;
  private surfacesPresent = false;

  /**
   * Whether `world` owns a water surface component, enabled or not. Play draws water at the time the step publishes,
   * also where the step does not evaluate water (a 2D world has no buoyancy). The answer follows the world structure.
   */
  hasSurfaces(world: World): boolean {
    const index = worldComponentIndex(world);
    if (index !== this.surfaceIndex) {
      this.surfaceIndex = index;
      this.surfacesPresent = false;
      for (const classId of index.classIds()) {
        if (waterKindForClass(classId) !== null) { this.surfacesPresent = true; break; }
      }
    }
    return this.surfacesPresent;
  }

  /** `worldOf` names the world whose actor list `actors` is, so evaluations over it can use the world's component index. */
  constructor(worldOf: (actors: readonly Actor[]) => World | null = () => null) {
    this.worldOf = worldOf;
  }

  /** Sets the Water Blend Distance (metres; 0 turns blending off). The next evaluation rediscovers neighbours. */
  setBlendDistance(distance: number): void {
    const next = normalizeWaterBlendDistance(distance);
    if (next === this.blendDistance) return;
    this.blendDistance = next;
    this.queriedActors = null;
  }

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
    // While bodies blend, a filtered query still needs the actor's neighbours: evaluate every surface and filter when sampling.
    const filter = this.blendDistance > 0 ? null : actorId;
    const reusable = this.queriedActors === actors && this.queriedTime === time
      && (this.queriedActorId === null || this.queriedActorId === filter) && this.queryInputs.unchanged(actors.length);
    if (!reusable) {
      this.evaluate(this.queryState, actors, time, false, filter, this.queryInputs);
      this.queriedActors = actors; this.queriedTime = time; this.queriedActorId = filter;
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
    try {
      this.evaluateInto(state, actors, time, buoyancy, waterActorId, inputs);
    } finally {
      // A throwing pass must not leave its actors in the next pass's scratch.
      this.sourceActors.length = this.sourceComponents.length = this.sourceBodies.length = this.composed.length = 0;
      this.byGuid.clear();
      this.lookupWorld = null;
    }
  }

  private evaluateInto(
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
    const world = this.worldOf(actors);
    if (world && !this.hasSurfaces(world)) {
      // No surface, enabled or not, so the walk would find no water to sample: the same empty evaluation, unwalked.
      state.transforms.clear();
      state.blend.update(bodies, this.blendDistance);
      return;
    }
    let water = false;
    for (const actor of world ? this.reactiveActorsOf(world) : actors) {
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
    // A comparison per evaluation; neighbours are rediscovered only when a body, its pose or the distance changed.
    state.blend.update(bodies, this.blendDistance);
  }

  /**
   * The actors of a world's own list that own a component class the walk reacts to, in world order: every other
   * actor would collect nothing. Rebuilt in one pass whenever the world structure changes.
   */
  private reactiveActorsOf(world: World): readonly Actor[] {
    const index = worldComponentIndex(world);
    if (index !== this.scannedIndex) {
      this.scannedIndex = index;
      const reactive: Actor[] = [];
      for (const actor of world.getActors()) {
        for (const component of actor.components) {
          if (reactsToClass(component.classId)) { reactive.push(actor); break; }
        }
      }
      this.reactiveActors = reactive;
    }
    return this.reactiveActors;
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
      owner = parentId ? this.actorByGuid(parentId) : undefined;
    }
  }

  /** Compose the selected sources; a parent cycle falls back to the whole-world pass. */
  private composeSources(state: WaterState, actors: readonly Actor[]): Map<string, Transform> {
    // A world's own actor list is exactly what its guid registry holds (guids are fixed and unique), so the registry
    // answers lookups and no index over every actor is built; any other list is indexed.
    const world = this.lookupWorld = this.worldOf(actors);
    if (!world) {
      this.byGuid.clear();
      for (const actor of actors) this.byGuid.set(actor.guid, actor);
    }
    const transforms = state.transforms;
    transforms.clear();
    // A parent cycle makes poses depend on world order.
    if (!composeActorWorldTransformsInto(this.actorByGuid, this.composed, transforms)) return transforms;
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
   * swell); the vertical spring follows the surface's height rate at the support's X/Z.
   */
  applyBuoyancy(actor: Actor, bodyId: string, backend: PhysicsBackend, mass: number, gravity: number, dt: number): void {
    if (backend.kind !== "3d" || dt <= 0 || mass <= 0) return;
    let component: ActorComponent | undefined;
    for (const candidate of actor.components) {
      if (candidate.classId === "WaterBuoyancyComponent" && !candidate.destroyed && candidate.getVariable("enabled") !== false) { component = candidate; break; }
    }
    if (!component) return;
    const variables = component.variables;
    const props = normalized(this.normalizedBuoyancy, component, "buoyancy", () => normalizeWaterBuoyancy(Object.fromEntries(variables)));
    const actorTransform = this.stepState.transforms.get(actor.guid);
    const pose = backend.getBodyTransform(bodyId), velocity = backend.getBodyVelocity(bodyId);
    if (!actorTransform || !pose || !velocity) return;
    // The actor's scale with the body's pose (as `{ ...actorTransform, ...pose }`); composition only reads it.
    const bodyPose = this.bodyPose;
    bodyPose.position = pose.position; bodyPose.rotation = pose.rotation; bodyPose.scale = actorTransform.scale;
    const transform = componentWorldTransform(component, actor, bodyPose);
    const height = props.height * Math.abs(transform.scale.y);
    if (height < 1e-6) return;
    const s = this.supports;
    let wetness = this.wetness.get(component);
    const fresh = !wetness;
    wetness ??= new Float64Array(4);
    this.wetness.set(component, wetness);
    // The four corner supports; `wetted` lists the submerged ones by corner, and each becomes a support.
    let wetted = 0;
    for (let index = 0; index < 4; index++) {
      const x = index < 2 ? -0.5 : 0.5, z = index % 2 ? 0.5 : -0.5;
      const offset = quatRotateVector(transform.rotation, {
        x: (props.offset[0] + x * props.width) * transform.scale.x,
        y: props.offset[1] * transform.scale.y,
        z: (props.offset[2] + z * props.length) * transform.scale.z,
      });
      const point = s.points[index]!;
      point.x = transform.position.x + offset.x; point.y = transform.position.y + offset.y; point.z = transform.position.z + offset.z;
      const sample = this.stepState.sample(point, props.waterActorId);
      const found = sample.found && this.stepState.sampled !== null && sample.depth <= sample.waterDepth + height / 2;
      const submerged = found ? Math.max(0, Math.min(sample.waterDepth, sample.depth + height / 2) - Math.max(0, sample.depth - height / 2)) / height : 0;
      // Horizontal drag follows each support's recent peak submersion, which rises at once and settles over a few
      // wave periods: the instantaneous value would correlate with the orbital velocity and push hulls along the waves.
      const previous = wetness[index]!;
      wetness[index] = fresh ? submerged : Math.max(submerged, previous + (submerged - previous) * Math.min(1, dt / WATER_DRAG_WETNESS_SECONDS));
      if (submerged > 0) {
        s.corner[wetted] = index; s.samples[wetted] = sample; s.waters[wetted] = this.stepState.sampled!; s.submerged[wetted] = submerged;
        wetted++;
      }
    }
    // The hull relaxes toward the water's horizontal velocity at this rate (1/s): each wetted support pulls with
    // min(1, drag·dt)·wetness / 4 of the body's momentum per step. The waves' mean drift at that coupling
    // (`waterSpectrumDrift`) is added back, so hulls with any drag rock in place and only the current carries them; it
    // fades with the horizontal offset toward a finite body's banks.
    let wetSum = 0;
    for (let n = 0; n < wetted; n++) wetSum = wetSum + wetness[s.corner[n]!]!;
    const coupling = wetSum * Math.min(1, props.drag * dt) / (4 * dt);
    for (let n = 0; n < wetted; n++) {
      const index = s.corner[n]!, point = s.points[index]!, sample = s.samples[n]!, water = s.waters[n]!, submerged = s.submerged[n]!;
      const drift = waterSpectrumDrift(waterSpectrum(water.definition), water.body.waveScale, coupling, this.drift);
      let fade = 1;
      if (water.body.kind !== "global") {
        waterBankGain(sample.edgeDistance, waterBankFadeLength(water.definition, water.body.waveScale), this.bankGain);
        fade = this.bankGain[0]! * this.bankGain[0]!;
      }
      sample.velocity.x += drift.x * fade; sample.velocity.z += drift.z * fade;
      const volume = props.volume > 0 ? props.volume * Math.abs(transform.scale.x * transform.scale.y * transform.scale.z) : 2 * mass / sample.density;
      const response = backend.getBodyImpulseResponse?.(bodyId, UP, point);
      const center = response?.centerOfMass ?? pose.position;
      const rx = point.x - center.x, ry = point.y - center.y, rz = point.z - center.z;
      const a = velocity.angular, v = velocity.linear;
      const drag = mass * Math.min(1, props.drag * dt) * submerged / 4;
      const spin = props.angularDrag;
      const lift = sample.density * volume * Math.max(0, gravity) / 4;
      s.rx[n] = rx; s.rz[n] = rz; s.drag[n] = drag; s.stiffness[n] = lift / height;
      s.maximumLift[n] = lift * Math.min(1, sample.waterDepth / height, (sample.waterDepth - sample.depth + height / 2) / height) * dt;
      // Custom backends without inertia queries retain unit-inertia behavior.
      if (response) {
        s.responseLinear[n] = response.linear.y; s.responseAngularX[n] = response.angular.x; s.responseAngularZ[n] = response.angular.z;
      } else {
        s.responseLinear[n] = 1 / mass; s.responseAngularX[n] = -rz / mass; s.responseAngularZ[n] = rx / mass;
      }
      const sideways = mass * Math.min(1, props.drag * dt) * wetness[index]! / 4;
      backend.addImpulseAtPoint(bodyId, {
        x: (sample.velocity.x - v.x - spin * (a.y * rz - a.z * ry)) * sideways,
        y: 0,
        z: (sample.velocity.z - v.z - spin * (a.x * ry - a.y * rx)) * sideways,
      }, point);
    }
    const count = wetted;
    if (!count) { s.release(); return; }
    const afterDrag = backend.getBodyVelocity(bodyId)!;
    // All four springs share the same body's translation and rotation. Solve them
    // together using collider inertia; independent springs can flip a light hull.
    // Row i, column j: support j's response seen from support i's offset.
    const { solveLinear, solveAngular, freeLinear, freeAngular, impulses } = s;
    for (let i = 0; i < count; i++) {
      for (let j = 0; j < count; j++) {
        solveLinear[i * 4 + j] = s.responseLinear[j]!;
        solveAngular[i * 4 + j] = s.responseAngularZ[j]! * s.rx[i]! - s.responseAngularX[j]! * s.rz[i]!;
      }
      freeLinear[i] = afterDrag.linear.y - s.samples[i]!.velocity.y - Math.max(0, gravity) * dt;
      freeAngular[i] = afterDrag.angular.z * s.rx[i]! - afterDrag.angular.x * s.rz[i]!;
      impulses[i] = 0;
    }
    // Projected Gauss-Seidel for the dry, surface and fully immersed branches.
    // The implicit solve bounds high-stiffness response without capping capacity.
    for (let iteration = 0; iteration < 32; iteration++) {
      let change = 0;
      for (let n = 0; n < count; n++) {
        const i = iteration % 2 ? count - n - 1 : n;
        const row = i * 4;
        let relative = freeLinear[i]! + freeAngular[i]!;
        let dragVelocity = freeLinear[i]! + props.angularDrag * freeAngular[i]!;
        for (let j = 0; j < count; j++) if (j !== i) {
          relative += (solveLinear[row + j]! + solveAngular[row + j]!) * impulses[j]!;
          dragVelocity += (solveLinear[row + j]! + props.angularDrag * solveAngular[row + j]!) * impulses[j]!;
        }
        const supportDrag = s.drag[i]!, stiffness = s.stiffness[i]!;
        const dragFactor = 1 + supportDrag * (solveLinear[row + i]! + props.angularDrag * solveAngular[row + i]!);
        const dragImpulse = -supportDrag * dragVelocity;
        const next = Math.max(dragImpulse / dragFactor, Math.min(
          (s.maximumLift[i]! + dragImpulse) / dragFactor,
          (stiffness * dt * (s.samples[i]!.depth + height / 2 - relative * dt) + dragImpulse)
            / (dragFactor + stiffness * dt * dt * (solveLinear[row + i]! + solveAngular[row + i]!)),
        ));
        change = Math.max(change, Math.abs(next - impulses[i]!));
        impulses[i] = next;
      }
      if (change < mass * 1e-7) break;
    }
    for (let i = 0; i < count; i++) backend.addImpulseAtPoint(bodyId, { x: 0, y: impulses[i]!, z: 0 }, s.points[s.corner[i]!]!);
    s.release();
  }
}
