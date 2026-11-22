import {
  cloneTweenValue, interpolateTweenValue, parseEasingCurve, sampleEasingCurve,
  type EasingCurveRef, type TweenValue, type TweenValueType,
} from "@haptic/core";
import { ActorComponent, type EngineObject } from "@haptic/object-model";
import { TickWait } from "./tick-wait";

/** Storage identity is separate from its current value, including for scalar locals. */
export type TweenReference = {
  identity: object;
  property: string;
  /** Current stored value; variable references have it, so reference inputs can read before they write. */
  get?(): unknown;
  set(value: unknown): void | boolean;
  owner?: EngineObject;
  /** Compound writes claim the same channels as their individual property writers. */
  channels?: readonly string[];
  /** World writes run after local writes, with live ancestors evaluated first. */
  worldTransformDepth?: () => number;
};

export type TweenRequest = {
  reference: TweenReference;
  type: TweenValueType;
  a: unknown;
  b: unknown;
  duration: number;
  curve: unknown;
  owner?: EngineObject | null;
};

type ActiveTween = TweenRequest & {
  a: TweenValue;
  b: TweenValue;
  curve: EasingCurveRef;
  elapsed: number;
  started: boolean;
  resolve(completed: boolean): void;
  reject(error: unknown): void;
};

export function tweenOwnerAlive(owner?: EngineObject | null): boolean {
  return !owner || (!owner.destroyed && (!(owner instanceof ActorComponent) ||
    (!!owner.owner && !owner.owner.destroyed)));
}

/** Simulation-clock latent actions. Resolving false unwinds a cancelled action without Completed. */
export class TweenRuntime {
  private readonly active = new Set<ActiveTween>();
  /** Active tweens by storage identity, so a new tween finds the ones it replaces without a scan. */
  private readonly byIdentity = new Map<object, Set<ActiveTween>>();
  /** `advance`'s copy of the tweens it steps, reused while it is not already stepping. */
  private readonly stepScratch: ActiveTween[] = [];
  private advancing = false;
  private stopped = false;
  private readonly canRun: (owner?: EngineObject | null) => boolean;

  constructor(canRun: (owner?: EngineObject | null) => boolean = () => true) {
    this.canRun = canRun;
  }

  /** Settles when the tween ends, inside the `advance` that ended it. */
  start(request: TweenRequest): TickWait<boolean> {
    const { reference } = request;
    const a = cloneTweenValue(request.type, request.a);
    const b = cloneTweenValue(request.type, request.b);
    if (this.stopped || !reference || !reference.identity || typeof reference.set !== "function" ||
      !Number.isFinite(request.duration) || a === null || b === null ||
      !tweenOwnerAlive(request.owner) || !tweenOwnerAlive(reference.owner)) return TickWait.from(false);
    const channels = reference.channels ?? [reference.property];
    const sameStorage = this.byIdentity.get(reference.identity);
    if (sameStorage) {
      // Copied: finishing one may resolve a wait that starts another on this storage.
      for (const previous of [...sameStorage]) {
        if (this.active.has(previous) && previous.reference.channels!.some((key) => channels.includes(key))) {
          this.finish(previous, false);
        }
      }
    }
    return TickWait.start<boolean>((resolve, reject) => {
      const tween: ActiveTween = { ...request, reference: { ...reference, channels: [...channels] },
        a, b, curve: parseEasingCurve(request.curve), elapsed: 0, started: false, resolve, reject };
      this.add(tween);
      this.advanceOne(tween, 0);
    });
  }

  /** `canAdvance`, while the game is paused: whether a tween's owner ticks on pause; the rest hold. */
  advance(deltaSeconds: number, canAdvance?: (owner: EngineObject | null | undefined) => boolean): void {
    if (this.active.size === 0) return;
    const delta = Number.isFinite(deltaSeconds) && deltaSeconds > 0 ? deltaSeconds : 0;
    // A setter may synchronously start another action; it begins advancing next tick.
    const nested = this.advancing;
    const current = nested ? [] : this.stepScratch;
    let worldWrites = false;
    for (const tween of this.active) {
      if (canAdvance && !canAdvance(tween.owner)) continue;
      current.push(tween);
      if (tween.reference.worldTransformDepth) worldWrites = true;
    }
    this.advancing = true;
    try {
      for (const tween of current) {
        if (!tween.reference.worldTransformDepth && this.active.has(tween)) this.advanceOne(tween, delta);
      }
      // World writes follow, ancestors first; only they need ordering.
      if (!worldWrites) return;
      const world = current.filter((tween) => tween.reference.worldTransformDepth && this.active.has(tween))
        .map((tween) => ({ tween, depth: tween.reference.worldTransformDepth!() }))
        .sort((a, b) => a.depth - b.depth);
      for (const { tween } of world) if (this.active.has(tween)) this.advanceOne(tween, delta);
    } finally {
      if (!nested) {
        this.advancing = false;
        current.length = 0;
      }
    }
  }

  cancelInvalid(): void {
    for (const tween of this.active) {
      if (!tweenOwnerAlive(tween.owner) || !tweenOwnerAlive(tween.reference.owner)) this.finish(tween, false);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const tween of this.active) this.finish(tween, false);
  }

  private advanceOne(tween: ActiveTween, delta: number): void {
    if (!tweenOwnerAlive(tween.owner) || !tweenOwnerAlive(tween.reference.owner)) {
      this.finish(tween, false);
      return;
    }
    if (!this.canRun(tween.owner) || !this.canRun(tween.reference.owner)) return;
    try {
      if (!tween.started) {
        tween.started = true;
        if (tween.duration > 0 && tween.reference.set(cloneTweenValue(tween.type, tween.a)) === false) {
          this.finish(tween, false);
          return;
        }
      }
      if (!this.active.has(tween)) return;
      tween.elapsed += delta;
      const finished = tween.duration <= 0 || tween.elapsed >= tween.duration - Number.EPSILON * Math.max(1, tween.duration) * 4;
      if (finished) {
        const written = tween.reference.set(cloneTweenValue(tween.type, tween.b)) !== false;
        if (this.active.has(tween)) this.finish(tween, written);
      } else if (delta > 0) {
        const value = interpolateTweenValue(tween.type, tween.a, tween.b,
          sampleEasingCurve(tween.curve, tween.elapsed / tween.duration));
        if (tween.reference.set(value) === false) this.finish(tween, false);
      }
    } catch (error) {
      this.remove(tween);
      tween.reject(error);
    }
  }

  private add(tween: ActiveTween): void {
    this.active.add(tween);
    const identity = tween.reference.identity;
    let sameStorage = this.byIdentity.get(identity);
    if (!sameStorage) this.byIdentity.set(identity, sameStorage = new Set());
    sameStorage.add(tween);
  }

  private remove(tween: ActiveTween): void {
    this.active.delete(tween);
    const identity = tween.reference.identity;
    const sameStorage = this.byIdentity.get(identity);
    if (sameStorage?.delete(tween) && sameStorage.size === 0) this.byIdentity.delete(identity);
  }

  private finish(tween: ActiveTween, completed: boolean): void {
    this.remove(tween);
    tween.resolve(completed);
  }
}
