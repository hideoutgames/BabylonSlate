import { describe, expect, it } from "vitest";
import { identityTransform, quatRotateVector } from "@babylonslate/core";
import { Actor, ActorComponent } from "@babylonslate/object-model";
import { applyTweenTransform, tweenWorldTransformDepth } from "./tween-transforms";

function fixture() {
  const parent = new Actor({ classId: "Actor", guid: "parent", transform: {
    position: { x: 10, y: 20, z: 30 },
    rotation: { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 },
    scale: { x: 2, y: 3, z: 4 },
  } });
  const actor = new Actor({ classId: "Actor", guid: "child", variables: { parentId: parent.guid } });
  const actors = new Map([[parent.guid, parent], [actor.guid, actor]]);
  return { parent, actor, find: (guid: string) => actors.get(guid) };
}

function expectScale(actual: { x: number; y: number; z: number }, expected: { x: number; y: number; z: number }): void {
  for (const axis of ["x", "y", "z"] as const) expect(actual[axis]).toBeCloseTo(expected[axis], 9);
}

describe("tween transform writes", () => {
  it("reads live actor and component ancestry when ordering world transform writes", () => {
    const { parent, actor, find } = fixture();
    const component = new ActorComponent({ classId: "MeshComponent", guid: "mesh", sourceId: "authored-mesh" });
    const nested = new ActorComponent({ classId: "CameraComponent", parentId: component.sourceId });
    actor.attachComponent(component);
    actor.attachComponent(nested);
    expect(tweenWorldTransformDepth(parent, find)).toBe(0);
    expect(tweenWorldTransformDepth(actor, find)).toBe(1);
    expect(tweenWorldTransformDepth(component, find)).toBe(2);
    expect(tweenWorldTransformDepth(nested, find)).toBe(3);
    actor.setVariable("parentId", null);
    nested.parentId = null;
    expect(tweenWorldTransformDepth(nested, find)).toBe(1);
    component.parentId = nested.guid;
    nested.parentId = component.guid;
    expect(tweenWorldTransformDepth(nested, find)).toBeNull();
    actor.setVariable("parentId", parent.guid);
    parent.setVariable("parentId", actor.guid);
    expect(tweenWorldTransformDepth(actor, find)).toBeNull();
  });

  it.each(["2DAnchorComponent", "MovementComponent"])("refuses nonspatial %s transform writes", (classId) => {
    const { actor, find } = fixture();
    const component = new ActorComponent({ classId });
    actor.attachComponent(component);
    expect(applyTweenTransform(component, "position", { x: 1, y: 2, z: 3 }, "local", find)).toBe(false);
    expect(applyTweenTransform(component, "transform", { ...identityTransform(), position: { x: 1, y: 2, z: 3 } }, "world", find)).toBe(false);
    expect(component.transform).toEqual(identityTransform());
    expect(tweenWorldTransformDepth(component, find)).toBeNull();
  });

  it("converts world positions through current parent translation, rotation and scale on every sample", () => {
    const { parent, actor, find } = fixture();
    const rotation = actor.transform.rotation;
    expect(applyTweenTransform(actor, "position", { x: 22, y: 26, z: 28 }, "world", find)).toBe(true);
    expect(actor.transform.position.x).toBeCloseTo(1);
    expect(actor.transform.position.y).toBeCloseTo(2);
    expect(actor.transform.position.z).toBeCloseTo(3);
    parent.transform.position.x = 14;
    expect(applyTweenTransform(actor, "position", { x: 22, y: 26, z: 28 }, "world", find)).toBe(true);
    expect(actor.transform.position.x).toBeCloseTo(1);
    expect(actor.transform.position.z).toBeCloseTo(2);
    expect(actor.transform.rotation).toBe(rotation);
  });

  it("converts world rotation and scale independently while preserving other channels", () => {
    const { actor, find } = fixture();
    const position = actor.transform.position;
    expect(applyTweenTransform(actor, "rotation", { pitch: 0, yaw: 180, roll: 0 }, "world", find)).toBe(true);
    const direction = quatRotateVector(actor.transform.rotation, { x: 0, y: 0, z: 1 });
    expect(direction.x).toBeCloseTo(1);
    expect(direction.z).toBeCloseTo(0);
    expect(applyTweenTransform(actor, "scale", { x: 8, y: 9, z: 8 }, "world", find)).toBe(true);
    // The child's quarter turn about Y applies the parent's Z scale (4) on
    // its X axis and the parent's X scale (2) on its Z axis.
    expectScale(actor.transform.scale, { x: 2, y: 3, z: 4 });
    expect(actor.transform.position).toBe(position);
    expect(position).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("places a nested component through its actor and the live Spring Arm socket", () => {
    const actor = new Actor({ classId: "Actor", guid: "cameraActor", transform: {
      ...identityTransform(), position: { x: 10, y: 0, z: 0 }, scale: { x: 2, y: 2, z: 2 },
    } });
    const arm = new ActorComponent({ classId: "SpringArmComponent", guid: "arm", variables: { armLength: 4 }, transform: {
      ...identityTransform(), position: { x: 3, y: 0, z: 0 },
    } });
    const camera = new ActorComponent({ classId: "CameraComponent", parentId: arm.guid });
    actor.attachComponent(arm);
    actor.attachComponent(camera);
    const find = (guid: string) => guid === actor.guid ? actor : undefined;
    expect(applyTweenTransform(camera, "position", { x: 20, y: 6, z: -4 }, "world", find)).toBe(true);
    expect(camera.transform.position).toEqual({ x: 2, y: 3, z: 2 });
    arm.setVariable("armLength", 6);
    expect(applyTweenTransform(camera, "position", { x: 20, y: 6, z: -4 }, "world", find)).toBe(true);
    expect(camera.transform.position).toEqual({ x: 2, y: 3, z: 4 });
  });

  it("applies a complete local component transform and a complete world actor transform atomically", () => {
    const { actor, find } = fixture();
    const component = new ActorComponent({ classId: "MeshComponent" });
    actor.attachComponent(component);
    const pose = { position: { x: 22, y: 26, z: 28 }, rotation: { x: 0, y: 1, z: 0, w: 0 }, scale: { x: 8, y: 9, z: 8 } };
    expect(applyTweenTransform(component, "transform", pose, "local", find)).toBe(true);
    expect(component.transform).toEqual(pose);
    expect(applyTweenTransform(actor, "transform", pose, "world", find)).toBe(true);
    expect(actor.transform.position.x).toBeCloseTo(1);
    expect(actor.transform.position.y).toBeCloseTo(2);
    expect(actor.transform.position.z).toBeCloseTo(3);
    expect(actor.transform.rotation.y).toBeCloseTo(Math.SQRT1_2);
    expect(actor.transform.rotation.w).toBeCloseTo(Math.SQRT1_2);
    expectScale(actor.transform.scale, { x: 2, y: 3, z: 4 });
    pose.position.x = 500;
    expect(component.transform.position.x).toBe(22);
  });

  it("rejects singular inverses and malformed samples without partially changing a target", () => {
    const { parent, actor, find } = fixture();
    parent.transform.scale.x = 0;
    const before = structuredClone(actor.transform);
    expect(applyTweenTransform(actor, "transform", {
      position: { x: 5, y: 6, z: 7 }, rotation: { x: 0, y: 1, z: 0, w: 0 }, scale: { x: 2, y: 2, z: 2 },
    }, "world", find)).toBe(false);
    expect(applyTweenTransform(actor, "position", { x: Infinity, y: 1, z: 2 }, "local", find)).toBe(false);
    expect(actor.transform).toEqual(before);
    expect(applyTweenTransform(actor, "position", { x: 5, y: 6, z: 7 }, "local", find)).toBe(true);
    expect(actor.transform.position).toEqual({ x: 5, y: 6, z: 7 });
  });

  it("refuses stale targets, cyclic parents and nonspatial SceneLayer anchor carriers", () => {
    const { actor, parent, find } = fixture();
    const value = { x: 1, y: 2, z: 3 };
    const stale = new Actor({ classId: "Actor", guid: actor.guid });
    expect(applyTweenTransform(stale, "position", value, "local", find)).toBe(false);
    parent.setVariable("parentId", actor.guid);
    expect(applyTweenTransform(actor, "position", value, "world", find)).toBe(false);
    parent.setVariable("parentId", null);
    const component = new ActorComponent({ classId: "MeshComponent", guid: "mesh" });
    actor.attachComponent(component);
    component.parentId = component.guid;
    expect(applyTweenTransform(component, "position", value, "world", find)).toBe(false);
    component.destroyed = true;
    expect(applyTweenTransform(component, "position", value, "local", find)).toBe(false);
    const anchor = new ActorComponent({ classId: "2DAnchorComponent" });
    parent.attachComponent(anchor);
    expect(applyTweenTransform(parent, "position", value, "local", find)).toBe(false);
    expect(actor.transform).toEqual(identityTransform());
  });
});
