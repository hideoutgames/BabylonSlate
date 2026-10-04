import { CableSimulation, cablePropertiesEqual, parseCableProperties, DEFAULT_SPRING_ARM_PROPERTIES, SPRING_ARM_LENGTH_LIMITS, type CableProperties, type Transform } from "@babylonslate/core";
import type { CommandMessage } from "@babylonslate/bridge";
import type { Actor, ActorComponent, World } from "@babylonslate/object-model";
import type { PhysicsBackend, SphereSweepQuery, PhysicsTransform } from "@babylonslate/physics";

interface CableHost {
  world: World;
  physics: () => PhysicsBackend;
  eligible: (actor: Actor) => boolean;
  slot: (actor: Actor) => number | undefined;
  emit: (command: CommandMessage) => void;
}

type CableState = {
  id: number;
  component: ActorComponent;
  /** World destruction clears component.owner before the actor's slot retires. */
  owner: Actor | null;
  properties: CableProperties;
  simulation: CableSimulation | null;
  start: [number, number, number];
  end: [number, number, number];
  startLocal: [number, number, number];
  endLocal: [number, number, number];
  startSlot: number;
  endSlot: number;
  sentAnchors: Float64Array;
  dirty: boolean;
  changed: boolean;
  query: SphereSweepQuery | null;
  backend: PhysicsBackend | null;
  collide: (previous: Float32Array, positions: Float32Array, particle: number, radius: number, friction: number) => void;
};

/** Event-registered cables; clean ticks never rescan the World's component lists. */
export class CableWorldSync {
  private readonly states = new Map<ActorComponent, CableState>();
  private sequence = 0;
  private readonly host: CableHost;

  constructor(host: CableHost) {
    this.host = host;
  }

  assign(component: ActorComponent): CableProperties & { simulationId: number } {
    const properties = parseCableProperties(Object.fromEntries(component.variables));
    let state = this.states.get(component);
    if (!state) {
      // Float32 packet headers represent these integers exactly.
      if (this.sequence >= 0xffffff) throw new Error("Cable simulation identity limit exceeded");
      state = {
        id: ++this.sequence, component, owner: component.owner, properties, simulation: null,
        start: [0, 0, 0], end: [0, 0, 0], dirty: true, changed: false,
        startLocal: [0, 0, 0], endLocal: [0, 0, 0], startSlot: -1, endSlot: -1,
        sentAnchors: new Float64Array(8).fill(NaN),
        query: null, backend: null, collide: () => {},
      };
      const owned = state;
      state.collide = (previous, positions, particle, radius, friction) => {
        if (owned.query) collideParticle(owned.query, previous, positions, particle, radius, friction);
      };
      this.states.set(component, state);
    } else {
      state.owner = component.owner ?? state.owner;
      if (!cablePropertiesEqual(state.properties, properties)) {
        if (state.properties.cableWidth !== properties.cableWidth || !properties.enableCollision) {
          state.query?.dispose();
          state.query = null;
        }
        state.properties = properties;
        state.simulation?.configure(properties);
      }
      state.dirty = true; // A replacement visual needs the current shape, even asleep.
    }
    return { ...properties, simulationId: state.id };
  }

  step(dt: number, gravity: readonly number[], frameId: number): void {
    let floats = 0;
    for (const [component, state] of this.states) {
      state.changed = false;
      const actor = component.owner;
      if (component.destroyed || !actor || actor.destroyed || !actor.components.includes(component)) {
        state.query?.dispose();
        this.states.delete(component);
        continue;
      }
      const properties = state.properties;
      if (!properties.enabled || actor.sceneLayerId || !this.host.eligible(actor)) continue;
      if (!worldPoint(this.host.world, actor, component, ZERO, state.start, state.startLocal)) continue;
      const target = properties.targetActorId ? this.host.world.findActor(properties.targetActorId) : actor;
      const liveTarget = target && !target.destroyed && !target.sceneLayerId ? target : actor;
      const targetComponent = properties.targetComponentId
        ? findComponent(liveTarget, properties.targetComponentId)
        : properties.targetActorId ? null : component;
      if (!worldPoint(this.host.world, liveTarget, targetComponent, properties.endPosition, state.end, state.endLocal)) continue;
      state.startSlot = this.host.slot(actor) ?? -1;
      state.endSlot = this.host.slot(liveTarget) ?? -1;
      let anchorsChanged = state.sentAnchors[0] !== state.startSlot || state.sentAnchors[1] !== state.endSlot;
      state.sentAnchors[0] = state.startSlot; state.sentAnchors[1] = state.endSlot;
      for (let axis = 0; axis < 3; axis++) {
        anchorsChanged ||= state.sentAnchors[2 + axis] !== state.startLocal[axis] || state.sentAnchors[5 + axis] !== state.endLocal[axis];
        state.sentAnchors[2 + axis] = state.startLocal[axis]!;
        state.sentAnchors[5 + axis] = state.endLocal[axis]!;
      }
      if (!state.simulation) state.simulation = new CableSimulation(properties, state.start, state.end);
      if (properties.enableCollision) {
        const backend = this.host.physics();
        if (backend !== state.backend) {
          state.query?.dispose();
          state.query = null;
          state.backend = backend;
        }
        state.query ??= backend.createSphereSweep?.(properties.cableWidth / 2) ?? fallbackSweep(backend, properties.cableWidth / 2);
      }
      state.changed = state.simulation.update(dt, state.start, state.end, gravity, state.collide) || state.dirty || anchorsChanged;
      state.dirty = false;
      if (state.changed) floats += 10 + state.simulation.positions.length;
    }
    if (!floats) return;
    // One compact owned packet per tick, not one message/allocation per cable.
    // Native workers transfer this packet; solver storage is never detached.
    const data = new Float32Array(floats);
    let offset = 0;
    for (const state of this.states.values()) {
      if (!state.changed || !state.simulation) continue;
      data[offset++] = state.id;
      data[offset++] = state.simulation.positions.length / 3;
      data[offset++] = state.startSlot;
      data[offset++] = state.endSlot;
      data.set(state.startLocal, offset); offset += 3;
      data.set(state.endLocal, offset); offset += 3;
      data.set(state.simulation.positions, offset);
      offset += state.simulation.positions.length;
    }
    this.host.emit({ type: "cableFrame", frameId, data });
  }

  dispose(): void {
    for (const state of this.states.values()) state.query?.dispose();
    this.states.clear();
  }

  retire(actor: Actor): void {
    for (const [component, state] of this.states) {
      if (state.owner !== actor) continue;
      state.query?.dispose();
      this.states.delete(component);
    }
  }
}

const ZERO = [0, 0, 0] as const;

function findComponent(actor: Actor, id: string): ActorComponent | null {
  for (const component of actor.components) {
    if (!component.destroyed && (component.guid === id || component.sourceId === id)) return component;
  }
  return null;
}

/** Transform a point through actual TRS ancestry without per-tick matrix allocation. */
function worldPoint(world: World, actor: Actor, component: ActorComponent | null, point: readonly number[], out: [number, number, number], local: [number, number, number]): boolean {
  out[0] = point[0]!; out[1] = point[1]!; out[2] = point[2]!;
  let current = component;
  let depth = 0;
  while (current) {
    if (++depth > 128) return false;
    transformPoint(current.transform, out);
    const parentId = current.parentId;
    current = parentId ? findComponent(actor, parentId) : null;
    if (current?.classId === "SpringArmComponent") {
      const length = current.getVariable("armLength");
      out[2] -= typeof length === "number" && Number.isFinite(length)
        ? Math.min(SPRING_ARM_LENGTH_LIMITS[1], Math.max(SPRING_ARM_LENGTH_LIMITS[0], length))
        : DEFAULT_SPRING_ARM_PROPERTIES.armLength;
    }
  }
  local[0] = out[0]; local[1] = out[1]; local[2] = out[2];
  let owner: Actor | undefined = actor;
  while (owner) {
    if (++depth > 256 || owner.destroyed) return false;
    transformPoint(owner.transform, out);
    const parentId = owner.getVariable("parentId");
    owner = typeof parentId === "string" ? world.findActor(parentId) : undefined;
  }
  return Number.isFinite(out[0]) && Number.isFinite(out[1]) && Number.isFinite(out[2]);
}

function transformPoint(transform: Transform, point: [number, number, number]): void {
  const x = point[0] * transform.scale.x, y = point[1] * transform.scale.y, z = point[2] * transform.scale.z;
  const q = transform.rotation;
  const ix = q.w * x + q.y * z - q.z * y;
  const iy = q.w * y + q.z * x - q.x * z;
  const iz = q.w * z + q.x * y - q.y * x;
  const iw = -q.x * x - q.y * y - q.z * z;
  point[0] = transform.position.x + ix * q.w - iw * q.x - iy * q.z + iz * q.y;
  point[1] = transform.position.y + iy * q.w - iw * q.y - iz * q.x + ix * q.z;
  point[2] = transform.position.z + iz * q.w - iw * q.z - ix * q.y + iy * q.x;
}

function fallbackSweep(backend: PhysicsBackend, radius: number): SphereSweepQuery {
  const start: PhysicsTransform = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 } };
  const end: PhysicsTransform = { position: { x: 0, y: 0, z: 0 }, rotation: start.rotation };
  const shape = { kind: "sphere" as const, radius };
  return {
    sweep(sx, sy, sz, ex, ey, ez) {
      start.position.x = sx; start.position.y = sy; start.position.z = sz;
      end.position.x = ex; end.position.y = ey; end.position.z = ez;
      return backend.shapeSweep(shape, start, end);
    },
    dispose() {},
  };
}

function collideParticle(query: SphereSweepQuery, previous: Float32Array, positions: Float32Array, particle: number, radius: number, friction: number): void {
  const i = particle * 3;
  const sx = previous[i]!, sy = previous[i + 1]!, sz = previous[i + 2]!;
  const dx = positions[i]! - sx, dy = positions[i + 1]! - sy, dz = positions[i + 2]! - sz;
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
  const hit = query.sweep(sx, sy, sz, sx + dx, sy + dy, sz + dz);
  if (!hit.hit || !hit.normal) return;
  const normal = hit.normal;
  const length = Math.sqrt(normal.x * normal.x + normal.y * normal.y + normal.z * normal.z);
  if (!(length > 1e-9)) return;
  const nx = normal.x / length, ny = normal.y / length, nz = normal.z / length;
  const fraction = distance > 1e-9 ? Math.max(0, Math.min(1, hit.distance / distance)) : 0;
  const skin = Math.max(1e-4, radius * .01);
  // Contact points are on the obstacle; radius keeps the cable surface clear,
  // including a stationary particle overtaken by a moving collider.
  positions[i] = hit.location ? hit.location.x + nx * (radius + skin) : sx + dx * fraction + nx * skin;
  positions[i + 1] = hit.location ? hit.location.y + ny * (radius + skin) : sy + dy * fraction + ny * skin;
  positions[i + 2] = hit.location ? hit.location.z + nz * (radius + skin) : sz + dz * fraction + nz * skin;
  const inward = Math.min(0, dx * nx + dy * ny + dz * nz);
  previous[i] = positions[i]! - (dx - inward * nx) * (1 - friction);
  previous[i + 1] = positions[i + 1]! - (dy - inward * ny) * (1 - friction);
  previous[i + 2] = positions[i + 2]! - (dz - inward * nz) * (1 - friction);
}
