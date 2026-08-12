import { describe, expect, it } from "vitest";
import {
  ADDABLE_COMPONENT_CLASSES,
  defaultPropertiesFor,
} from "./add-component-catalog";

describe("Add Component catalog", () => {
  it("lists RigidBody and Collider alongside render components", () => {
    const ids = ADDABLE_COMPONENT_CLASSES.map((entry) => entry.id);
    expect(ids).toContain("MeshComponent");
    expect(ids).toContain("RigidBodyComponent");
    expect(ids).toContain("ColliderComponent");
  });

  it("groups addable classes into Rendering, Camera, and Physics", () => {
    const byCategory = new Map<string, string[]>();
    for (const entry of ADDABLE_COMPONENT_CLASSES) {
      const list = byCategory.get(entry.category) ?? [];
      list.push(entry.id);
      byCategory.set(entry.category, list);
    }
    expect([...byCategory.keys()]).toEqual(["Rendering", "Camera", "Physics"]);
    expect(byCategory.get("Rendering")).toEqual([
      "MeshComponent",
      "SpriteComponent",
      "LightComponent",
    ]);
    expect(byCategory.get("Camera")).toEqual(["CameraComponent"]);
    expect(byCategory.get("Physics")).toEqual([
      "RigidBodyComponent",
      "ColliderComponent",
    ]);
  });

  it("seeds RigidBody defaults from the physics property schema", () => {
    expect(defaultPropertiesFor("RigidBodyComponent")).toEqual({
      motionType: "dynamic",
      mass: 1,
      linearDamping: 0,
      angularDamping: 0,
      gravityScale: 1,
    });
  });

  it("seeds a 3d box collider by default and a 2d box when the scene is 2d", () => {
    expect(defaultPropertiesFor("ColliderComponent", "3d")).toEqual({
      shape: { kind: "box", halfExtents: { x: 0.5, y: 0.5, z: 0.5 } },
      friction: 0.5,
      restitution: 0,
      isTrigger: false,
      layer: 1,
      mask: 4294967295,
    });
    expect(defaultPropertiesFor("ColliderComponent", "2d").shape).toEqual({
      kind: "box2d",
      halfExtents: { x: 0.5, y: 0.5 },
    });
  });
});
