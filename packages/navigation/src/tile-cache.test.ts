import { beforeAll, describe, expect, it } from "vitest";
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
    expect(blocked.length).toBeGreaterThan(1);
    expect(
      blocked.some((point) => Math.abs(point.x) < 1 && Math.abs(point.z) < 1),
    ).toBe(false);
    nav.removeObstacle(id);
    nav.stepCrowd(0);
    expect(nav.findPath({ x: -4, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }).length).toBeGreaterThan(1);
  });

  it("does not carve on a solo mesh (id-map only until tile cache)", async () => {
    const bytes = await generateNavMesh(groundPrism());
    const nav = createNavigationBackend();
    nav.importNavMesh(bytes);
    nav.addObstacle("box", { x: 0, y: 1, z: 0 }, { x: 8, y: 2, z: 8 });
    expect(nav.findPath({ x: -4, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }).length).toBeGreaterThan(1);
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
    const path = nav.findPath({ x: -8, y: 0, z: 0 }, { x: 8, y: 0, z: 0 });
    const crossesOrigin = path.some((point) => Math.abs(point.x) < 1 && Math.abs(point.z) < 1);
    expect(crossesOrigin).toBe(false);
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
    const from = { x: -4, y: 0, z: 0 };
    const to = { x: 4, y: 0, z: 0 };
    const path = nav.findPath(from, to);
    expect(path.length).toBeGreaterThan(1);
    expect(path.some((point) => Math.abs(point.x) < 0.4)).toBe(false);
  });
});
