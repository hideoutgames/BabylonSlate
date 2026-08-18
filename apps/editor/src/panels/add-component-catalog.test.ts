import { describe, expect, it } from "vitest";
import {
  DEFAULT_CAMERA_FIELD_OF_VIEW,
  DEFAULT_CAMERA_ORTHOGRAPHIC_SIZE,
} from "@babylonslate/core";
import {
  ADDABLE_COMPONENT_CLASSES,
  defaultPropertiesFor,
  physicsWorldFromOpenDocuments,
  prefabComponentLabel,
  projectAddComponentItems,
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
    expect(ids).toContain("AudioComponent");
    expect(ids).toContain("SkyboxComponent");
    expect(ids).toContain("ParticleComponent");
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
      "Audio",
      "Particles",
      "Physics",
    ]);
    expect(byCategory.get("Rendering")).toEqual([
      "MeshComponent",
      "SpriteComponent",
      "TilemapComponent",
      "LightComponent",
      "SkyboxComponent",
    ]);
    expect(byCategory.get("UI")).toBeUndefined();
    expect(byCategory.get("Animation")).toEqual(["AnimationGraphComponent"]);
    expect(byCategory.get("AI")).toEqual([
      "BehaviourTreeComponent",
      "NavAgentComponent",
    ]);
    expect(byCategory.get("Camera")).toEqual(["CameraComponent"]);
    expect(byCategory.get("Audio")).toEqual(["AudioComponent"]);
    expect(byCategory.get("Particles")).toEqual(["ParticleComponent"]);
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
    expect(defaultPropertiesFor("AudioComponent")).toEqual({
      audioAssetGuid: null,
      playOnStart: true,
      loop: false,
      volume: 1,
    });
    expect(defaultPropertiesFor("ParticleComponent")).toEqual({
      particleSystemGuid: null,
      playOnStart: true,
      sortingLayer: "Default",
      orderInLayer: 0,
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
    expect(defaultPropertiesFor("SkyboxComponent")).toEqual({
      size: 1000,
      faces: {
        px: null,
        py: null,
        pz: null,
        nx: null,
        ny: null,
        nz: null,
      },
    });
  });

  it("seeds camera projection from the scene viewport mode", () => {
    expect(defaultPropertiesFor("CameraComponent", "3d", "3d")).toEqual({
      fieldOfView: DEFAULT_CAMERA_FIELD_OF_VIEW,
      orthographicSize: DEFAULT_CAMERA_ORTHOGRAPHIC_SIZE,
      projectionMode: "perspective",
      nearClip: 0.1,
      farClip: 1000,
      attemptPossessViewTarget: false,
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

  it("describes Mesh as a primitive or Model asset so search finds Model", () => {
    const mesh = ADDABLE_COMPONENT_CLASSES.find(
      (entry) => entry.id === "MeshComponent",
    );
    expect(mesh?.description).toBe("Primitive or Model asset");
  });
});

function asset(header: {
  guid: string;
  name: string;
  type: string;
  parentClass?: string | null;
  path?: string;
}) {
  return {
    path: header.path,
    header: {
      guid: header.guid,
      name: header.name,
      type: header.type,
      parentClass: header.parentClass,
    },
  };
}

describe("projectAddComponentItems", () => {
  it("binds a Model asset onto MeshComponent.assetGuid", () => {
    const items = projectAddComponentItems([
      asset({ guid: "hero", name: "Hero", type: "Model" }),
    ]);
    expect(items).toEqual([
      {
        id: "asset-hero",
        classId: "MeshComponent",
        label: "Hero",
        description: "Model",
        category: "Project",
        properties: { assetGuid: "hero" },
      },
    ]);
  });

  it("binds Audio, ParticleSystem, Sprite, Tilemap, AnimationGraph, and BehaviourTree", () => {
    const items = projectAddComponentItems([
      asset({ guid: "beep", name: "Beep", type: "Audio" }),
      asset({ guid: "fx", name: "Fire", type: "ParticleSystem" }),
      asset({ guid: "spr", name: "HeroSprite", type: "Sprite" }),
      asset({ guid: "map", name: "Dungeon", type: "Tilemap" }),
      asset({ guid: "anim", name: "Locomotion", type: "AnimationGraph" }),
      asset({ guid: "bt", name: "Guard", type: "BehaviourTree" }),
    ]);
    expect(
      items.map((item) => ({
        id: item.id,
        classId: item.classId,
        properties: item.properties,
      })),
    ).toEqual([
      {
        id: "asset-beep",
        classId: "AudioComponent",
        properties: { audioAssetGuid: "beep" },
      },
      {
        id: "asset-fx",
        classId: "ParticleComponent",
        properties: { particleSystemGuid: "fx" },
      },
      {
        id: "asset-spr",
        classId: "SpriteComponent",
        properties: { assetGuid: "spr" },
      },
      {
        id: "asset-map",
        classId: "TilemapComponent",
        properties: { assetGuid: "map" },
      },
      {
        id: "asset-anim",
        classId: "AnimationGraphComponent",
        properties: { graphGuid: "anim" },
      },
      {
        id: "asset-bt",
        classId: "BehaviourTreeComponent",
        properties: { treeGuid: "bt" },
      },
    ]);
  });

  it("binds a legacy Mesh type onto MeshComponent.assetGuid", () => {
    const items = projectAddComponentItems([
      asset({ guid: "rock", name: "Rock", type: "Mesh" }),
    ]);
    expect(items[0]).toMatchObject({
      classId: "MeshComponent",
      properties: { assetGuid: "rock" },
    });
  });

  it("includes user ActorComponent classes and excludes Actor classes", () => {
    const items = projectAddComponentItems([
      asset({
        guid: "health",
        name: "Health",
        type: "Class",
        parentClass: "ActorComponent",
        path: "assets/Health.class.babasset",
      }),
      asset({
        guid: "hero",
        name: "Hero",
        type: "Class",
        parentClass: "Actor",
        path: "assets/Hero.class.babasset",
      }),
      asset({
        guid: "stats",
        name: "Stats",
        type: "Class",
        parentClass: "BObject",
        path: "assets/Stats.class.babasset",
      }),
    ]);
    expect(items.map((item) => item.classId)).toEqual(["Health"]);
    expect(items[0]).toMatchObject({
      id: "class-Health",
      label: "Health",
      description: "Actor Component",
      category: "Project",
    });
  });

  it("includes a nested ActorComponent subclass and skips engine-locked ids", () => {
    const items = projectAddComponentItems([
      asset({
        guid: "base",
        name: "Health",
        type: "Class",
        parentClass: "ActorComponent",
        path: "assets/Health.class.babasset",
      }),
      asset({
        guid: "child",
        name: "RegenHealth",
        type: "Class",
        parentClass: "Health",
        path: "assets/RegenHealth.class.babasset",
      }),
    ]);
    expect(items.map((item) => item.classId).sort()).toEqual([
      "Health",
      "RegenHealth",
    ]);
  });

  it("omits textures and classes whose ancestry is a hidden engine component", () => {
    const items = projectAddComponentItems([
      asset({ guid: "tex", name: "Grass", type: "Texture" }),
      asset({
        guid: "ui",
        name: "Hud",
        type: "Class",
        parentClass: "WidgetComponent",
        path: "assets/Hud.class.babasset",
      }),
      asset({
        guid: "nav",
        name: "RoomNav",
        type: "Class",
        parentClass: "NavMeshComponent",
        path: "assets/RoomNav.class.babasset",
      }),
    ]);
    expect(items.map((item) => item.classId)).toEqual([]);
  });
});

describe("prefabComponentLabel", () => {
  it("uses the catalog Title Case label for engine class ids", () => {
    expect(
      prefabComponentLabel({ classId: "MeshComponent", properties: {} }),
    ).toBe("Mesh");
  });

  it("appends the bound asset name when a guid property is set", () => {
    expect(
      prefabComponentLabel(
        { classId: "MeshComponent", properties: { assetGuid: "hero" } },
        (guid) => (guid === "hero" ? "Hero" : undefined),
      ),
    ).toBe("Mesh (Hero)");
  });

  it("title-cases a user ActorComponent class id", () => {
    expect(prefabComponentLabel({ classId: "RegenHealth", properties: {} })).toBe(
      "Regen Health",
    );
  });
});

describe("physicsWorldFromOpenDocuments", () => {
  it("reads 2d from an open scene and otherwise defaults to 3d", () => {
    expect(physicsWorldFromOpenDocuments([])).toBe("3d");
    expect(
      physicsWorldFromOpenDocuments([
        {
          ref: { kind: "scene" },
          content: { settings: { physicsWorld: "2d" } },
        },
      ]),
    ).toBe("2d");
  });
});
