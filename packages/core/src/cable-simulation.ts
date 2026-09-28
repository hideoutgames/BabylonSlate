import { parseCableProperties, type CableProperties } from "./cable-component";

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

/** Engine-neutral fixed-step Verlet cable. No allocations occur during update. */
export class CableSimulation {
  private current: Float32Array;
  private previous: Float32Array;
  private properties: CableProperties;
  private readonly anchors = new Float64Array(6);
  private readonly acceleration = new Float64Array(3);
  private accumulatedTime = 0;
  private quietTime = 0;
  private asleep = false;

  constructor(properties: CableProperties, start: readonly number[], end: readonly number[]) {
    this.properties = parseCableProperties(properties);
    this.current = new Float32Array((this.properties.numSegments + 1) * 3);
    this.previous = new Float32Array(this.current.length);
    this.reset(start, end);
  }

  /** World-space XYZ positions; buffer identity changes only with segment count. */
  get positions(): Float32Array { return this.current; }
  get sleeping(): boolean { return this.asleep; }

  /** Authored settings changes wake the cable; topology changes reset its shape. */
  configure(properties: CableProperties): void {
    const next = parseCableProperties(properties);
    const resize = next.numSegments !== this.properties.numSegments;
    this.properties = next;
    this.accumulatedTime = 0;
    if (resize) {
      this.current = new Float32Array((next.numSegments + 1) * 3);
      this.previous = new Float32Array(this.current.length);
      this.initializeLine();
    }
    this.wake();
  }

  reset(start: readonly number[], end: readonly number[]): void {
    this.readAnchor(start, 0);
    this.readAnchor(end, 3);
    this.initializeLine();
    this.accumulatedTime = 0;
    this.wake();
  }

  wake(): void {
    this.asleep = false;
    this.quietTime = 0;
  }

  /**
   * Returns whether positions may have changed. Excess stall time is dropped,
   * so a paused/backgrounded host never queues unbounded catch-up work.
   * Collision-enabled cables remain awake so moving obstacles are observed.
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
    const startMoved = this.readAnchor(start, 0);
    const endMoved = this.readAnchor(end, 3);
    const anchorMoved = (startMoved && props.attachStart) || (endMoved && props.attachEnd);
    let accelerationChanged = false;
    for (let axis = 0; axis < 3; axis++) {
      const value = (Number.isFinite(gravity[axis]) ? gravity[axis] : 0) * props.gravityScale + props.cableForce[axis];
      if (value !== this.acceleration[axis]) {
        this.acceleration[axis] = value;
        accelerationChanged = true;
      }
    }
    if (anchorMoved || accelerationChanged) this.wake();
    if (anchorMoved) this.pinAnchors();
    if (this.asleep || !(dt > 0) || !Number.isFinite(dt)) return anchorMoved;

    const step = props.substepTime;
    this.accumulatedTime = Math.min(this.accumulatedTime + dt, step * props.maxSubsteps);
    let changed = anchorMoved;
    while (this.accumulatedTime + 1e-10 >= step) {
      this.accumulatedTime = Math.max(0, this.accumulatedTime - step);
      this.step(step, collide);
      changed = true;
      if (this.asleep) {
        this.accumulatedTime = 0;
        break;
      }
    }
    return changed;
  }

  private readAnchor(value: readonly number[], offset: number): boolean {
    let moved = false;
    for (let axis = 0; axis < 3; axis++) {
      const coordinate = value[axis];
      if (Number.isFinite(coordinate) && coordinate !== this.anchors[offset + axis]) {
        this.anchors[offset + axis] = coordinate;
        moved = true;
      }
    }
    return moved;
  }

  private initializeLine(): void {
    const segments = this.properties.numSegments;
    for (let particle = 0; particle <= segments; particle++) {
      const alpha = particle / segments;
      for (let axis = 0; axis < 3; axis++) {
        this.current[particle * 3 + axis] = this.anchors[axis] + (this.anchors[axis + 3] - this.anchors[axis]) * alpha;
      }
    }
    this.previous.set(this.current);
  }

  private pinAnchors(): void {
    if (this.properties.attachStart) {
      for (let axis = 0; axis < 3; axis++) this.previous[axis] = this.current[axis] = this.anchors[axis];
    }
    if (this.properties.attachEnd) {
      const offset = this.current.length - 3;
      for (let axis = 0; axis < 3; axis++) this.previous[offset + axis] = this.current[offset + axis] = this.anchors[axis + 3];
    }
  }

  private step(dt: number, collide?: CableCollision): void {
    const props = this.properties;
    const current = this.current;
    const previous = this.previous;
    const first = props.attachStart ? 1 : 0;
    const last = props.numSegments - (props.attachEnd ? 1 : 0);
    const velocityScale = Math.pow(1 - props.damping, dt * 60);
    const dtSquared = dt * dt;
    this.pinAnchors();
    for (let particle = first; particle <= last; particle++) {
      for (let axis = 0; axis < 3; axis++) {
        const index = particle * 3 + axis;
        const position = current[index];
        current[index] = position + (position - previous[index]) * velocityScale + this.acceleration[axis] * dtSquared;
        previous[index] = position;
      }
    }

    // An overstretched pair of pins has no solution at the authored length.
    // Stretch to their separation instead of accumulating impossible tension.
    const minimumLength = props.attachStart && props.attachEnd
      ? Math.hypot(this.anchors[3] - this.anchors[0], this.anchors[4] - this.anchors[1], this.anchors[5] - this.anchors[2])
      : 0;
    const segmentLength = Math.max(props.cableLength, minimumLength) / props.numSegments;
    for (let iteration = 0; iteration < props.solverIterations; iteration++) {
      if (props.enableStiffness) {
        for (let particle = 0; particle < props.numSegments - 1; particle++) this.constrain(particle, particle + 2, segmentLength * 2);
      }
      if ((iteration & 1) === 0) {
        for (let particle = 0; particle < props.numSegments; particle++) this.constrain(particle, particle + 1, segmentLength);
      } else {
        for (let particle = props.numSegments - 1; particle >= 0; particle--) this.constrain(particle, particle + 1, segmentLength);
      }
    }

    if (props.enableCollision && collide) {
      for (let particle = first; particle <= last; particle++) {
        collide(previous, current, particle, props.cableWidth * 0.5, props.collisionFriction);
      }
    }
    if (!props.enableCollision && props.sleepThreshold > 0) {
      let maximumMovementSquared = 0;
      for (let particle = first; particle <= last; particle++) {
        const offset = particle * 3;
        const dx = current[offset] - previous[offset];
        const dy = current[offset + 1] - previous[offset + 1];
        const dz = current[offset + 2] - previous[offset + 2];
        maximumMovementSquared = Math.max(maximumMovementSquared, dx * dx + dy * dy + dz * dz);
      }
      if (maximumMovementSquared <= props.sleepThreshold * props.sleepThreshold * dtSquared) {
        this.quietTime += dt;
        if (this.quietTime + 1e-10 >= props.sleepDelay) {
          this.asleep = true;
          this.previous.set(current);
        }
      } else this.quietTime = 0;
    }
  }

  private constrain(left: number, right: number, length: number): void {
    const props = this.properties;
    const leftFree = !(left === 0 && props.attachStart);
    const rightFree = !(right === props.numSegments && props.attachEnd);
    if (!leftFree && !rightFree) return;
    const a = left * 3;
    const b = right * 3;
    const positions = this.current;
    let dx = positions[b] - positions[a];
    const dy = positions[b + 1] - positions[a + 1];
    const dz = positions[b + 2] - positions[a + 2];
    let distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    // Deterministic direction also separates particles from coincident anchors.
    if (distance < 1e-8) { dx = 1e-8; distance = 1e-8; }
    const correction = (distance - length) / (distance * (leftFree && rightFree ? 2 : 1));
    if (leftFree) {
      positions[a] += dx * correction;
      positions[a + 1] += dy * correction;
      positions[a + 2] += dz * correction;
    }
    if (rightFree) {
      positions[b] -= dx * correction;
      positions[b + 1] -= dy * correction;
      positions[b + 2] -= dz * correction;
    }
  }
}
