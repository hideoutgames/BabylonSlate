import { describe, expect, it } from "vitest";
import {
  ADDABLE_COMPONENT_CLASSES,
  defaultPropertiesFor,
} from "./add-component-catalog";

describe("Add Component catalog", () => {
  it("lists RigidBody and Collider alongside render components", () => {
    const ids = ADDABLE_COMPONENT_CLASSES.map((entry) => entry.id);
    expect(ids).toContain("SpriteComponent");
    expect(ids).not.toContain("WidgetComponent");
    expect(ids).toContain("TilemapComponent");
    expect(ids).toContain("AnimationGraphComponent");
    expect(ids).toContain("BehaviourTreeComponent");
    expect(ids).toContain("NavAgentComponent");
    expect(ids).not.toContain("NavMeshComponent");
    expect(ids).not.toContain("NavMeshBlockerComponent");
    expect(ids).toContain("RigidBodyComponent");
    expect(ids).toContain("ColliderComponent");
  });

  it("groups addable classes into Rendering, Animation, Camera, and Physics", () => {
    const byCategory = new Map<string, string[]>();
    for (const entry of ADDABLE_COMPONENT_CLASSES) {
      const list = byCategory.get(entry.category) ?? [];
      list.push(entry.id);
      byCategory.set(entry.category, list);
    }
    expect([...byCategory.keys()]).toEqual([
      "Rendering",
      "Animation",
      "AI",
      "Camera",
      "Physics",
    ]);
    expect(byCategory.get("Rendering")).toEqual([
      "MeshComponent",
      "SpriteComponent",
      "TilemapComponent",
      "LightComponent",
    ]);
    expect(byCategory.get("UI")).toBeUndefined();
    expect(byCategory.get("Animation")).toEqual(["AnimationGraphComponent"]);
    expect(byCategory.get("AI")).toEqual([
      "BehaviourTreeComponent",
      "NavAgentComponent",
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

  it("seeds Sprite and Tilemap asset-guid defaults", () => {
    expect(defaultPropertiesFor("AnimationGraphComponent")).toEqual({
      graphGuid: null,
    });
    expect(defaultPropertiesFor("BehaviourTreeComponent")).toEqual({
      treeGuid: null,
      blackboardGuid: null,
    });
    expect(defaultPropertiesFor("NavAgentComponent")).toMatchObject({
      radius: 0.5,
      height: 2,
      maxSpeed: 3.5,
    });
    expect(defaultPropertiesFor("NavMeshBlockerComponent")).toEqual({
      dynamic: false,
      kind: "box",
      area: "unwalkable",
    });
  });

  it("seeds light range and spot outer angle", () => {
    expect(defaultPropertiesFor("LightComponent")).toEqual({
      intensity: 1,
      color: [1, 1, 1],
      lightKind: "point",
      range: 10,
      outerAngle: 45,
      innerAngle: 30,
      enabled: true,
      castShadows: false,
    });
  });

  it("seeds camera projection from the scene viewport mode", () => {
    expect(defaultPropertiesFor("CameraComponent", "3d", "3d")).toEqual({
      fieldOfView: 60,
      orthographicSize: 5,
      projectionMode: "perspective",
      nearClip: 0.1,
      farClip: 1000,
    });
    expect(defaultPropertiesFor("CameraComponent", "2d", "2d")).toMatchObject({
      projectionMode: "orthographic",
      nearClip: 0.1,
      farClip: 1000,
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
