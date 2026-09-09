import { afterEach, describe, expect, it } from "vitest";
import { Quaternion, Vector3 } from "@babylonjs/core";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  identitySerializedTransform,
  type SerializedActor,
  type SerializedScene,
} from "@babylonslate/core";
import { createTestEngine } from "./create-null-engine";
import { EditorSceneSync } from "./editor-scene-sync";
import { calculateEditorDropTransforms } from "./editor-drop";
import type { MeshAssetContext } from "./mesh-assets";
import type { ColliderShape } from "@babylonslate/physics";
import { createDefaultSpritePayload, emptyChunkTiles, normalizeTilemapPayload, normalizeTilesetPayload } from "@babylonslate/assets";

const handles: ReturnType<typeof createTestEngine>[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) {
    handle.scene.dispose();
    handle.engine.dispose();
  }
});

function box(id: string, position: [number, number, number]): SerializedActor {
  return createActor(id, id, {
    transform: { ...identitySerializedTransform(), position },
    components: [createMeshComponent(`${id}-mesh`, "box")],
  });
}

function setup(actors: SerializedActor[], assets?: MeshAssetContext, world: "3d" | "2d" = "3d") {
  const handle = createTestEngine();
  handles.push(handle);
  const sceneData: SerializedScene = { ...createDefaultScene(), actors };
  sceneData.settings.physicsWorld = world;
  const sync = new EditorSceneSync(handle.scene);
  sync.apply(sceneData);
  return {
    sync,
    sceneData,
    drop: (selectedActorIds: readonly string[]) =>
      calculateEditorDropTransforms({
        sceneData,
        selectedActorIds,
        meshForActor: (id) => sync.meshForActor(id),
        assets,
      }),
  };
}

describe("editor Drop", () => {
  it("lands each object's bottom on its nearest collision surface without mutating the viewport", () => {
    const { drop, sync, sceneData } = setup([
      box("left", [0, 10, 0]),
      box("right", [4, 15, 0]),
      box("lower", [0, -3, 0]),
      box("left-floor", [0, 0, 0]),
      box("right-floor", [4, 2, 0]),
    ]);
    const before = structuredClone(sceneData);
    const transforms = drop(["left", "right"]);
    expect(transforms.map(({ actorId, position }) => ({ actorId, position }))).toEqual([
      { actorId: "left", position: [0, 1.5, 0] },
      { actorId: "right", position: [4, 3.5, 0] },
    ]);
    expect(drop(["right", "left"])).toEqual(transforms);
    expect(sceneData).toEqual(before);
    expect(sync.meshForActor("left")!.position.y).toBe(10);
  });

  it("accounts for geometry offset from the actor pivot", () => {
    const raised = box("raised", [0, 10, 0]);
    raised.components[0]!.transform!.position = [0, 2, 0];
    expect(setup([raised, box("floor", [0, 0, 0])]).drop(["raised"])[0]?.position)
      .toEqual([0, -0.5, 0]);
  });

  it.each([
    { height: 10001.499, moves: true },
    { height: 10001.5, moves: false },
    { height: 10001.501, moves: false },
  ])("requires a surface strictly less than 10,000 below the bottom: $height", ({ height, moves }) => {
    const { drop } = setup([box("selected", [0, height, 0]), box("floor", [0, 0, 0])]);
    const result = drop(["selected"]);
    expect(result).toHaveLength(moves ? 1 : 0);
    if (moves) expect(result[0]!.position[1]).toBeCloseTo(1.5);
  });

  it("ignores triggers and disabled mesh collision but accepts an invisible locked collider", () => {
    const ignored = box("disabled", [0, 6, 0]);
    ignored.components[0]!.properties.collisionMode = "none";
    const trigger = createActor("trigger", "Trigger", {
      transform: { ...identitySerializedTransform(), position: [0, 5, 0] },
      components: [{ id: "trigger-shape", classId: "ColliderComponent", properties: {
        shape: { kind: "box", halfExtents: { x: 2, y: 0.5, z: 2 } }, isTrigger: true,
      } }],
    });
    const support = createActor("support", "Support", {
      visible: false, locked: true,
      transform: { ...identitySerializedTransform(), position: [0, 2, 0] },
      components: [{ id: "shape", classId: "ColliderComponent", properties: {
        shape: { kind: "box", halfExtents: { x: 2, y: 2, z: 2 } },
      } }],
    });
    expect(setup([box("selected", [0, 10, 0]), ignored, trigger, support]).drop(["selected"])[0]?.position)
      .toEqual([0, 4.75, 0]);
  });

  it("keeps a selected child at its original world position when only its parent finds a surface", () => {
    const parent = createActor("parent", "Parent", {
      transform: { ...identitySerializedTransform(), position: [0, 10, 0] },
      components: [],
    });
    const child = { ...box("child", [4, 5, 0]), parentId: "parent" };
    const { drop } = setup([parent, child, box("floor", [0, 0, 0])]);
    expect(drop(["child", "parent"]).map(({ actorId, position }) => ({ actorId, position })))
      .toEqual([
        { actorId: "parent", position: [0, 0.75, 0] },
        { actorId: "child", position: [4, 14.25, 0] },
      ]);
  });

  it("translates in world -Y under a rotated and scaled parent while preserving local rotation and scale", () => {
    const parent = createActor("parent", "Parent", {
      transform: {
        position: [0, 10, 0], rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2], scale: [2, 2, 2],
      }, components: [],
    });
    const child = { ...box("child", [0, 0, 0]), parentId: "parent" };
    const { drop } = setup([parent, child, box("floor", [0, 0, 0])]);
    const result = drop(["child"])[0]!;
    expect(result).toBeDefined();
    expect(result.position[0]).toBeCloseTo(-3.875);
    expect(result.position[1]).toBeCloseTo(0);
    expect(result.rotation).toEqual(child.transform.rotation);
    expect(result.scale).toEqual(child.transform.scale);
    const rotated = new Vector3(...result.position).scale(2);
    rotated.rotateByQuaternionToRef(new Quaternion(...parent.transform.rotation), rotated);
    expect(rotated.y + 10).toBeCloseTo(2.25);
  });

  it.each<{ shape: ColliderShape; x: number; y: number }>([
    { shape: { kind: "sphere", radius: 2 }, x: 1, y: Math.sqrt(3) + 0.75 },
    { shape: { kind: "capsule", radius: 1, halfHeight: 2 }, x: 0.5, y: 2 + Math.sqrt(0.75) + 0.75 },
    { shape: { kind: "cylinder", radius: 2, height: 4 }, x: 1, y: 2.75 },
    { shape: { kind: "mesh", vertices: [
      { x: -2, y: 0, z: -2 }, { x: 2, y: 0, z: -2 }, { x: 0, y: 2, z: 2 },
    ], indices: [0, 1, 2] }, x: 0, y: 1.75 },
    { shape: { kind: "convex", points: [
      { x: -2, y: 0, z: -2 }, { x: 2, y: 0, z: -2 }, { x: -2, y: 0, z: 2 },
      { x: 2, y: 0, z: 2 }, { x: -2, y: 2, z: -2 }, { x: -2, y: 2, z: 2 },
    ] }, x: 0, y: 1.75 },
  ])("hits configured $shape.kind geometry rather than its bounding box", ({ shape, x, y }) => {
    const surface = createActor("support", "Support", { components: [
      { id: "shape", classId: "ColliderComponent", properties: { shape } },
    ] });
    const result = setup([box("selected", [x, 10, 0]), surface]).drop(["selected"]);
    expect(result).toHaveLength(1);
    expect(result[0]!.position[1]).toBeCloseTo(y);
  });

  it("uses authored model simple hull transforms and Blocking Volumes as surfaces", () => {
    const model = createActor("model", "Model", { components: [{
      ...createMeshComponent("model-mesh", "box"),
      properties: { assetGuid: "model-guid", collisionMode: "simple" },
    }] });
    const volume = createActor("volume", "Volume", {
      transform: { position: [4, 2, 0], rotation: [0, 0, 0, 1], scale: [2, 4, 2] },
      components: [{ id: "volume-shape", classId: "BlockingVolumeComponent", properties: {} }],
    });
    const { drop } = setup([box("left", [0, 10, 0]), box("right", [4, 10, 0]), model, volume], {
      modelPayloads: new Map([["model-guid", {
        materialSlots: [], clipNames: [], skeletonGuid: null, importScale: 1,
        simpleColliders: [{ id: "hull", name: "Hull", kind: "sphere", radius: 1,
          position: [0, 5, 0], rotation: [0, 0, 0, 1], scale: [2, 2, 2] }],
      }]]),
    });
    expect(drop(["left", "right"]).map((entry) => entry.position)).toEqual([
      [0, 7.75, 0], [4, 4.75, 0],
    ]);
  });

  it("uses 2D authored chains and ignores render-only mesh surfaces in a 2D physics world", () => {
    const support = createActor("support", "Support", { components: [{
      id: "chain", classId: "ColliderComponent", properties: {
        shape: { kind: "chain", points: [{ x: -2, y: 1 }, { x: 2, y: 3 }] },
      },
    }] });
    const { drop } = setup([box("selected", [0, 10, 0]), box("visual", [0, 6, 0]), support], undefined, "2d");
    expect(drop(["selected"])[0]?.position).toEqual([0, 2.75, 0]);
  });

  it("matches runtime sphere radius baking under nonuniform scale", () => {
    const surface = createActor("support", "Support", {
      transform: { ...identitySerializedTransform(), scale: [2, 1, 1] },
      components: [{ id: "shape", classId: "ColliderComponent", properties: { shape: { kind: "sphere", radius: 1 } } }],
    });
    expect(setup([box("selected", [0, 10, 0]), surface]).drop(["selected"])[0]?.position).toEqual([0, 2.75, 0]);
  });

  it("does not drop downward through a collider that already encloses the object's bottom", () => {
    const enclosing = createActor("enclosing", "Enclosing", { components: [{ id: "shape", classId: "ColliderComponent", properties: {
      shape: { kind: "convex", points: [-2, 2].flatMap((x) => [-2, 2].flatMap((y) => [-2, 2].map((z) => ({ x, y, z })))) },
    } }] });
    expect(setup([box("selected", [0, 1, 0]), enclosing, box("floor", [0, -5, 0])]).drop(["selected"])).toEqual([]);
  });

  it("excludes the prefab pivot helper and safely skips singular parent transforms", () => {
    const helper = createActor("prefab-root", "Prefab Root", { components: [createMeshComponent("marker", "pivot")] });
    const parent = createActor("flat-parent", "Parent", { components: [], transform: { ...identitySerializedTransform(), scale: [0, 1, 1] } });
    const child = { ...box("child", [4, 10, 0]), parentId: "flat-parent" };
    expect(setup([box("selected", [0, 10, 0]), helper, parent, child]).drop(["selected", "child"])).toEqual([]);
  });

  it("requires a non-trigger box2d collider for Sprite AABB collision", () => {
    const sprite = createDefaultSpritePayload();
    const surface = createActor("sprite", "Sprite", { components: [{ id: "sprite-visual", classId: "SpriteComponent", properties: { assetGuid: "sprite-guid" } }] });
    const assets = { spritePayloads: new Map([["sprite-guid", sprite]]) };
    expect(setup([box("selected", [0, 10, 0]), surface], assets, "2d").drop(["selected"])).toEqual([]);
    surface.components.push({ id: "shape", classId: "ColliderComponent", properties: { isTrigger: true, shape: { kind: "box2d" } } });
    expect(setup([box("selected", [0, 10, 0]), surface], assets, "2d").drop(["selected"])).toEqual([]);
    surface.components[1]!.properties.isTrigger = false;
    surface.components[1]!.transform = { ...identitySerializedTransform(), position: [0, 2, 0] };
    expect(setup([box("selected", [0, 10, 0]), surface], assets, "2d").drop(["selected"])[0]?.position).toEqual([0, 3.25, 0]);
  });

  it("drops onto authored tilemap collision chains", () => {
    const tiles = emptyChunkTiles(2); tiles[0] = 1;
    const tilemap = normalizeTilemapPayload({ tilesetGuid: "set", tileWidth: 100, tileHeight: 100, chunkSize: 2,
      layers: [{ id: "ground", name: "Ground", collision: true, chunks: [{ cx: 0, cy: 0, tiles }] }] });
    const surface = createActor("tiles", "Tiles", { components: [{ id: "tilemap", classId: "TilemapComponent", properties: { assetGuid: "map" } }] });
    const result = setup([box("selected", [0.5, 10, 0]), surface], {
      tilemaps: new Map([["map", tilemap]]), tilesets: new Map([["set", normalizeTilesetPayload({ tiles: [{ id: 1, collision: "full" }] })]]),
    }, "2d").drop(["selected"]);
    expect(result[0]?.position).toEqual([0.5, 1.75, 0]);
  });
});
