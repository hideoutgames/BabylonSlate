import { Matrix, Quaternion, Vector3, VertexBuffer, type Mesh } from "@babylonjs/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  generateNavMesh,
  initNavigation,
  navMeshDebugPrimitives,
  staticBlockerBakeParts,
} from "@haptic/navigation";

vi.mock("@haptic/navigation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@haptic/navigation")>();
  return { ...actual, navMeshDebugPrimitives: vi.fn(actual.navMeshDebugPrimitives) };
});
import { createTestEngine } from "./create-null-engine";
import {
  NAVMESH_DEBUG_Y_OFFSET,
  NavMeshDebugOverlay,
  navDebugBlockersFromActors,
} from "./nav-debug-overlay";
import { createActor } from "@haptic/core";

function groundPrism(): { positions: number[]; indices: number[] } {
  const half = 10;
  return {
    positions: [
      -half, 0, -half,
      half, 0, -half,
      half, 0, half,
      -half, 0, half,
    ],
    indices: [0, 3, 2, 0, 2, 1],
  };
}

describe("NavMeshDebugOverlay", () => {
  const handles: Array<{ engine: { dispose: () => void }; scene: { dispose: () => void } }> =
    [];

  afterEach(() => {
    while (handles.length > 0) {
      const handle = handles.pop();
      handle?.scene.dispose();
      handle?.engine.dispose();
    }
  });

  it("creates a debug mesh from baked bytes and disposes it", async () => {
    await initNavigation();
    const bytes = await generateNavMesh(groundPrism());
    const handle = createTestEngine();
    handles.push(handle);
    const overlay = new NavMeshDebugOverlay(handle.scene);
    await overlay.sync(bytes);
    expect(overlay.mesh).not.toBeNull();
    expect(overlay.mesh!.isPickable).toBe(false);
    expect(overlay.mesh!.receiveShadows).toBe(false);
    expect(overlay.mesh!.renderingGroupId).toBe(1);
    const positions = overlay.mesh!.getVerticesData(VertexBuffer.PositionKind);
    const primitives = navMeshDebugPrimitives(bytes);
    const rawY = primitives.find((primitive) => primitive.type === "tris")
      ?.vertices[0]?.[1] ?? 0;
    expect(positions?.[1]).toBeCloseTo(rawY + NAVMESH_DEBUG_Y_OFFSET, 5);
    expect(overlay.mesh!.edgesWidth).toBeGreaterThan(0);
    const material = overlay.mesh!.material;
    overlay.clear();
    expect(overlay.mesh).toBeNull();
    expect(handle.scene.materials).not.toContain(material);
    overlay.dispose();
  });

  it("maps Recast ground onto the XY plane in a 2D physics world", async () => {
    const bytes = await generateNavMesh(groundPrism());
    const handle = createTestEngine();
    handles.push(handle);
    const overlay = new NavMeshDebugOverlay(handle.scene);
    await overlay.sync(bytes, [], "2d");
    const positions = overlay.mesh!.getVerticesData(VertexBuffer.PositionKind)!;
    const xs: number[] = [];
    const ys: number[] = [];
    for (let index = 0; index < positions.length; index += 3) {
      xs.push(positions[index]!);
      ys.push(positions[index + 1]!);
      expect(positions[index + 2]).toBeCloseTo(-0.04);
    }
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(10);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(10);
    overlay.dispose();
  });

  it("does not resurrect an overlay disabled while navigation initializes", async () => {
    const bytes = await generateNavMesh(groundPrism());
    const handle = createTestEngine();
    handles.push(handle);
    const overlay = new NavMeshDebugOverlay(handle.scene);
    const pending = overlay.sync(bytes);
    overlay.clear();
    await pending;
    expect(overlay.mesh).toBeNull();
    expect(handle.scene.getMeshByName("navmeshDebug")).toBeNull();
    expect(handle.scene.materials.some((material) => material.name === "navmeshDebugMat")).toBe(false);
  });

  it("draws no navmesh fill when the bake has no walkable triangles", async () => {
    const bytes = await generateNavMesh(groundPrism());
    const handle = createTestEngine();
    handles.push(handle);
    const overlay = new NavMeshDebugOverlay(handle.scene);
    vi.mocked(navMeshDebugPrimitives).mockReturnValueOnce([]);
    await overlay.sync(bytes);
    expect(overlay.mesh).toBeNull();
    expect(handle.scene.getMeshByName("navmeshDebug")).toBeNull();
    expect(handle.scene.materials.some((material) => material.name === "navmeshDebugMat")).toBe(false);
  });

  it("draws NavMesh Blocker volumes when the overlay is on", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    const overlay = new NavMeshDebugOverlay(handle.scene);
    const world = Matrix.Compose(new Vector3(2, 3, 4), Quaternion.Identity(), new Vector3(1, 0, 2));
    await overlay.sync(null, [{ id: "door", kind: "box", world: world.asArray() }]);
    expect(overlay.mesh).toBeNull();
    expect(overlay.blockerMeshes).toHaveLength(1);
    expect(overlay.blockerMeshes[0]!.renderingGroupId).toBe(1);
    const box = worldBox(overlay.blockerMeshes[0]!);
    expectClose(box.min, [0, -1.5, 0]);
    expectClose(box.max, [2, 1.5, 4]);
    overlay.clear();
    expect(overlay.blockerMeshes).toHaveLength(0);
  });

  it("keeps the drawn overlay, and the scene's meshes and materials, when synced again with the same request", async () => {
    const bytes = await generateNavMesh(groundPrism());
    const handle = createTestEngine();
    handles.push(handle);
    const overlay = new NavMeshDebugOverlay(handle.scene);
    const door = (x: number) => ({ id: "door", kind: "box" as const, world: Matrix.Translation(x, 0, 0).asArray() });
    await overlay.sync(bytes, [door(1)]);
    const fill = overlay.mesh!;
    const blocker = overlay.blockerMeshes[0]!;
    const added = vi.fn();
    const removed = vi.fn();
    handle.scene.onNewMeshAddedObservable.add(added);
    handle.scene.onMeshRemovedObservable.add(removed);
    // A scene edit hands over equal blockers in a fresh array.
    await overlay.sync(bytes, [door(1)]);
    expect(overlay.mesh).toBe(fill);
    expect(overlay.blockerMeshes[0]).toBe(blocker);
    expect(fill.isDisposed()).toBe(false);
    expect(blocker.isDisposed()).toBe(false);
    expect(added).not.toHaveBeenCalled();
    expect(removed).not.toHaveBeenCalled();

    // Reading the stored chunk again after a save hands over equal bytes in a new array.
    await overlay.sync(new Uint8Array(bytes), [door(1)]);
    expect(overlay.mesh).toBe(fill);
    expect(overlay.blockerMeshes[0]).toBe(blocker);
    expect(removed).not.toHaveBeenCalled();

    // A moved blocker, another bake or world, or a mesh the scene dropped, is a new request.
    await overlay.sync(bytes, [door(5)]);
    expect(blocker.isDisposed()).toBe(true);
    expect(overlay.blockerMeshes[0]).not.toBe(blocker);
    const moved = overlay.blockerMeshes[0]!;
    expect(worldBox(moved).min[0]).toBeCloseTo(4.5, 5);
    const other = await generateNavMesh({ positions: [-5, 0, -5, 5, 0, -5, 5, 0, 5, -5, 0, 5], indices: [0, 3, 2, 0, 2, 1] });
    await overlay.sync(other, [door(5)]);
    expect(moved.isDisposed()).toBe(true);
    const rebuilt = overlay.blockerMeshes[0]!;
    rebuilt.dispose();
    await overlay.sync(other, [door(5)]);
    expect(overlay.blockerMeshes[0]!.isDisposed()).toBe(false);
    expect(overlay.blockerMeshes[0]).not.toBe(rebuilt);
    overlay.dispose();
  });
});

describe("navmesh overlay helpers", () => {
  it("places NavMesh Blockers where the bake carves them, through their parents", async () => {
    const blocker = (kind: string) => [
      { id: "vol", classId: "NavMeshBlockerComponent", properties: { kind } },
    ];
    const actors = [
      createActor("empty", "Empty"),
      createActor("pillar", "Pillar", { components: blocker("cylinder") }),
      createActor("rig", "Rig", {
        transform: {
          position: [10, 0, 0],
          rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
          scale: [1, 2, 1],
        },
      }),
      createActor("door", "Door", {
        parentId: "rig",
        transform: {
          position: [1, 0.5, 0],
          rotation: [0, 0, 0, 1],
          scale: [2, 1, 4],
        },
        components: blocker("box"),
      }),
    ];
    const poses = navDebugBlockersFromActors(actors);
    expect(poses.map(({ id, kind }) => [id, kind])).toEqual([
      ["pillar", "cylinder"],
      ["door", "box"],
    ]);
    const { engine, scene } = createTestEngine();
    const overlay = new NavMeshDebugOverlay(scene);
    await overlay.sync(null, poses.filter((pose) => pose.id === "door"));
    const drawn = worldBox(overlay.blockerMeshes[0]!);
    const carved = staticBlockerBakeParts(actors, "3d").map(boundsOf)[1]!;
    expectClose(drawn.min, carved.min);
    expectClose(drawn.max, carved.max);
    // The rig at x = 10 turns the door a quarter turn and doubles its height.
    expectClose(drawn.min, [8, 0, -2]);
    expectClose(drawn.max, [12, 2, 0]);
    overlay.dispose();
    scene.dispose();
    engine.dispose();
  });
});

function expectClose(actual: readonly number[], expected: readonly number[]): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((value, index) => expect(actual[index]).toBeCloseTo(value, 5));
}

function boundsOf(part: { positions: ArrayLike<number> }): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < part.positions.length; index += 1) {
    const axis = index % 3;
    min[axis] = Math.min(min[axis]!, part.positions[index]!);
    max[axis] = Math.max(max[axis]!, part.positions[index]!);
  }
  return { min, max };
}

function worldBox(mesh: Mesh): { min: number[]; max: number[] } {
  mesh.computeWorldMatrix(true);
  const { minimumWorld, maximumWorld } = mesh.getBoundingInfo().boundingBox;
  return { min: minimumWorld.asArray(), max: maximumWorld.asArray() };
}
