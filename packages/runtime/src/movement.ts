import type { MovementProperties } from "@haptic/core";
import type { Actor, ActorComponent, World } from "@haptic/object-model";
import type { Vec3 } from "@haptic/physics";
import { actorChainWorldTransform, rotateVector } from "./actor-world-transform";
import { parsedMovementProperties } from "./movement-settings";
import type { PhysicsWorldSync } from "./physics-sync";

type MovementState = {
  input: Vec3;
  addedInput: Vec3;
  velocity: Vec3;
  grounded: boolean;
  moving: boolean;
  sinceGround: number;
  jumpRemaining: number;
  jumpRequested: boolean;
  /** A script wrote `velocity` since the last step; a steered Rigid Body takes it instead of its own. */
  velocityWritten: boolean;
  unavailable: boolean;
  placement: Placement;
};

/** The Movement components listed ahead of one in its actor's component list, as of one structural revision. */
type Placement = { actor: Actor | null; revision: number; listed: boolean; ahead: readonly ActorComponent[] };

const NO_MOTORS: readonly ActorComponent[] = [];

interface MovementHost {
  world: World;
  /** Null for a Scene Layer without physics (Movement is world-only). */
  physics(actor: Actor): PhysicsWorldSync | null;
  eligible(actor: Actor): boolean;
  gravity(actor: Actor): number;
  event(component: ActorComponent, name: string, args: Record<string, unknown>): void;
  warn(component: ActorComponent): void;
}

/** Speed along the ground normal above which a steered body is leaving the ground, not resting on it. */
const LEAVING_GROUND_SPEED = 0.5;

const zero = (): Vec3 => ({ x: 0, y: 0, z: 0 });
const finite = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? Math.max(-1e6, Math.min(1e6, value)) : 0;
function vector(value: unknown): Vec3 {
  const v = value as Partial<Vec3> | null;
  return { x: finite(v?.x), y: finite(v?.y), z: finite(v?.z) };
}

/** Whether one of `entries` still counts as a motor of `actor`: not destroyed, and still owned by it. */
function anyLive(entries: readonly ActorComponent[], actor: Actor): boolean {
  for (const entry of entries) if (!entry.destroyed && entry.owner === actor) return true;
  return false;
}

function publishValue(component: ActorComponent, name: string, value: number | boolean): void {
  if (!Object.is(component.getVariable(name), value)) component.setVariable(name, value);
}

/** Fixed-tick intent, velocity and transitions; physics owns collision resolution. */
export class MovementWorldSync {
  private readonly states = new Map<ActorComponent, MovementState>();
  /** Each motor's settings, re-parsed only when one of its variables is written; physics collider sync reads the same parse. */
  private readonly settings = parsedMovementProperties;
  private readonly host: MovementHost;
  private scripted = false;

  constructor(host: MovementHost) { this.host = host; }

  initialize(component: ActorComponent): void {
    if (component.classId === "MovementComponent") this.state(component);
  }

  dispose(): void { this.states.clear(); }

  private state(component: ActorComponent): MovementState {
    let state = this.states.get(component);
    if (!state) {
      state = { input: zero(), addedInput: zero(), velocity: zero(), grounded: false,
        moving: false, sinceGround: Infinity, jumpRemaining: 0, jumpRequested: false, velocityWritten: false, unavailable: false,
        placement: { actor: null, revision: -1, listed: false, ahead: NO_MOTORS } };
      this.states.set(component, state);
      this.publish(component, state);
    }
    return state;
  }

  invoke(component: ActorComponent, name: string, args: Record<string, unknown>): Record<string, unknown> {
    const actor = component.owner;
    if (!actor || component.destroyed || actor.destroyed || !actor.components.includes(component) || !this.host.eligible(actor)) return {};
    if (name === "convertMovementInput") {
      const props = this.settings.get(component);
      return { direction: this.convert(actor, props, args.input, finite(args.yaw)) };
    }
    if (component.getVariable("enabled") === false) return {};
    const state = this.state(component);
    switch (name) {
      case "setMovementInput": state.input = vector(args.direction); break;
      case "addMovementInput": {
        const v = vector(args.direction);
        state.addedInput.x += v.x; state.addedInput.z += v.z;
        break;
      }
      case "setMovementVelocity":
        state.velocity = vector(args.velocity);
        state.velocityWritten = true;
        break;
      case "addMovementVelocity": {
        const v = vector(args.velocity);
        state.velocity.x += v.x; state.velocity.y += v.y; state.velocity.z += v.z;
        state.velocityWritten = true;
        break;
      }
      case "jumpMovement":
        state.jumpRequested = true;
        state.jumpRemaining = this.settings.get(component).jumpBufferTime;
        break;
      case "stopMovementImmediately":
        state.input = zero(); state.addedInput = zero(); state.velocity = zero();
        state.jumpRequested = false; state.jumpRemaining = 0;
        state.velocityWritten = true;
        break;
    }
    this.publish(component, state);
    return {};
  }

  /**
   * Add Impulse on an actor whose Movement is moved by its character controller:
   * the velocity changes by impulse / mass (1, or the kinematic Rigid Body's
   * Mass), and the controller then carries it with collision and its own
   * gravity. False when a physics body takes the impulse instead.
   */
  addImpulse(actor: Actor, impulse: Vec3, strength = 1): boolean {
    const drive = this.host.physics(actor)?.movementDrive(actor);
    if (!drive || drive.dynamic) return false;
    const scale = finite(strength) / drive.mass;
    const v = vector(impulse);
    this.invoke(drive.component, "addMovementVelocity", { velocity: { x: v.x * scale, y: v.y * scale, z: v.z * scale } });
    return true;
  }

  private convert(actor: Actor, props: MovementProperties, value: unknown, yaw: number): Vec3 {
    const v = typeof value === "number" ? { x: finite(value), y: 0 } : vector(value);
    if (this.host.physics(actor)?.getBackend().kind === "2d") {
      const magnitude = Math.abs(v.x);
      return { x: magnitude <= props.deadZone ? 0 : Math.sign(v.x) * Math.min(1, (magnitude - props.deadZone) / (1 - props.deadZone) * props.inputScale), y: 0, z: 0 };
    }
    const magnitude = Math.hypot(v.x, v.y);
    if (magnitude <= props.deadZone) return zero();
    const strength = Math.min(1, (magnitude - props.deadZone) / (1 - props.deadZone) * props.inputScale);
    let heading = (props.inputYaw + yaw) % 360 * Math.PI / 180;
    if (props.inputSpace === "actor") {
      // Resolve only this ancestry, using the world's existing ID index.
      const pose = actorChainWorldTransform(actor, (guid) => this.host.world.findActor(guid));
      if (pose) {
        const forward = rotateVector(pose.rotation, { x: 0, y: 0, z: 1 });
        heading += Math.atan2(forward.x, forward.z);
      }
    }
    const x = v.x / magnitude * strength, z = v.y / magnitude * strength;
    return { x: x * Math.cos(heading) + z * Math.sin(heading), y: 0, z: z * Math.cos(heading) - x * Math.sin(heading) };
  }

  /**
   * Returns true when a component event ran scripts during this step. Without
   * one, motors changed only their own actors' poses through `moveMovement`.
   */
  step(dt: number, physics: PhysicsWorldSync): boolean {
    this.scripted = false;
    if (!(dt > 0) || !Number.isFinite(dt)) return false;
    // Creation hooks register motors, so scenes without Movement pay no actor scan.
    for (const [component, state] of this.states) {
      const actor = component.owner;
      if (component.destroyed || !actor || actor.destroyed || actor.world !== this.host.world || !this.place(actor, component, state.placement).listed) {
        this.states.delete(component);
        continue;
      }
      if (this.host.physics(actor) !== physics || !this.host.eligible(actor)) continue;
      // Keep later registrations available if the first motor is removed.
      // Physics rejects duplicates; only one motor may attempt to move the actor.
      if (component.classId !== "MovementComponent" || anyLive(state.placement.ahead, actor)) continue;
      const props = this.settings.get(component);
      if (!props.enabled) {
        state.input = zero(); state.addedInput = zero(); state.velocity = zero();
        state.jumpRequested = false; state.jumpRemaining = 0;
        this.transitions(component, state, state.grounded, false);
        continue;
      }
      this.advance(actor, component, state, props, dt);
    }
    return this.scripted;
  }

  /**
   * Where `component` sits in `actor`'s component list. Which components the list
   * holds, and in what order, changes only with the world structure (attach,
   * destroy; code that edits `actor.components` in place must call
   * `world.markStructureChanged()`), so one scan serves every tick until the next
   * structural change. Entries after the component cannot outrank it. Whether an
   * entry is live is no part of the cache: `destroyed` and `owner` change without
   * a structural change, so each tick reads them.
   */
  private place(actor: Actor, component: ActorComponent, placement: Placement): Placement {
    const revision = this.host.world.structuralRevision;
    if (placement.actor === actor && placement.revision === revision) return placement;
    let ahead: ActorComponent[] | undefined;
    let listed = false;
    for (const entry of actor.components) {
      if (entry === component) { listed = true; break; }
      if (entry.classId === "MovementComponent") (ahead ??= []).push(entry);
    }
    placement.actor = actor;
    placement.revision = revision;
    placement.listed = listed;
    placement.ahead = ahead ?? NO_MOTORS;
    return placement;
  }

  private advance(actor: Actor, component: ActorComponent, state: MovementState, props: MovementProperties, dt: number): void {
    const physics = this.host.physics(actor);
    if (!physics) return;
    if (physics.movementDrive(actor)?.dynamic) { this.advanceBody(actor, component, state, props, dt, physics); return; }
    const is2D = physics.getBackend().kind === "2d";
    state.velocityWritten = false;
    this.steer(state, state.velocity, props, is2D, state.grounded, dt);

    let jumped = false;
    if (state.jumpRequested && (state.grounded || state.sinceGround <= props.coyoteTime) && props.jumpSpeed > 0) {
      state.velocity.y = props.jumpSpeed;
      state.jumpRequested = false; state.jumpRemaining = 0; state.sinceGround = Infinity;
      jumped = true;
    }
    const rising = state.velocity.y > 0;
    if (state.grounded && !rising) state.velocity.y = 0;
    state.velocity.y = Math.max(-props.maxFallSpeed, state.velocity.y - Math.max(0, this.host.gravity(actor)) * props.gravityScale * dt);
    const translation = { x: state.velocity.x * dt, y: state.velocity.y * dt, z: state.velocity.z * dt };
    const moved = physics.moveMovement(actor, translation, dt, props);
    if (!moved) { this.unavailable(component, state); return; }
    state.unavailable = false;
    state.velocity = { ...moved.velocity };
    const grounded = moved.grounded && !rising;
    if (grounded) { state.velocity.y = 0; state.sinceGround = 0; }
    else state.sinceGround += dt;
    if (state.jumpRequested) {
      state.jumpRemaining -= dt;
      if (state.jumpRemaining < 0) state.jumpRequested = false;
    }
    const moving = Math.hypot(state.velocity.x, state.velocity.z) > 0.01;
    this.transitions(component, state, grounded, moving, jumped);
  }

  /**
   * A dynamic Rigid Body: steers its horizontal velocity toward the input and
   * adds the jump, and leaves gravity, damping, collisions and impulses to
   * physics. The published velocity and ground are what the last step left.
   */
  private advanceBody(actor: Actor, component: ActorComponent, state: MovementState, props: MovementProperties, dt: number, physics: PhysicsWorldSync): void {
    const body = physics.movementBody(actor, props);
    if (!body) { this.unavailable(component, state); return; }
    state.unavailable = false;
    const is2D = physics.getBackend().kind === "2d";
    // A velocity a script wrote since the last step stands in for the body's.
    const written = state.velocityWritten;
    state.velocityWritten = false;
    if (!written) state.velocity = body.velocity;
    if (is2D) state.velocity.z = 0;
    const read = { ...state.velocity };
    const { ground } = body;
    let supported = ground !== null && read.x * ground.x + read.y * ground.y + read.z * ground.z <= LEAVING_GROUND_SPEED;
    const target = { ...read };
    this.steer(state, target, props, is2D, supported, dt);

    let jumped = false, vertical = written;
    if (state.jumpRequested && (supported || state.sinceGround <= props.coyoteTime) && props.jumpSpeed > 0) {
      target.y = Math.max(target.y, 0) + props.jumpSpeed;
      state.jumpRequested = false; state.jumpRemaining = 0; state.sinceGround = Infinity;
      jumped = vertical = true; supported = false;
      state.velocity.y = target.y;
    }
    if (target.y < -props.maxFallSpeed) { target.y = -props.maxFallSpeed; vertical = true; }
    // Unchanged velocity is not written, so a resting body can sleep.
    if (vertical || target.x !== read.x || target.z !== read.z)
      physics.setActorLinearVelocity(actor.guid, vertical ? target : { x: target.x, z: target.z });
    if (supported) state.sinceGround = 0;
    else state.sinceGround += dt;
    if (state.jumpRequested) {
      state.jumpRemaining -= dt;
      if (state.jumpRemaining < 0) state.jumpRequested = false;
    }
    const moving = Math.hypot(state.velocity.x, state.velocity.z) > 0.01;
    this.transitions(component, state, supported, moving, jumped);
  }

  /** Moves the horizontal part of `velocity` toward the input: Acceleration with input, Braking without, scaled by Air Control off the ground. */
  private steer(state: MovementState, velocity: Vec3, props: MovementProperties, is2D: boolean, grounded: boolean, dt: number): void {
    let x = state.input.x + state.addedInput.x;
    let z = is2D ? 0 : state.input.z + state.addedInput.z;
    state.addedInput = zero();
    const strength = Math.hypot(x, z);
    if (strength > 1) { x /= strength; z /= strength; }
    const hasInput = strength > 1e-6;
    const deltaX = x * props.maxSpeed - velocity.x;
    const deltaZ = z * props.maxSpeed - velocity.z;
    const distance = Math.hypot(deltaX, deltaZ);
    const rate = (hasInput ? props.acceleration : props.braking) * (grounded ? 1 : props.airControl);
    const factor = distance > 0 ? Math.min(1, rate * dt / distance) : 0;
    velocity.x += deltaX * factor;
    velocity.z = is2D ? 0 : velocity.z + deltaZ * factor;
  }

  /** Movement cannot move this actor (another motion owner, or no body): warns once and stands still. */
  private unavailable(component: ActorComponent, state: MovementState): void {
    if (!state.unavailable) this.host.warn(component);
    state.unavailable = true;
    state.velocity = zero(); state.sinceGround = Infinity;
    state.jumpRequested = false; state.jumpRemaining = 0;
    this.transitions(component, state, false, false);
  }

  /**
   * Writes only values that differ from the live variable: other writers may have
   * changed it since, and readers retain the published velocity object, so it is
   * replaced rather than mutated. None of these names is a movement setting, so
   * publishing keeps the parsed settings current.
   */
  private publish(component: ActorComponent, state: MovementState): void {
    this.settings.writeUnparsed(component, () => {
      const live = component.getVariable("velocity") as Partial<Vec3> | null | undefined;
      const v = state.velocity;
      if (typeof live !== "object" || live === null || !Object.is(live.x, v.x) || !Object.is(live.y, v.y) || !Object.is(live.z, v.z)) {
        component.setVariable("velocity", { ...v });
      }
      publishValue(component, "speed", Math.hypot(v.x, v.z));
      publishValue(component, "isGrounded", state.grounded);
      publishValue(component, "isInAir", !state.grounded);
      publishValue(component, "isMoving", state.moving);
    });
  }

  private transitions(component: ActorComponent, state: MovementState, grounded: boolean, moving: boolean, jumped = false): void {
    const wasGrounded = state.grounded, wasMoving = state.moving;
    state.grounded = grounded; state.moving = moving;
    this.publish(component, state);
    const events: string[] = [];
    if (jumped) events.push("onMovementJumped");
    if (wasGrounded !== grounded) events.push(grounded ? "onMovementLanded" : "onMovementLeftGround");
    if (wasMoving !== moving) events.push(moving ? "onMovementStarted" : "onMovementStopped");
    for (const event of events) {
      if (component.destroyed || !component.owner || component.owner.destroyed || !this.host.eligible(component.owner)) break;
      this.scripted = true;
      this.host.event(component, event, { velocity: { ...state.velocity }, speed: Math.hypot(state.velocity.x, state.velocity.z) });
    }
  }
}
