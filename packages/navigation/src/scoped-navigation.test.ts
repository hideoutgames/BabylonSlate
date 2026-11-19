import { describe, expect, it } from "vitest";
import { navMeshDebugPrimitives } from "./debug-primitives";
import { generateNavMesh, initNavigation, navigationLoaded, withNavigation } from "./recast-backend";

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

  it("never unloads a module a caller of initNavigation keeps", async () => {
    await initNavigation();
    await withNavigation(() => navMeshDebugPrimitives(bytes));
    expect(navigationLoaded()).toBe(true);
  });
});
