import { parseCableProperties, type CableProperties } from "./cable-component";
import { writeCableRestShape, type CablePointBuffer } from "./cable-rest-shape";

/**
 * Resolve a free particle against the scene, in place. The index is a particle
 * index (multiply by three for an XYZ offset). Adjust previous too to remove
 * inward velocity/apply friction. Buffers must not be retained or resized.
 */
export type CableCollision = (
  previous: Float32Array,
  positions: Float32Array,
  particleIndex: number,
  radius: number,
  friction: number,
) => void;

/**
 * An attached anchor that jumps further than max(this fraction of the length,
 * the minimum) plus a multiple of its recent motion in one update re-poses the
 * cable. Measuring against recent motion keeps fast continuous motion (a quick
 * gizmo drag, a vehicle) swinging while a jump from rest or a jump far beyond
 * the current pace (script teleport, undo, Details edit) still re-poses.
 */
const TELEPORT_LENGTH_FRACTION = 0.5;
const TELEPORT_MINIMUM_DISTANCE = 1;
const TELEPORT_MOTION_RATIO = 4;
/** Seconds for remembered anchor motion to decay to 1/e. */
const TELEPORT_MOTION_DECAY = 0.25;
/**
 * Constraint passes that restore segment lengths after `carry`. A carried
 * cable pulled taut needs several Gauss–Seidel passes to straighten; any
 * correction left over would become velocity and overshoot.
 */
const CARRY_RELAX_PASSES = 8;

/**
 * Engine-neutral fixed-step Verlet cable. Long-range tethers bound every free
 * particle's distance from each attached pin so fast motion cannot rubber-band
 * the cable, then Gauss–Seidel sweeps relax the segment distance constraints.
 * New, resized and teleported cables start at their rest shape. No allocations
 * occur during update.
 */
export class CableSimulation {
  private current: Float32Array;
  private previous: Float32Array;
  private properties: CableProperties;
  private readonly start = new Float64Array(3);
  private readonly end = new Float64Array(3);
  private readonly startFrom = new Float64Array(3);
  private readonly endFrom = new Float64Array(3);
  private readonly acceleration = new Float64Array(3);
  private accelerationKnown = false;
  private restPending = true;
  /** Recent per-update attached-anchor displacement, decaying over time. */
  private anchorMotion = 0;
  private accumulatedTime = 0;
  private quietTime = 0;
  private asleep = false;
  private resumed = false;
  // Per-configuration constants hoisted out of the substep loop.
  private velocityScale = 1;
  private substepSquared = 0;
  private sleepLimitSquared = 0;
  private firstFree = 0;
  private lastFree = 0;
  private headLeft = 0.5;
  private headRight = 0.5;
  private tailLeft = 0.5;
  private tailRight = 0.5;
  /** Per-particle velocity kept across `carry`; allocated on first use. */
  private carried: Float32Array | null = null;

  constructor(properties: CableProperties, start: readonly number[], end: readonly number[]) {
    this.properties = parseCableProperties(properties);
    this.current = new Float32Array((this.properties.numSegments + 1) * 3);
    this.previous = new Float32Array(this.current.length);
    this.derive();
    this.reset(start, end);
  }

  /** World-space XYZ positions; buffer identity changes only with segment count. */
  get positions(): Float32Array { return this.current; }
  get sleeping(): boolean { return this.asleep; }
  /** Fraction of a substep accumulated since the last step, for render interpolation. */
  get stepAlpha(): number {
    return Math.min(1, Math.max(0, this.accumulatedTime / this.properties.substepTime));
  }

  /** Authored settings changes wake the cable; topology changes re-pose it. */
  configure(properties: CableProperties): void {
    const next = parseCableProperties(properties);
    const resize = next.numSegments !== this.properties.numSegments;
    this.properties = next;
    this.derive();
    if (resize) {
      this.current = new Float32Array((next.numSegments + 1) * 3);
      this.previous = new Float32Array(this.current.length);
      this.writeRestShape();
      // Gravity Scale or Cable Force may have changed with the topology.
      this.restPending = true;
    }
    this.wake();
  }

  /** Move both anchors and restart from the rest shape without velocity. */
  reset(start: readonly number[], end: readonly number[]): void {
    readAnchor(start, this.start);
    readAnchor(end, this.end);
    this.startFrom.set(this.start);
    this.endFrom.set(this.end);
    this.writeRestShape();
    // Before the first update the acceleration is unknown; pose again then.
    // A colliding cable also poses again with the collision callback.
    this.restPending = !this.accelerationKnown || this.properties.enableCollision;
    this.accumulatedTime = 0;
    this.anchorMotion = 0;
    this.wake();
  }

  wake(): void {
    if (this.asleep) this.resumed = true;
    this.asleep = false;
    this.quietTime = 0;
  }

  /**
   * Returns whether positions may have changed. Excess stall time is dropped,
   * so a paused/backgrounded host never queues unbounded catch-up work.
   * Cables that collide (Enable Collision with a `collide` callback) remain
   * awake so moving obstacles are observed; without a callback they sleep.
   */
  update(
    dt: number,
    start: readonly number[],
    end: readonly number[],
    gravity: readonly number[],
    collide?: CableCollision,
  ): boolean {
    const props = this.properties;
    if (!props.enabled) return false;
    this.startFrom.set(this.start);
    this.endFrom.set(this.end);
    const startMoved = readAnchor(start, this.start) && props.attachStart;
    const endMoved = readAnchor(end, this.end) && props.attachEnd;
    const anchorMoved = startMoved || endMoved;
    let accelerationChanged = false;
    for (let axis = 0; axis < 3; axis++) {
      const value = (Number.isFinite(gravity[axis]) ? gravity[axis]! : 0) * props.gravityScale + props.cableForce[axis]!;
      if (value !== this.acceleration[axis]) {
        this.acceleration[axis] = value;
        accelerationChanged = true;
      }
    }
    this.accelerationKnown = true;
    const teleported = this.trackAnchorMotion(dt, startMoved, endMoved);
    let changed = false;
    if (this.restPending || teleported) {
      this.writeRestShape(collide);
      changed = true;
    }
    if (anchorMoved || accelerationChanged || changed) this.wake();
    if (this.asleep || !(dt > 0) || !Number.isFinite(dt)) {
      if (anchorMoved) this.pinAnchors(1);
      return changed || anchorMoved;
    }

    const step = props.substepTime;
    // A waking cable responds this frame instead of waiting for a full substep.
    if (this.resumed) this.accumulatedTime = Math.max(this.accumulatedTime, step - dt);
    this.resumed = false;
    this.accumulatedTime = Math.min(this.accumulatedTime + dt, step * props.maxSubsteps);
    const steps = Math.floor((this.accumulatedTime + 1e-10) / step);
    for (let index = 1; index <= steps; index++) {
      this.accumulatedTime = Math.max(0, this.accumulatedTime - step);
      // Anchors travel across the substeps rather than jumping at the first.
      this.pinAnchors(index / steps);
      this.step(collide);
      changed = true;
      if (this.asleep) {
        this.accumulatedTime = 0;
        break;
      }
    }
    if (anchorMoved) this.pinAnchors(1);
    return changed || anchorMoved;
  }

  /**
   * Move the attached ends to `start` / `end` and carry the cable with them,
   * for discrete edits such as a typed Location or an undo, which would whip
   * the cable if `update` turned the jump into velocity. Each particle shifts
   * by its blend of the two end moves (the whole cable follows a single
   * attached end), previous positions alike, then the segment constraints are
   * satisfied without changing any particle's velocity, and the cable settles
   * gently from its carried shape. A move beyond the teleport distance
   * re-poses the rest shape, as `update` would. Returns whether positions
   * changed.
   */
  carry(start: readonly number[], end: readonly number[]): boolean {
    const props = this.properties;
    if (!props.enabled) return false;
    this.startFrom.set(this.start);
    this.endFrom.set(this.end);
    const startMoved = readAnchor(start, this.start) && props.attachStart;
    const endMoved = readAnchor(end, this.end) && props.attachEnd;
    if (!startMoved && !endMoved) return false;
    this.wake();
    // Not yet posed with a known acceleration: the next update poses it.
    if (this.restPending) return true;
    const moved = Math.sqrt(Math.max(
      startMoved ? distanceSquared(this.start, this.startFrom) : 0,
      endMoved ? distanceSquared(this.end, this.endFrom) : 0,
    ));
    if (moved > Math.max(props.cableLength * TELEPORT_LENGTH_FRACTION, TELEPORT_MINIMUM_DISTANCE)) {
      this.writeRestShape();
      this.anchorMotion = 0;
      return true;
    }
    let sx = 0, sy = 0, sz = 0, ex = 0, ey = 0, ez = 0;
    if (props.attachStart) {
      sx = this.start[0]! - this.startFrom[0]!; sy = this.start[1]! - this.startFrom[1]!; sz = this.start[2]! - this.startFrom[2]!;
    }
    if (props.attachEnd) {
      ex = this.end[0]! - this.endFrom[0]!; ey = this.end[1]! - this.endFrom[1]!; ez = this.end[2]! - this.endFrom[2]!;
    }
    if (!props.attachStart) { sx = ex; sy = ey; sz = ez; }
    if (!props.attachEnd) { ex = sx; ey = sy; ez = sz; }
    const current = this.current, previous = this.previous;
    const segments = props.numSegments;
    for (let particle = 0; particle <= segments; particle++) {
      const t = particle / segments, offset = particle * 3;
      const dx = sx + (ex - sx) * t, dy = sy + (ey - sy) * t, dz = sz + (ez - sz) * t;
      current[offset] += dx; current[offset + 1] += dy; current[offset + 2] += dz;
      previous[offset] += dx; previous[offset + 1] += dy; previous[offset + 2] += dz;
    }
    this.pinAnchors(1);
    if (!this.carried || this.carried.length !== current.length) this.carried = new Float32Array(current.length);
    const velocity = this.carried;
    for (let index = 0; index < current.length; index++) velocity[index] = current[index]! - previous[index]!;
    // The carried shape is slightly sheared. Restore segment lengths as a
    // position change only, so the correction does not launch the cable.
    for (let pass = 0; pass < CARRY_RELAX_PASSES; pass++) this.constrain();
    for (let index = 0; index < current.length; index++) previous[index] = current[index]! - velocity[index]!;
    this.startFrom.set(this.start);
    this.endFrom.set(this.end);
    return true;
  }

  /**
   * Write positions blended between the last two substeps by `stepAlpha`, so a
   * display refreshing faster than the substep sees continuous motion.
   * Attached ends are written exactly at their current anchors.
   */
  writeInterpolated(out: CablePointBuffer): void {
    const current = this.current, previous = this.previous;
    const alpha = this.stepAlpha;
    for (let index = 0; index < current.length; index++) {
      out[index] = previous[index]! + (current[index]! - previous[index]!) * alpha;
    }
    if (this.properties.attachStart) {
      out[0] = this.start[0]!; out[1] = this.start[1]!; out[2] = this.start[2]!;
    }
    if (this.properties.attachEnd) {
      const offset = current.length - 3;
      out[offset] = this.end[0]!; out[offset + 1] = this.end[1]!; out[offset + 2] = this.end[2]!;
    }
  }

  private derive(): void {
    const props = this.properties;
    const step = props.substepTime;
    const segments = props.numSegments;
    this.velocityScale = Math.pow(1 - props.damping, step * 60);
    this.substepSquared = step * step;
    this.sleepLimitSquared = props.sleepThreshold * props.sleepThreshold * this.substepSquared;
    this.firstFree = props.attachStart ? 1 : 0;
    this.lastFree = segments - (props.attachEnd ? 1 : 0);
    // Correction weights for the first and last distance constraints.
    const headLeftFree = !props.attachStart, headRightFree = segments > 1 || !props.attachEnd;
    this.headLeft = headLeftFree ? (headRightFree ? 0.5 : 1) : 0;
    this.headRight = headRightFree ? (headLeftFree ? 0.5 : 1) : 0;
    const tailRightFree = !props.attachEnd;
    this.tailLeft = tailRightFree ? 0.5 : 1;
    this.tailRight = tailRightFree ? 0.5 : 0;
  }

  /**
   * Whether an attached anchor jumped discontinuously this update. Every move,
   * including a jump, becomes recent motion: an anchor that keeps moving that
   * far each update is continuous motion, however fast.
   */
  private trackAnchorMotion(dt: number, startMoved: boolean, endMoved: boolean): boolean {
    if (this.anchorMotion > 0 && dt > 0 && Number.isFinite(dt)) this.anchorMotion *= Math.exp(-dt / TELEPORT_MOTION_DECAY);
    if (!startMoved && !endMoved) return false;
    const props = this.properties;
    const moved = Math.sqrt(Math.max(
      startMoved ? distanceSquared(this.start, this.startFrom) : 0,
      endMoved ? distanceSquared(this.end, this.endFrom) : 0,
    ));
    const limit = Math.max(props.cableLength * TELEPORT_LENGTH_FRACTION, TELEPORT_MINIMUM_DISTANCE);
    const jumped = moved > limit + TELEPORT_MOTION_RATIO * this.anchorMotion;
    if (moved > this.anchorMotion) this.anchorMotion = moved;
    return jumped;
  }

  private writeRestShape(collide?: CableCollision): void {
    const props = this.properties;
    const current = this.current, previous = this.previous;
    writeCableRestShape(current, this.start, this.end, props.cableLength, this.acceleration, props.attachStart, props.attachEnd, props.numSegments);
    if (props.enableCollision && collide) {
      // Collision sweeps each particle from previous to current, so a rest
      // shape sagging through thin geometry would never be corrected. Sweep
      // from the straight pin-to-pin line (the shape with no pinned end) to
      // the rest shape instead, so the cable starts resting on obstacles.
      writeCableRestShape(previous, this.start, this.end, props.cableLength, this.acceleration, false, false, props.numSegments);
      for (let particle = this.firstFree; particle <= this.lastFree; particle++) {
        collide(previous, current, particle, props.cableWidth * 0.5, props.collisionFriction);
      }
    }
    previous.set(current);
    this.startFrom.set(this.start);
    this.endFrom.set(this.end);
    this.restPending = false;
    this.quietTime = 0;
  }

  /** Pin attached ends at `alpha` between this update's previous and new anchors. */
  private pinAnchors(alpha: number): void {
    const current = this.current, previous = this.previous;
    if (this.properties.attachStart) {
      for (let axis = 0; axis < 3; axis++) {
        const from = this.startFrom[axis]!;
        previous[axis] = current[axis] = from + (this.start[axis]! - from) * alpha;
      }
    }
    if (this.properties.attachEnd) {
      const offset = current.length - 3;
      for (let axis = 0; axis < 3; axis++) {
        const from = this.endFrom[axis]!;
        previous[offset + axis] = current[offset + axis] = from + (this.end[axis]! - from) * alpha;
      }
    }
  }

  private step(collide?: CableCollision): void {
    const props = this.properties;
    const current = this.current;
    const previous = this.previous;
    const firstOffset = this.firstFree * 3;
    const lastOffset = this.lastFree * 3;
    const velocityScale = this.velocityScale;
    const ax = this.acceleration[0]! * this.substepSquared;
    const ay = this.acceleration[1]! * this.substepSquared;
    const az = this.acceleration[2]! * this.substepSquared;
    for (let offset = firstOffset; offset <= lastOffset; offset += 3) {
      const x = current[offset]!, y = current[offset + 1]!, z = current[offset + 2]!;
      current[offset] = x + (x - previous[offset]!) * velocityScale + ax;
      current[offset + 1] = y + (y - previous[offset + 1]!) * velocityScale + ay;
      current[offset + 2] = z + (z - previous[offset + 2]!) * velocityScale + az;
      previous[offset] = x;
      previous[offset + 1] = y;
      previous[offset + 2] = z;
    }

    this.constrain();

    // Only a cable that actually collides stays awake for moving obstacles.
    // Editor cables step without a callback and sleep like any other cable.
    const colliding = props.enableCollision && !!collide;
    if (colliding) {
      for (let particle = this.firstFree; particle <= this.lastFree; particle++) {
        collide(previous, current, particle, props.cableWidth * 0.5, props.collisionFriction);
      }
    }
    if (!colliding && props.sleepThreshold > 0) {
      let maximumMovementSquared = 0;
      for (let offset = firstOffset; offset <= lastOffset; offset += 3) {
        const dx = current[offset]! - previous[offset]!;
        const dy = current[offset + 1]! - previous[offset + 1]!;
        const dz = current[offset + 2]! - previous[offset + 2]!;
        const movement = dx * dx + dy * dy + dz * dz;
        if (movement > maximumMovementSquared) maximumMovementSquared = movement;
      }
      if (maximumMovementSquared <= this.sleepLimitSquared) {
        this.quietTime += props.substepTime;
        if (this.quietTime + 1e-10 >= props.sleepDelay) {
          this.asleep = true;
          // Pins were still while the cable settled; a later jump is judged from rest.
          this.anchorMotion = 0;
          previous.set(current);
        }
      } else this.quietTime = 0;
    }
  }

  /** Tethers, then the distance (and optional bending) sweeps, on `current` only. */
  private constrain(): void {
    const props = this.properties;
    const current = this.current;
    const segments = props.numSegments;
    // An overstretched pair of pins has no solution at the authored length.
    // Stretch to their separation instead of accumulating impossible tension.
    let segmentLength = props.cableLength / segments;
    const endOffset = segments * 3;
    if (props.attachStart && props.attachEnd) {
      const dx = current[endOffset]! - current[0]!;
      const dy = current[endOffset + 1]! - current[1]!;
      const dz = current[endOffset + 2]! - current[2]!;
      const separation = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (separation > props.cableLength) segmentLength = separation / segments;
    }
    // Long-range attachment tethers: particle i may be at most i segments from
    // the start pin (and n - i from the end pin). One projection before the
    // distance sweeps bounds total stretch under brisk motion, independently
    // of the segment count; the sweeps then smooth the projected particles.
    if (props.attachStart || props.attachEnd) this.tether(segmentLength);
    for (let iteration = 0; iteration < props.solverIterations; iteration++) {
      if (props.enableStiffness) this.relaxBending(segmentLength * 2);
      if ((iteration & 1) === 0) {
        relax(current, 0, 3, segmentLength, this.headLeft, this.headRight);
        for (let offset = 3; offset < endOffset - 3; offset += 3) relax(current, offset, offset + 3, segmentLength, 0.5, 0.5);
        if (segments > 1) relax(current, endOffset - 3, endOffset, segmentLength, this.tailLeft, this.tailRight);
      } else {
        if (segments > 1) relax(current, endOffset - 3, endOffset, segmentLength, this.tailLeft, this.tailRight);
        for (let offset = endOffset - 6; offset >= 3; offset -= 3) relax(current, offset, offset + 3, segmentLength, 0.5, 0.5);
        relax(current, 0, 3, segmentLength, this.headLeft, this.headRight);
      }
    }
  }

  private relaxBending(length: number): void {
    const props = this.properties;
    const current = this.current;
    const last = props.numSegments - 2;
    for (let particle = 0; particle <= last; particle++) {
      const leftFree = particle !== 0 || !props.attachStart;
      const rightFree = particle !== last || !props.attachEnd;
      relax(current, particle * 3, particle * 3 + 6, length,
        leftFree ? (rightFree ? 0.5 : 1) : 0,
        rightFree ? (leftFree ? 0.5 : 1) : 0);
    }
  }

  private tether(segmentLength: number): void {
    const props = this.properties;
    const current = this.current;
    const segments = props.numSegments;
    const endOffset = segments * 3;
    const sx = current[0]!, sy = current[1]!, sz = current[2]!;
    const ex = current[endOffset]!, ey = current[endOffset + 1]!, ez = current[endOffset + 2]!;
    for (let particle = this.firstFree; particle <= this.lastFree; particle++) {
      const offset = particle * 3;
      if (props.attachStart) {
        const dx = current[offset]! - sx, dy = current[offset + 1]! - sy, dz = current[offset + 2]! - sz;
        const squared = dx * dx + dy * dy + dz * dz;
        const limit = particle * segmentLength;
        if (squared > limit * limit) {
          const scale = limit / Math.sqrt(squared);
          current[offset] = sx + dx * scale;
          current[offset + 1] = sy + dy * scale;
          current[offset + 2] = sz + dz * scale;
        }
      }
      if (props.attachEnd) {
        const dx = current[offset]! - ex, dy = current[offset + 1]! - ey, dz = current[offset + 2]! - ez;
        const squared = dx * dx + dy * dy + dz * dz;
        const limit = (segments - particle) * segmentLength;
        if (squared > limit * limit) {
          const scale = limit / Math.sqrt(squared);
          current[offset] = ex + dx * scale;
          current[offset + 1] = ey + dy * scale;
          current[offset + 2] = ez + dz * scale;
        }
      }
    }
  }
}

function readAnchor(value: readonly number[], target: Float64Array): boolean {
  let moved = false;
  for (let axis = 0; axis < 3; axis++) {
    const coordinate = value[axis];
    if (Number.isFinite(coordinate) && coordinate !== target[axis]) {
      target[axis] = coordinate!;
      moved = true;
    }
  }
  return moved;
}

function distanceSquared(a: Float64Array, b: Float64Array): number {
  const dx = a[0]! - b[0]!, dy = a[1]! - b[1]!, dz = a[2]! - b[2]!;
  return dx * dx + dy * dy + dz * dz;
}

/** Move a particle pair toward `length`, weighting each side's share of the correction. */
function relax(positions: Float32Array, a: number, b: number, length: number, leftWeight: number, rightWeight: number): void {
  let dx = positions[b]! - positions[a]!;
  const dy = positions[b + 1]! - positions[a + 1]!;
  const dz = positions[b + 2]! - positions[a + 2]!;
  const squared = dx * dx + dy * dy + dz * dz;
  let distance: number;
  // Deterministic direction also separates particles from coincident anchors.
  if (squared < 1e-16) { dx = 1e-8; distance = 1e-8; } else distance = Math.sqrt(squared);
  const correction = (distance - length) / distance;
  const left = correction * leftWeight, right = correction * rightWeight;
  positions[a] += dx * left;
  positions[a + 1] += dy * left;
  positions[a + 2] += dz * left;
  positions[b] -= dx * right;
  positions[b + 1] -= dy * right;
  positions[b + 2] -= dz * right;
}
