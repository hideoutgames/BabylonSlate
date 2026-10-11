import { beforeAll, describe, expect, it, vi } from "vitest";
import { NavMeshQuery, Raw, TileCache } from "@recast-navigation/core";
import {
  createNavigationBackend,
  generateNavMesh,
  initNavigation,
} from "./recast-backend";
import { mergeNavBakeMeshes } from "./geometry";
import { recastWalkableQuadFromXy, recastWallsFromXyChains, solidBlockerMesh } from "./blockers";

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

/** A path that reaches `to` by bending out to at least `reach` from the straight line along Z = 0. */
function detours(path: Array<{ x: number; y: number; z: number }>, to: { x: number; z: number }, reach: number): boolean {
  const end = path.at(-1);
  return !!end && Math.hypot(end.x - to.x, end.z - to.z) < 0.05 && path.some((point) => Math.abs(point.z) >= reach);
}

describe("tile-cache obstacles and static carve", () => {
  beforeAll(async () => {
    await initNavigation();
  });

  it("carves a dynamic box when the bake requested tile-cache obstacles", async () => {
    const bytes = await generateNavMesh({
      ...groundPrism(),
      settings: { supportDynamicObstacles: true },
    });
    const nav = createNavigationBackend();
    nav.importNavMesh(bytes);
    const open = nav.findPath({ x: -4, y: 0, z: 0 }, { x: 4, y: 0, z: 0 });
    expect(open.length).toBeGreaterThan(1);
    const id = nav.addObstacle("box", { x: 0, y: 1, z: 0 }, { x: 2, y: 2, z: 8 });
    nav.stepCrowd(0);
    const blocked = nav.findPath({ x: -4, y: 0, z: 0 }, { x: 4, y: 0, z: 0 });
    // Around the 8-long box's end, not through it.
    expect(detours(blocked, { x: 4, z: 0 }, 3.8)).toBe(true);
    nav.removeObstacle(id);
    nav.stepCrowd(0);
    expect(nav.findPath({ x: -4, y: 0, z: 0 }, { x: 4, y: 0, z: 0 })).toHaveLength(2);
  });

  it("gives no obstacle id on a solo mesh, which cannot carve", async () => {
    const bytes = await generateNavMesh(groundPrism());
    const nav = createNavigationBackend();
    nav.importNavMesh(bytes);
    expect(nav.addObstacle("box", { x: 0, y: 1, z: 0 }, { x: 8, y: 2, z: 8 })).toBe("");
    expect(nav.findPath({ x: -4, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }).length).toBeGreaterThan(1);
  });

  it("carves a cylinder from its center and diameter", async () => {
    const nav = createNavigationBackend();
    nav.importNavMesh(await generateNavMesh({ ...groundPrism(), settings: { supportDynamicObstacles: true } }));
    try {
      // Diameter 2, height 2, centered 1 above the floor: it spans the floor out to radius 1.
      expect(nav.addObstacle("cylinder", { x: 0, y: 1, z: 0 }, { x: 2, y: 2, z: 2 })).not.toBe("");
      expect(detours(nav.findPath({ x: -4, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }), { x: 4, z: 0 }, 0.8)).toBe(true);
      // Outside radius 1 the straight line stays open.
      expect(nav.findPath({ x: -4, y: 0, z: 1.6 }, { x: 4, y: 0, z: 1.6 })).toHaveLength(2);
    } finally { nav.dispose(); }
  });

  it("turns a box obstacle by its yaw", async () => {
    const nav = createNavigationBackend();
    nav.importNavMesh(await generateNavMesh({ ...groundPrism(), settings: { supportDynamicObstacles: true } }));
    try {
      // 8 long on X, turned a quarter about +Y: a wall along Z across the straight route.
      nav.addObstacle("box", { x: 0, y: 1, z: 0 }, { x: 8, y: 2, z: 1 }, Math.PI / 2);
      expect(detours(nav.findPath({ x: -6, y: 0, z: 0 }, { x: 6, y: 0, z: 0 }), { x: 6, z: 0 }, 3.8)).toBe(true);
    } finally { nav.dispose(); }
  });

  it("returns no id once the tile cache holds its maximum obstacles", async () => {
    const nav = createNavigationBackend();
    nav.importNavMesh(await generateNavMesh({ ...groundPrism(), settings: { supportDynamicObstacles: true } }));
    try {
      const ids: string[] = [];
      for (let index = 0; index < 128; index++) {
        ids.push(nav.addObstacle("box", { x: -9 + (index % 16), y: 1, z: -9 + Math.floor(index / 16) }, { x: 0.2, y: 2, z: 0.2 }));
      }
      expect(ids.every((id) => id !== "")).toBe(true);
      expect(nav.addObstacle("box", { x: 5, y: 1, z: 5 }, { x: 0.2, y: 2, z: 0.2 })).toBe("");
      nav.removeObstacle(ids[0]!);
      expect(nav.addObstacle("box", { x: 5, y: 1, z: 5 }, { x: 0.2, y: 2, z: 0.2 })).not.toBe("");
    } finally { nav.dispose(); }
  });

  it("reuses queries and skips tile work while the crowd and obstacles are unchanged", async () => {
    const bytes = await generateNavMesh({ ...groundPrism(), settings: { supportDynamicObstacles: true } });
    const nav = createNavigationBackend();
    nav.importNavMesh(bytes);
    const update = vi.spyOn(TileCache.prototype, "update");
    const destroyQuery = vi.spyOn(NavMeshQuery.prototype, "destroy");
    const destroyNative = vi.spyOn(Raw, "destroy");
    try {
      for (let tick = 0; tick < 8; tick++) nav.stepCrowd(1 / 60);
      expect(update).not.toHaveBeenCalled();
      const obstacle = nav.addObstacle("box", { x: 0, y: 1, z: 0 }, { x: 2, y: 2, z: 8 });
      expect(update).toHaveBeenCalled();
      update.mockClear();
      for (let tick = 0; tick < 8; tick++) nav.stepCrowd(1 / 60);
      expect(update).not.toHaveBeenCalled();
      expect(destroyQuery).not.toHaveBeenCalled();
      expect(nav.findPath({ x: -4, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }).length).toBeGreaterThan(1);
      nav.removeObstacle(obstacle);
      nav.dispose();
      nav.dispose();
      expect(nav.findPath({ x: -4, y: 0, z: 0 }, { x: 4, y: 0, z: 0 })).toEqual([]);
      expect(destroyQuery).toHaveBeenCalledTimes(1);
      const filter = (destroyQuery.mock.contexts[0] as NavMeshQuery | undefined)?.defaultFilter.raw;
      expect(destroyNative.mock.calls.filter(([resource]) => resource === filter)).toHaveLength(1);
      nav.importNavMesh(bytes);
      expect(nav.findPath({ x: -4, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }).length).toBeGreaterThan(1);
    } finally {
      nav.dispose();
      update.mockRestore();
      destroyQuery.mockRestore();
      destroyNative.mockRestore();
    }
  });

  it("bakes a static unwalkable box into the solo mesh", async () => {
    const ground = groundPrism();
    const blocker = solidBlockerMesh({
      kind: "box",
      pose: { x: 0, y: 1, z: 0 },
      size: { x: 4, y: 2, z: 4 },
    });
    const merged = mergeNavBakeMeshes([ground, blocker]);
    const bytes = await generateNavMesh(merged);
    const nav = createNavigationBackend();
    nav.importNavMesh(bytes);
    expect(detours(nav.findPath({ x: -8, y: 0, z: 0 }, { x: 8, y: 0, z: 0 }), { x: 8, z: 0 }, 1.8)).toBe(true);
  });

  it("bakes 2D collision chains as Recast walls on an XY walkable quad", async () => {
    const floor = recastWalkableQuadFromXy({ minX: -8, minY: -8, maxX: 8, maxY: 8 });
    const wall = recastWallsFromXyChains(
      [{ points: [{ x: 0, y: -6 }, { x: 0, y: 6 }], loop: false }],
      2,
    );
    const bytes = await generateNavMesh(mergeNavBakeMeshes([floor, wall]));
    const nav = createNavigationBackend();
    nav.importNavMesh(bytes);
    // Recast Z is world Y: around the end of the wall from y = -6 to 6.
    expect(detours(nav.findPath({ x: -4, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }), { x: 4, z: 0 }, 5.8)).toBe(true);
  });
});
