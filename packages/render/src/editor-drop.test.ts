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

function setup(actors: SerializedActor[]) {
  const handle = createTestEngine();
  handles.push(handle);
  const sceneData: SerializedScene = { ...createDefaultScene(), actors };
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
    expect(result.position[0]).toBeCloseTo(-3.875);
    expect(result.position[1]).toBeCloseTo(0);
    expect(result.rotation).toEqual(child.transform.rotation);
    expect(result.scale).toEqual(child.transform.scale);
    const rotated = new Vector3(...result.position).scale(2);
    rotated.rotateByQuaternionToRef(new Quaternion(...parent.transform.rotation), rotated);
    expect(rotated.y + 10).toBeCloseTo(2.25);
  });
});
