import { parseMovementProperties, type MovementProperties } from "@babylonslate/core";
import type { Actor, ActorComponent, World } from "@babylonslate/object-model";
import type { Vec3 } from "@babylonslate/physics";
import { actorWorldTransform, rotateVector } from "./actor-world-transform";
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
  unavailable: boolean;
};

interface MovementHost {
  world: World;
  physics(actor: Actor): PhysicsWorldSync;
  eligible(actor: Actor): boolean;
  gravity(actor: Actor): number;
  event(component: ActorComponent, name: string, args: Record<string, unknown>): void;
  warn(component: ActorComponent): void;
}

const zero = (): Vec3 => ({ x: 0, y: 0, z: 0 });
const finite = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? Math.max(-1e6, Math.min(1e6, value)) : 0;
function vector(value: unknown): Vec3 {
  const v = value as Partial<Vec3> | null;
  return { x: finite(v?.x), y: finite(v?.y), z: finite(v?.z) };
}

/** Fixed-tick intent, velocity and transitions; physics owns collision resolution. */
export class MovementWorldSync {
  private readonly states = new Map<ActorComponent, MovementState>();

  constructor(private readonly host: MovementHost) {}

  initialize(component: ActorComponent): void {
    if (component.classId === "MovementComponent") this.state(component);
  }

  dispose(): void { this.states.clear(); }

  private state(component: ActorComponent): MovementState {
    let state = this.states.get(component);
    if (!state) {
      state = { input: zero(), addedInput: zero(), velocity: zero(), grounded: false,
        moving: false, sinceGround: Infinity, jumpRemaining: 0, jumpRequested: false, unavailable: false };
      this.states.set(component, state);
      this.publish(component, state);
    }
    return state;
  }

  invoke(component: ActorComponent, name: string, args: Record<string, unknown>): Record<string, unknown> {
    const actor = component.owner;
    if (!actor || component.destroyed || actor.destroyed || !actor.components.includes(component) || !this.host.eligible(actor)) return {};
    const props = parseMovementProperties(Object.fromEntries(component.variables));
    if (name === "convertMovementInput") return { direction: this.convert(actor, props, args.input, finite(args.yaw)) };
    if (!props.enabled) return {};
    const state = this.state(component);
    switch (name) {
      case "setMovementInput": state.input = vector(args.direction); break;
      case "addMovementInput": {
        const v = vector(args.direction);
        state.addedInput.x += v.x; state.addedInput.z += v.z;
        break;
      }
      case "setMovementVelocity": state.velocity = vector(args.velocity); break;
      case "addMovementVelocity": {
        const v = vector(args.velocity);
        state.velocity.x += v.x; state.velocity.y += v.y; state.velocity.z += v.z;
        break;
      }
      case "jumpMovement":
        state.jumpRequested = true;
        state.jumpRemaining = props.jumpBufferTime;
        break;
      case "stopMovementImmediately":
        state.input = zero(); state.addedInput = zero(); state.velocity = zero();
        state.jumpRequested = false; state.jumpRemaining = 0;
        break;
    }
    this.publish(component, state);
    return {};
  }

  private convert(actor: Actor, props: MovementProperties, value: unknown, yaw: number): Vec3 {
    const v = typeof value === "number" ? { x: finite(value), y: 0 } : vector(value);
    if (this.host.physics(actor).getBackend().kind === "2d") {
      const magnitude = Math.abs(v.x);
      return { x: magnitude <= props.deadZone ? 0 : Math.sign(v.x) * Math.min(1, (magnitude - props.deadZone) / (1 - props.deadZone) * props.inputScale), y: 0, z: 0 };
    }
    const magnitude = Math.hypot(v.x, v.y);
    if (magnitude <= props.deadZone) return zero();
    const strength = Math.min(1, (magnitude - props.deadZone) / (1 - props.deadZone) * props.inputScale);
    let heading = (props.inputYaw + yaw) % 360 * Math.PI / 180;
    if (props.inputSpace === "actor") {
      const actors = new Map(this.host.world.getActors().map((entry) => [entry.guid, entry]));
      const pose = actorWorldTransform(actor, actors);
      if (pose) {
        const forward = rotateVector(pose.rotation, { x: 0, y: 0, z: 1 });
        heading += Math.atan2(forward.x, forward.z);
      }
    }
    const x = v.x / magnitude * strength, z = v.y / magnitude * strength;
    return { x: x * Math.cos(heading) + z * Math.sin(heading), y: 0, z: z * Math.cos(heading) - x * Math.sin(heading) };
  }

  step(dt: number, physics: PhysicsWorldSync): void {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    const live = new Set<ActorComponent>();
    for (const actor of this.host.world.getActors()) {
      if (actor.destroyed) continue;
      // One motor owns an actor. Extra components cannot multiply movement.
      const component = actor.components.find((entry) => entry.classId === "MovementComponent" && !entry.destroyed && entry.owner === actor);
      if (!component) continue;
      live.add(component);
      if (this.host.physics(actor) !== physics) continue;
      const state = this.state(component);
      if (!this.host.eligible(actor)) continue;
      const props = parseMovementProperties(Object.fromEntries(component.variables));
      if (!props.enabled) {
        state.input = zero(); state.addedInput = zero(); state.velocity = zero();
        state.jumpRequested = false; state.jumpRemaining = 0;
        this.transitions(component, state, state.grounded, false);
        continue;
      }
      this.advance(actor, component, state, props, dt);
    }
    for (const component of this.states.keys()) if (!live.has(component)) this.states.delete(component);
  }

  private advance(actor: Actor, component: ActorComponent, state: MovementState, props: MovementProperties, dt: number): void {
    const physics = this.host.physics(actor);
    const is2D = physics.getBackend().kind === "2d";
    let x = state.input.x + state.addedInput.x;
    let z = is2D ? 0 : state.input.z + state.addedInput.z;
    state.addedInput = zero();
    const strength = Math.hypot(x, z);
    if (strength > 1) { x /= strength; z /= strength; }
    const hasInput = strength > 1e-6;
    const deltaX = x * props.maxSpeed - state.velocity.x;
    const deltaZ = z * props.maxSpeed - state.velocity.z;
    const distance = Math.hypot(deltaX, deltaZ);
    const rate = (hasInput ? props.acceleration : props.braking) * (state.grounded ? 1 : props.airControl);
    const factor = distance > 0 ? Math.min(1, rate * dt / distance) : 0;
    state.velocity.x += deltaX * factor;
    state.velocity.z = is2D ? 0 : state.velocity.z + deltaZ * factor;

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
    if (state.grounded && !rising) translation.y = Math.min(translation.y, -props.groundSnapDistance);
    const moved = physics.moveMovement(actor, translation, dt, props);
    if (!moved) {
      if (!state.unavailable) this.host.warn(component);
      state.unavailable = true;
      state.velocity = zero(); state.sinceGround = Infinity;
      state.jumpRequested = false; state.jumpRemaining = 0;
      this.transitions(component, state, false, false);
      return;
    }
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

  private publish(component: ActorComponent, state: MovementState): void {
    component.setVariable("velocity", { ...state.velocity });
    component.setVariable("speed", Math.hypot(state.velocity.x, state.velocity.z));
    component.setVariable("isGrounded", state.grounded);
    component.setVariable("isInAir", !state.grounded);
    component.setVariable("isMoving", state.moving);
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
      this.host.event(component, event, { velocity: { ...state.velocity }, speed: Math.hypot(state.velocity.x, state.velocity.z) });
    }
  }
}
