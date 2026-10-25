import { DEFORMER_MAX_COORDINATE, isUIControl2DClass, parseDeformerProperties } from "@haptic/core";
import { Actor, type ActorComponent, type EngineObject } from "@haptic/object-model";
import { asActor, asActorComponent, vec3Arg } from "./script-host-helpers";
import type { ScriptHostServices } from "./script-host-services";
import { splineComponentFunction } from "./spline-script";

/** What native component functions read from their `ScriptHost`. */
export interface ComponentFunctionHost {
  readonly services: ScriptHostServices;
  canInvokeOwner(owner: EngineObject): boolean;
  applyComponentVariable(component: ActorComponent, name: string, value: unknown, previous?: unknown): void;
}

/**
 * `ctx.callComponentFunction` on an engine component, plus the two Scene Layer actor functions. The checks
 * run in order and the order is the precedence, including where the destroyed-component and owner
 * admission gates sit, so keep it one chain.
 */
export function callNativeComponentFunction(
  host: ComponentFunctionHost,
  target: EngineObject | null | undefined,
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (target instanceof Actor && name === "switchSceneLayerActor") {
    return { actor: host.canInvokeOwner(target) ? host.services.switchSceneLayerActor?.(target, args.index) ?? null : null };
  }
  if (target instanceof Actor && name === "getCurrentSceneLayerActor") {
    return { actor: host.services.getCurrentSceneLayerActor?.(target) ?? null };
  }
  const component = asActorComponent(target);
  if (!component || !name) return {};
  if (component.classId === "2DRichTextComponent" &&
    (name === "triggerAppear" || name === "play" || name === "playReverse")) {
    if (host.canInvokeOwner(component)) host.services.text2DAppear?.(component, name);
    return {};
  }
  if (name === "setFocusTarget") return { success: host.canInvokeOwner(component) && host.services.setFocusTarget?.(component) === true };
  if (name === "clearFocusTarget") {
    if (host.canInvokeOwner(component)) host.services.clearFocusTarget?.(component);
    return {};
  }
  if (name.startsWith("painter")) return { success: host.canInvokeOwner(component) && host.services.paint2D?.(component, name, args) === true };
  if (isUIControl2DClass(component.classId)) return { success: host.canInvokeOwner(component) && host.services.uiControlFunction?.(component, name, args) === true };
  if (component.classId === "DynamicRuntimeMeshComponent") {
    if (!host.canInvokeOwner(component)) return { success: false };
    return host.services.dynamicMeshFunction?.(component, name, args) ?? { success: false };
  }
  if (component.classId === "DeformerComponent" &&
    (name === "setDeformerControlPointOffset" || name === "resetDeformerControlPoints")) {
    if (!host.canInvokeOwner(component)) return { success: false };
    const properties = parseDeformerProperties({ resolution: component.getVariable("resolution"), offsets: component.getVariable("offsets") });
    if (name === "resetDeformerControlPoints") properties.offsets.fill(0);
    else {
      const index = args.index;
      const value = args.offset;
      const offset = Array.isArray(value) ? value : value && typeof value === "object"
        ? [(value as Record<string, unknown>).x, (value as Record<string, unknown>).y, (value as Record<string, unknown>).z] : [];
      if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= properties.offsets.length / 3 ||
        ![0, 1, 2].every((axis) => typeof offset[axis] === "number" && Number.isFinite(offset[axis]) && Math.abs(offset[axis]) <= DEFORMER_MAX_COORDINATE)) return { success: false };
      for (const axis of [0, 1, 2]) properties.offsets[index * 3 + axis] = offset[axis] as number;
    }
    component.setVariable("offsets", properties.offsets);
    host.applyComponentVariable(component, "offsets", properties.offsets);
    return { success: true };
  }
  if (component.classId === "SplineComponent") {
    const result = splineComponentFunction(component, name, args);
    if (result) return result;
  }
  if (component.classId === "MovementComponent") {
    if (!host.canInvokeOwner(component)) return {};
    return host.services.movementFunction?.(component, name, args) ?? {};
  }
  // Property writes apply while the owner loads, like Set Variable; its
  // events wait for admission. A destroyed component takes no write.
  if (component.destroyed) return {};
  if (name === "setText") {
    const text = String(args.text ?? "");
    const previous = component.getVariable("text");
    component.setVariable("text", text);
    host.applyComponentVariable(component, "text", text, previous);
    return {};
  }
  if (name === "setConstraintTarget" && component.classId === "PhysicsConstraintComponent") {
    const actor = asActor(args.actor);
    if (args.actor != null && (!actor || actor.destroyed)) return {};
    const targetActorId = actor?.guid ?? "";
    component.setVariable("targetActorId", targetActorId);
    host.applyComponentVariable(component, "targetActorId", targetActorId);
    return {};
  }
  // Playback, camera, physics and navigation calls need an admitted owner.
  if (!host.canInvokeOwner(component)) return {};
  if (name === "playAudio") {
    const owner = component.owner;
    const assetGuid = component.getVariable("audioAssetGuid");
    if (typeof assetGuid === "string" && assetGuid && owner) {
      host.services.playSound?.(assetGuid, Number(component.getVariable("volume") ?? 1), {
        emitterActorGuid: owner.guid,
        loop: component.getVariable("loop") === true,
        voiceId: component.guid,
      });
    }
    return {};
  }
  if (name === "stopAudio") {
    host.services.stopSound?.(component.guid);
    return {};
  }
  if (name === "playParticles" && component.owner) {
    host.services.setParticlePlaying?.(
      component.owner.guid,
      true,
      component.guid,
    );
    return {};
  }
  if (name === "stopParticles" && component.owner) {
    host.services.setParticlePlaying?.(
      component.owner.guid,
      false,
      component.guid,
    );
    return {};
  }
  if (name === "possessCamera" && component.owner) {
    host.services.possessCamera?.(component.owner);
    return {};
  }
  if (name === "addImpulse" && component.owner) {
    const impulse = vec3Arg(args.impulse);
    host.services.addImpulse?.(
      component.owner,
      impulse,
      Number(args.strength ?? 1),
    );
    return {};
  }
  if (name === "moveTo" && component.owner) {
    host.services.moveTo?.(component.owner, vec3Arg(args.destination));
    return {};
  }
  if (name === "stopMovement" && component.owner) {
    host.services.stopMovement?.(component.owner);
    return {};
  }
  return {};
}
