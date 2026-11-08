import type { CommandMessage } from "@haptic/bridge";
import {
  addCameraShakeOffset,
  cameraShakeFinished,
  sampleCameraShake,
  worldCameraShakeScale,
  ZERO_CAMERA_SHAKE_OFFSET,
  type CameraShakeClock,
  type CameraShakeCurves,
  type CameraShakeOffset,
  type CameraShakePayload,
} from "@haptic/core";
import type { RuntimeSubsystem } from "./runtime-subsystems";

type Vec3 = { x: number; y: number; z: number };

/** Play World Camera Shake's falloff: full strength within `inner`, none past `outer`. */
export interface WorldCameraShake {
  epicenter: Vec3;
  inner: number;
  outer: number;
  falloff: number;
}

type ActiveShake = {
  readonly id: number;
  readonly shake: CameraShakePayload;
  readonly curves: CameraShakeCurves;
  /** The view it shakes: null for the main Scene's, else a Scene Layer's guid. */
  readonly target: string | null;
  readonly world: WorldCameraShake | null;
  readonly clock: CameraShakeClock;
  scale: number;
  paused: boolean;
};

interface CameraShakesHost {
  emit(command: CommandMessage): void;
  /** Where a view is in the world, for world shakes; null when it has none. */
  viewLocation(target: string | null): Vec3 | null;
  /** Whether a Scene Layer instance is still in the Scene. */
  hasLayer(guid: string): boolean;
  /** A new shake's noise seed, from the session's seeded stream. */
  seed(): number;
}

/** Above this offset change a target's view is sent again; below it the previous offset stands. */
const SEND_EPSILON = 1e-6;

/**
 * Play Camera Shake and its handle nodes. Shakes count simulation time (so they follow time dilation) and hold
 * while the game is paused. Each tick sums every playing shake of a view, a world shake at its strength for the
 * view's distance to its epicenter, and sends the view's offset (`setCameraShake`) when it changed; a view whose
 * shakes all ended is sent `offset: null` once. Shakes end on their own, on Stop, with their Scene Layer, on a
 * Scene change and when Play stops. Handles are ids from 1; 0 is no shake.
 */
export class CameraShakes implements RuntimeSubsystem {
  private readonly shakes = new Map<number, ActiveShake>();
  private readonly sent = new Map<string | null, CameraShakeOffset>();
  private nextId = 1;
  private readonly host: CameraShakesHost;

  constructor(host: CameraShakesHost) {
    this.host = host;
  }

  /** Starts a shake and returns its id; `scale` 0 or below, or a missing Scene Layer, starts none (0). */
  play(shake: CameraShakePayload, curves: CameraShakeCurves, options: { target?: string | null; scale?: unknown; world?: WorldCameraShake | null } = {}): number {
    const target = options.target ?? null;
    const scale = Number(options.scale ?? 1);
    if (!Number.isFinite(scale) || scale <= 0) return 0;
    if (target !== null && !this.host.hasLayer(target)) return 0;
    const id = this.nextId++;
    this.shakes.set(id, {
      id, shake, curves, target, world: options.world ?? null, scale, paused: false,
      clock: { time: 0, stoppingAt: null, seed: this.host.seed() },
    });
    return id;
  }

  /** Blends the shake out over its Blend Out Time, or ends it now when `immediately` (or it has no blend out). */
  stop(id: number, immediately = false): void {
    const active = this.shakes.get(id);
    if (!active) return;
    if (immediately || active.shake.blendOutTime <= 0) this.shakes.delete(id);
    else if (active.clock.stoppingAt === null) active.clock.stoppingAt = active.clock.time;
  }

  /** Stops every shake of a view (`target` undefined: of every view). */
  stopAll(immediately = false, target?: string | null): void {
    for (const active of [...this.shakes.values()]) if (target === undefined || active.target === target) this.stop(active.id, immediately);
  }

  setPaused(id: number, paused: boolean): void {
    const active = this.shakes.get(id);
    if (active) active.paused = paused;
  }

  setScale(id: number, scale: unknown): void {
    const active = this.shakes.get(id);
    const value = Number(scale);
    if (active && Number.isFinite(value)) active.scale = Math.max(0, value);
  }

  /** True until the shake ends, including while paused or blending out. */
  isPlaying(id: number): boolean {
    return this.shakes.has(id);
  }

  isPaused(id: number): boolean {
    return this.shakes.get(id)?.paused === true;
  }

  /** Count one step of every shake that is not paused, drop the ended ones, and send each view's changed offset. */
  advance(dt: number, gamePaused: boolean): void {
    if (this.shakes.size === 0 && this.sent.size === 0) return;
    const totals = new Map<string | null, CameraShakeOffset>();
    for (const active of [...this.shakes.values()]) {
      if (active.target !== null && !this.host.hasLayer(active.target)) {
        this.shakes.delete(active.id);
        continue;
      }
      if (!gamePaused && !active.paused) active.clock.time += Math.max(0, dt);
      if (cameraShakeFinished(active.shake, active.clock)) {
        this.shakes.delete(active.id);
        continue;
      }
      const total = totals.get(active.target) ?? { ...ZERO_CAMERA_SHAKE_OFFSET };
      totals.set(active.target, total);
      addCameraShakeOffset(total, sampleCameraShake(active.shake, active.clock, active.scale * this.worldScale(active), active.curves));
    }
    for (const [target, offset] of totals) {
      const previous = this.sent.get(target);
      if (previous && !changed(previous, offset)) continue;
      this.sent.set(target, offset);
      this.host.emit({ type: "setCameraShake", sceneLayerId: target, offset: { ...offset } });
    }
    for (const target of [...this.sent.keys()]) {
      if (totals.has(target)) continue;
      this.sent.delete(target);
      // A removed Scene Layer takes its view with it.
      if (target === null || this.host.hasLayer(target)) this.host.emit({ type: "setCameraShake", sceneLayerId: target, offset: null });
    }
  }

  /** A world shake's strength for its view's current distance to the epicenter; 1 for other shakes. */
  private worldScale(active: ActiveShake): number {
    if (!active.world) return 1;
    const view = this.host.viewLocation(active.target);
    if (!view) return 1;
    const { epicenter, inner, outer, falloff } = active.world;
    return worldCameraShakeScale(Math.hypot(view.x - epicenter.x, view.y - epicenter.y, view.z - epicenter.z), inner, outer, falloff);
  }

  /** A new main Scene ends every shake and leaves the view unshaken; its Scene Layers leave with the old Scene. */
  resetForSceneLoad(): void {
    this.shakes.clear();
    if (this.sent.has(null)) this.host.emit({ type: "setCameraShake", sceneLayerId: null, offset: null });
    this.sent.clear();
  }

  cancelPending(): void {
    this.shakes.clear();
    this.sent.clear();
  }
}

function changed(a: CameraShakeOffset, b: CameraShakeOffset): boolean {
  return Math.abs(a.x - b.x) > SEND_EPSILON || Math.abs(a.y - b.y) > SEND_EPSILON || Math.abs(a.z - b.z) > SEND_EPSILON
    || Math.abs(a.pitch - b.pitch) > SEND_EPSILON || Math.abs(a.yaw - b.yaw) > SEND_EPSILON || Math.abs(a.roll - b.roll) > SEND_EPSILON
    || Math.abs(a.fov - b.fov) > SEND_EPSILON;
}
