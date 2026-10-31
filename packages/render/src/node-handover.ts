import type { AnimationGroup, Node, Scene } from "@babylonjs/core";

/** Babylon 9.29 `RuntimeAnimation` fields a target change rebinds (`_preparePath` resolves the property path). */
interface RuntimeAnimationTarget {
  target: unknown;
  _target: unknown;
  _activeTargets: unknown[];
  _directTarget?: unknown;
  _preparePath?: (target: unknown, targetIndex?: number) => void;
}

/**
 * Hands `from`'s place in the node tree to `to`: its children, and every animation targeting it, the channels of
 * `groups` (the whole Scene's by default) and a playing animatable's, so `to` moves as `from` did from the next frame.
 * Neither node's own transform changes.
 */
export function handOverNode(scene: Scene, from: Node, to: Node, groups: readonly AnimationGroup[] = scene.animationGroups): void {
  for (const child of from.getChildren()) child.parent = to;
  for (const group of groups) {
    for (const channel of group.targetedAnimations) if (channel.target === from) channel.target = to;
  }
  for (const animatable of scene.animatables) {
    if (animatable.target === from) animatable.target = to;
    for (const runtime of animatable.getAnimations() as unknown as RuntimeAnimationTarget[]) {
      if (runtime.target !== from) continue;
      if (typeof runtime._preparePath !== "function") throw new Error("Unsupported Babylon RuntimeAnimation layout: _preparePath is missing.");
      runtime._target = to;
      runtime._activeTargets = [];
      runtime._preparePath(to);
      runtime._directTarget = runtime._activeTargets[0];
    }
  }
}

/** Animated node properties a pool member keeps as its own (an instance's transform). */
const MEMBER_ANIMATED = new Set(["position", "rotation", "rotationQuaternion", "scaling"]);

/** Whether every channel of `groups` that targets `node` writes only its transform. */
export function animatesOnlyTransform(node: Node, groups: readonly AnimationGroup[]): boolean {
  for (const group of groups) {
    for (const { target, animation } of group.targetedAnimations) {
      if (target === node && !MEMBER_ANIMATED.has(animation.targetPropertyPath[0]!)) return false;
    }
  }
  return true;
}
