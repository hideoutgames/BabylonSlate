import { afterEach, describe, expect, it } from "vitest";
import { Matrix, Quaternion, Vector3 } from "@babylonjs/core";
import {
  createActor,
  createDefaultScene,
  createMeshComponent,
  identitySerializedTransform,
  type SerializedScene,
  type SerializedTransform,
} from "@babylonslate/core";
import { createTestEngine } from "./create-null-engine";
import { EditorSceneSync } from "./editor-scene-sync";
import {
  applyGizmoMultiSelectDrag,
  applyWorldDeltaToMesh,
  beginGizmoMultiSelectDrag,
  pickGizmoAttachActorId,
  readMeshLocalTransform,
  selectionGizmoRoots,
  worldDelta,
} from "./gizmo-multi-select";

const handles: Array<{
  engine: { dispose: () => void };
  scene: { dispose: () => void };
}> = [];

function createHandle() {
  const handle = createTestEngine();
  handles.push(handle);
  return handle;
}

function pose(position: [number, number, number]): SerializedTransform {
  return { ...identitySerializedTransform(), position };
}

function sceneWith(actors: SerializedScene["actors"]): SerializedScene {
  return { ...createDefaultScene(), actors };
}

afterEach(() => {
  while (handles.length > 0) {
    const handle = handles.pop();
    handle?.scene.dispose();
    handle?.engine.dispose();
  }
});

describe("selectionGizmoRoots", () => {
  const parentIdOf = (id: string) =>
    ({ child: "parent", grandchild: "child" })[id] ?? null;

  it("keeps siblings and drops selected descendants", () => {
    expect(
      selectionGizmoRoots(["parent", "child", "other"], parentIdOf),
    ).toEqual(["parent", "other"]);
  });

  it("keeps a child when its parent is not selected", () => {
    expect(selectionGizmoRoots(["child", "other"], parentIdOf)).toEqual([
      "child",
      "other",
    ]);
  });

  it("drops a grandchild when any ancestor is selected", () => {
    expect(selectionGizmoRoots(["parent", "grandchild"], parentIdOf)).toEqual([
      "parent",
    ]);
  });
});

describe("pickGizmoAttachActorId", () => {
  it("attaches to the first pickable selection root, not a selected child", () => {
    const parentIdOf = (id: string) => (id === "child" ? "parent" : null);
    expect(
      pickGizmoAttachActorId(
        ["child", "parent"],
        parentIdOf,
        () => true,
      ),
    ).toBe("parent");
  });

  it("skips an unpickable root", () => {
    expect(
      pickGizmoAttachActorId(
        ["locked", "free"],
        () => null,
        (id) => id === "free",
      ),
    ).toBe("free");
  });
});

describe("world-delta follow", () => {
  it("translates a sibling by the same world delta as the attached mesh", () => {
    const { scene } = createHandle();
    const sync = new EditorSceneSync(scene);
    sync.apply(
      sceneWith([
        createActor("a", "A", {
          transform: pose([0, 0, 0]),
          components: [createMeshComponent("ca", "box")],
        }),
        createActor("b", "B", {
          transform: pose([3, 0, 0]),
          components: [createMeshComponent("cb", "box")],
        }),
      ]),
    );
    const a = sync.meshForActor("a")!;
    const b = sync.meshForActor("b")!;
    a.computeWorldMatrix(true);
    b.computeWorldMatrix(true);
    const startA = a.getWorldMatrix().clone();
    const startB = b.getWorldMatrix().clone();

    a.position.x += 2;
    a.computeWorldMatrix(true);
    applyWorldDeltaToMesh(b, startB, worldDelta(startA, a.getWorldMatrix()));
    b.computeWorldMatrix(true);

    expect(b.getAbsolutePosition().x).toBeCloseTo(5);
    expect(b.getAbsolutePosition().y).toBeCloseTo(0);
  });

  it("orbits a follower when the pivot rotates 90 degrees about Y", () => {
    const { scene } = createHandle();
    const sync = new EditorSceneSync(scene);
    sync.apply(
      sceneWith([
        createActor("a", "A", {
          transform: pose([0, 0, 0]),
          components: [createMeshComponent("ca", "box")],
        }),
        createActor("b", "B", {
          transform: pose([2, 0, 0]),
          components: [createMeshComponent("cb", "box")],
        }),
      ]),
    );
    const a = sync.meshForActor("a")!;
    const b = sync.meshForActor("b")!;
    a.computeWorldMatrix(true);
    b.computeWorldMatrix(true);
    const startA = a.getWorldMatrix().clone();
    const startB = b.getWorldMatrix().clone();

    a.rotationQuaternion = Quaternion.RotationAxis(Vector3.Up(), Math.PI / 2);
    a.computeWorldMatrix(true);
    applyWorldDeltaToMesh(b, startB, worldDelta(startA, a.getWorldMatrix()));
    b.computeWorldMatrix(true);

    const expected = Vector3.Zero();
    new Vector3(2, 0, 0).rotateByQuaternionToRef(
      Quaternion.RotationAxis(Vector3.Up(), Math.PI / 2),
      expected,
    );
    expect(b.getAbsolutePosition().x).toBeCloseTo(expected.x, 4);
    expect(b.getAbsolutePosition().z).toBeCloseTo(expected.z, 4);
    expect(b.position.length()).toBeCloseTo(2, 4);
  });

  it("does not rewrite a selected child's local TRS when the parent is also selected", () => {
    const { scene } = createHandle();
    const sync = new EditorSceneSync(scene);
    sync.apply(
      sceneWith([
        createActor("parent", "Parent", {
          transform: pose([0, 0, 0]),
          components: [createMeshComponent("cp", "box")],
        }),
        createActor("child", "Child", {
          parentId: "parent",
          transform: pose([3, 0, 0]),
          components: [createMeshComponent("cc", "box")],
        }),
      ]),
    );
    const parent = sync.meshForActor("parent")!;
    const child = sync.meshForActor("child")!;
    const parentIdOf = (id: string) => (id === "child" ? "parent" : null);
    expect(selectionGizmoRoots(["parent", "child"], parentIdOf)).toEqual([
      "parent",
    ]);

    parent.position.x += 2;
    parent.computeWorldMatrix(true);
    child.computeWorldMatrix(true);

    expect(child.position.x).toBeCloseTo(3);
    expect(child.getAbsolutePosition().x).toBeCloseTo(5);
  });

  it("updates a selected child's local TRS when the parent is not selected", () => {
    const { scene } = createHandle();
    const sync = new EditorSceneSync(scene);
    sync.apply(
      sceneWith([
        createActor("parent", "Parent", {
          transform: pose([1, 0, 0]),
          components: [createMeshComponent("cp", "box")],
        }),
        createActor("child", "Child", {
          parentId: "parent",
          transform: pose([3, 0, 0]),
          components: [createMeshComponent("cc", "box")],
        }),
      ]),
    );
    const parent = sync.meshForActor("parent")!;
    const child = sync.meshForActor("child")!;
    child.computeWorldMatrix(true);
    const startChild = child.getWorldMatrix().clone();
    const parentX = parent.position.x;

    const delta = worldDelta(Matrix.Identity(), Matrix.Translation(2, 0, 0));
    applyWorldDeltaToMesh(child, startChild, delta);
    child.computeWorldMatrix(true);

    expect(parent.position.x).toBeCloseTo(parentX);
    expect(child.position.x).toBeCloseTo(5);
    expect(child.getAbsolutePosition().x).toBeCloseTo(6);
  });

  it("begin/apply drag copies the attached mesh delta onto followers", () => {
    const { scene } = createHandle();
    const sync = new EditorSceneSync(scene);
    sync.apply(
      sceneWith([
        createActor("a", "A", {
          transform: pose([0, 1, 0]),
          components: [createMeshComponent("ca", "box")],
        }),
        createActor("b", "B", {
          transform: pose([4, 1, 0]),
          components: [createMeshComponent("cb", "box")],
        }),
      ]),
    );
    const a = sync.meshForActor("a")!;
    const b = sync.meshForActor("b")!;
    a.computeWorldMatrix(true);
    b.computeWorldMatrix(true);
    const drag = beginGizmoMultiSelectDrag(a, [b]);
    expect(drag).not.toBeNull();

    a.position.x += 1.5;
    a.position.y += 0.5;
    applyGizmoMultiSelectDrag(drag!, a);
    b.computeWorldMatrix(true);

    expect(b.getAbsolutePosition().x).toBeCloseTo(5.5);
    expect(b.getAbsolutePosition().y).toBeCloseTo(1.5);
    const local = readMeshLocalTransform(b);
    expect(local.position[0]).toBeCloseTo(5.5);
    expect(local.position[1]).toBeCloseTo(1.5);
  });
});
