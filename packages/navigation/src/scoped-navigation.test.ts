import { describe, expect, it } from "vitest";
import { navMeshDebugPrimitives } from "./debug-primitives";
import { generateNavMesh } from "./bake";
import { createNavigationBackend, initNavigation, navigationLoaded, withNavigation } from "./recast-backend";

const ground = {
  positions: [-10, 0, -10, 10, 0, -10, 10, 0, 10, -10, 0, 10],
  indices: [0, 3, 2, 0, 2, 1],
};

// One file, run in order: the module's lifetime is this context's, and the last case pins it.
describe("withNavigation", () => {
  let bytes: Uint8Array;

  it("loads the Recast module for its work and unloads it after", async () => {
    expect(navigationLoaded()).toBe(false);
    bytes = await withNavigation(async () => {
      expect(navigationLoaded()).toBe(true);
      return generateNavMesh(ground);
    });
    expect(navigationLoaded()).toBe(false);
  });

  it("decodes the same triangles from a module loaded again", async () => {
    const first = await withNavigation(() => navMeshDebugPrimitives(bytes));
    expect(navigationLoaded()).toBe(false);
    const second = await withNavigation(() => navMeshDebugPrimitives(bytes));
    expect(first.some((primitive) => primitive.type === "tris")).toBe(true);
    expect(second).toEqual(first);
  });

  it("unloads only once the last overlapping work has finished", async () => {
    let finishFirst!: () => void;
    const first = withNavigation(() => new Promise<void>((resolve) => { finishFirst = resolve; }));
    const second = withNavigation(() => navMeshDebugPrimitives(bytes));
    await second;
    expect(navigationLoaded()).toBe(true);
    finishFirst();
    await first;
    expect(navigationLoaded()).toBe(false);
  });

  it("keeps the module while a backend holds a navmesh, and unloads it with the last one", async () => {
    await initNavigation();
    const [first, second] = [createNavigationBackend(), createNavigationBackend()];
    first.importNavMesh(bytes);
    first.importNavMesh(bytes);
    second.importNavMesh(bytes);
    await withNavigation(() => navMeshDebugPrimitives(bytes));
    expect(navigationLoaded()).toBe(true);
    // A disposed backend lets go once, however often it imported or is disposed.
    first.dispose();
    first.dispose();
    expect(navigationLoaded()).toBe(true);
    expect(second.findPath({ x: -4, y: 0, z: -4 }, { x: 4, y: 0, z: 4 }).length).toBeGreaterThan(1);
    second.dispose();
    expect(navigationLoaded()).toBe(false);
    // The next session loads it again.
    await initNavigation();
    first.importNavMesh(bytes);
    expect(first.findPath({ x: -4, y: 0, z: -4 }, { x: 4, y: 0, z: 4 }).length).toBeGreaterThan(1);
    first.dispose();
    expect(navigationLoaded()).toBe(false);
  });
});
