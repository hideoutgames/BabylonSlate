import { beforeAll, describe, expect, it } from "vitest";
import { mergeNavBakeMeshes } from "./geometry";
import { solidBlockerMesh } from "./blockers";
import {
  createNavigationBackend,
  generateNavMesh,
  initNavigation,
} from "./recast-backend";
import type { NavPoint } from "./types";

function groundPrism(half = 12): { positions: number[]; indices: number[] } {
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

/** Barrier at x=0 with a short gap at the origin and open ends for a long detour. */
function corridorMesh(): { positions: number[]; indices: number[] } {
  return mergeNavBakeMeshes([
    groundPrism(),
    solidBlockerMesh({
      kind: "box",
      pose: { x: 0, y: 1, z: -6 },
      size: { x: 2, y: 2, z: 8 },
    }),
    solidBlockerMesh({
      kind: "box",
      pose: { x: 0, y: 1, z: 6 },
      size: { x: 2, y: 2, z: 8 },
    }),
  ]);
}

const recastFine = {
  cellSize: 0.25,
  cellHeight: 0.25,
  maxEdgeLen: 2,
  maxSimplificationError: 0.3,
  minRegionArea: 2,
  mergeRegionArea: 4,
  walkableRadius: 0.3,
};

function corridorGenerateInput(tileCache = false) {
  return {
    ...corridorMesh(),
    settings: {
      ...recastFine,
      ...(tileCache ? { supportDynamicObstacles: true as const } : {}),
    },
  };
}

function pathLength(path: NavPoint[]): number {
  let length = 0;
  for (let i = 1; i < path.length; i += 1) {
    const from = path[i - 1]!;
    const to = path[i]!;
    length += Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
  }
  return length;
}

function staysOnShortCorridor(path: NavPoint[]): boolean {
  return path.every((point) => Math.abs(point.z) < 2.5);
}

function goesAroundWalls(path: NavPoint[]): boolean {
  return path.some((point) => Math.abs(point.z) > 6);
}

function crossesOrigin(path: NavPoint[]): boolean {
  return path.some((point) => Math.abs(point.x) < 1 && Math.abs(point.z) < 1);
}

const from = { x: -8, y: 0, z: 0 };
const to = { x: 8, y: 0, z: 0 };
const corridorBox = {
  kind: "box" as const,
  pose: { x: 0, y: 1, z: 0 },
  size: { x: 4, y: 2, z: 3 },
  cost: 10,
};

describe("navmesh cost volumes vs unwalkable carve", () => {
  beforeAll(async () => {
    await initNavigation();
  });

  it("takes the short corridor when no cost volume is applied", async () => {
    const bytes = await generateNavMesh(corridorGenerateInput());
    const nav = createNavigationBackend();
    nav.importNavMesh(bytes);
    const path = nav.findPath(from, to);
    expect(path.length).toBeGreaterThan(1);
    expect(staysOnShortCorridor(path)).toBe(true);
    expect(pathLength(path)).toBeLessThan(20);
  });

  it("detours around a cost volume but still allows a path through the box", async () => {
    const bytes = await generateNavMesh(corridorGenerateInput());
    const nav = createNavigationBackend();
    nav.importNavMesh(bytes);
    const open = nav.findPath(from, to);
    const openLength = pathLength(open);

    nav.applyCostVolume(corridorBox);

    const detour = nav.findPath(from, to);
    expect(detour.length).toBeGreaterThan(1);
    expect(pathLength(detour)).toBeGreaterThan(openLength * 1.15);
    expect(goesAroundWalls(detour)).toBe(true);

    expect(nav.closestPoint({ x: 0, y: 0, z: 0 })).not.toBeNull();
    const through = nav.findPath({ x: -1, y: 0, z: 0 }, { x: 1, y: 0, z: 0 });
    expect(through.length).toBeGreaterThan(1);
  });

  it("removes the corridor when the same box is an unwalkable tile-cache carve", async () => {
    const bytes = await generateNavMesh(corridorGenerateInput(true));
    const nav = createNavigationBackend();
    nav.importNavMesh(bytes);
    expect(staysOnShortCorridor(nav.findPath(from, to))).toBe(true);

    nav.addObstacle("box", corridorBox.pose, corridorBox.size);
    nav.stepCrowd(0);
    const carved = nav.findPath(from, to);
    expect(carved.length).toBeGreaterThan(1);
    expect(crossesOrigin(carved)).toBe(false);
  });
});
