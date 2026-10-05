import {
  cloneTweenValue, interpolateTweenValue, parseEasingCurve, sampleEasingCurve,
  type EasingCurve, type TweenValue, type TweenValueType,
} from "@babylonslate/core";
import { ActorComponent, type BObject } from "@babylonslate/object-model";

/** Storage identity is separate from its current value, including for scalar locals. */
export type TweenReference = {
  identity: object;
  property: string;
  set(value: unknown): void | boolean;
  owner?: BObject;
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
  owner?: BObject | null;
};

type ActiveTween = TweenRequest & {
  a: TweenValue;
  b: TweenValue;
  curve: EasingCurve;
  elapsed: number;
  started: boolean;
  resolve(completed: boolean): void;
  reject(error: unknown): void;
};

export function tweenOwnerAlive(owner?: BObject | null): boolean {
  return !owner || (!owner.destroyed && (!(owner instanceof ActorComponent) ||
    (!!owner.owner && !owner.owner.destroyed)));
}

/** Simulation-clock latent actions. Resolving false unwinds a cancelled action without Completed. */
export class TweenRuntime {
  private readonly active = new Set<ActiveTween>();
  private stopped = false;
  private readonly canRun: (owner?: BObject | null) => boolean;

  constructor(canRun: (owner?: BObject | null) => boolean = () => true) {
    this.canRun = canRun;
  }

  start(request: TweenRequest): Promise<boolean> {
    const { reference } = request;
    const a = cloneTweenValue(request.type, request.a);
    const b = cloneTweenValue(request.type, request.b);
    if (this.stopped || !reference || !reference.identity || typeof reference.set !== "function" ||
      !Number.isFinite(request.duration) || a === null || b === null ||
      !tweenOwnerAlive(request.owner) || !tweenOwnerAlive(reference.owner)) return Promise.resolve(false);
    const channels = reference.channels ?? [reference.property];
    for (const previous of this.active) {
      if (previous.reference.identity === reference.identity &&
        (previous.reference.channels ?? [previous.reference.property]).some((key) => channels.includes(key))) {
        this.finish(previous, false);
      }
    }
    return new Promise<boolean>((resolve, reject) => {
      const tween: ActiveTween = { ...request, reference: { ...reference, channels: [...channels] },
        a, b, curve: parseEasingCurve(request.curve), elapsed: 0, started: false, resolve, reject };
      this.active.add(tween);
      this.advanceOne(tween, 0);
    });
  }

  advance(deltaSeconds: number): void {
    const delta = Number.isFinite(deltaSeconds) && deltaSeconds > 0 ? deltaSeconds : 0;
    // A setter may synchronously start another action; it begins advancing next tick.
    const current = [...this.active];
    for (const tween of current) {
      if (!tween.reference.worldTransformDepth && this.active.has(tween)) this.advanceOne(tween, delta);
    }
    const world = current.filter((tween) => tween.reference.worldTransformDepth && this.active.has(tween))
      .map((tween) => ({ tween, depth: tween.reference.worldTransformDepth!() }))
      .sort((a, b) => a.depth - b.depth);
    for (const { tween } of world) if (this.active.has(tween)) this.advanceOne(tween, delta);
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
      this.active.delete(tween);
      tween.reject(error);
    }
  }

  private finish(tween: ActiveTween, completed: boolean): void {
    this.active.delete(tween);
    tween.resolve(completed);
  }
}
