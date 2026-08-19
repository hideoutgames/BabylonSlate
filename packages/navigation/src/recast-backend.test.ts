import { beforeAll, describe, expect, it } from "vitest";
import {
  createNavigationBackend,
  generateNavMesh,
} from "./recast-backend";

/** Flat ground on Recast XZ (Y up), 20×20. */
function groundPrism(): { positions: number[]; indices: number[] } {
  const half = 10;
  const y = 0;
  return {
    positions: [
      -half, y, -half,
      half, y, -half,
      half, y, half,
      -half, y, half,
    ],
    indices: [0, 3, 2, 0, 2, 1],
  };
}

describe("recast generate / import round-trip", () => {
  let bytes: Uint8Array;

  beforeAll(async () => {
    const mesh = groundPrism();
    bytes = await generateNavMesh(mesh);
  });

  it("exports non-empty navmesh bytes", () => {
    expect(bytes.byteLength).toBeGreaterThan(32);
  });

  it("imports those bytes and finds a path across the prism", () => {
    const nav = createNavigationBackend();
    nav.importNavMesh(bytes);
    const path = nav.findPath({ x: -4, y: 0, z: -4 }, { x: 4, y: 0, z: 4 });
    expect(path.length).toBeGreaterThan(1);
    expect(path[0]!.x).toBeCloseTo(-4, 0);
    expect(path[path.length - 1]!.x).toBeCloseTo(4, 0);
    nav.importNavMesh(bytes);
    expect(nav.findPath({ x: -4, y: 0, z: -4 }, { x: 4, y: 0, z: 4 }).length).toBeGreaterThan(1);
  });

  it("snaps a point onto the mesh", () => {
    const nav = createNavigationBackend();
    nav.importNavMesh(bytes);
    const closest = nav.closestPoint({ x: 0, y: 2, z: 0 });
    expect(closest).not.toBeNull();
    expect(closest!.y).toBeCloseTo(0, 0);
  });

  it("returns a random point near a center", () => {
    const nav = createNavigationBackend();
    nav.importNavMesh(bytes);
    const point = nav.randomPointInRadius({ x: 0, y: 0, z: 0 }, 3);
    expect(point).not.toBeNull();
    expect(Math.hypot(point!.x, point!.z)).toBeLessThan(8);
  });

  it("tracks obstacles and steps an empty crowd", () => {
    const nav = createNavigationBackend();
    nav.importNavMesh(bytes);
    const id = nav.addObstacle("box", { x: 1, y: 0, z: 1 }, { x: 1, y: 1, z: 1 });
    expect(id).not.toBe("");
    nav.removeObstacle(id);
    nav.stepCrowd(1 / 60);
  });

  it("adds a crowd agent that steps toward a target", () => {
    const nav = createNavigationBackend();
    nav.importNavMesh(bytes);
    const id = nav.addAgent({ x: -4, y: 0, z: -4 });
    expect(id).not.toBe("");
    const start = nav.agentPosition(id);
    expect(start).not.toBeNull();
    expect(start!.x).toBeCloseTo(-4, 0);
    expect(nav.setAgentTarget(id, { x: 4, y: 0, z: 4 })).toBe(true);
    for (let i = 0; i < 120; i += 1) nav.stepCrowd(1 / 60);
    const moved = nav.agentPosition(id);
    expect(moved).not.toBeNull();
    expect(moved!.x).toBeGreaterThan(start!.x);
    nav.removeAgent(id);
    expect(nav.agentPosition(id)).toBeNull();
    expect(nav.agentVelocity(id)).toBeNull();
  });

  it("records whether crowd steps are byte-identical across two backends", () => {
    const run = () => {
      const nav = createNavigationBackend();
      nav.importNavMesh(bytes);
      const id = nav.addAgent({ x: -3, y: 0, z: 0 });
      nav.setAgentTarget(id, { x: 3, y: 0, z: 0 });
      const xs: number[] = [];
      for (let i = 0; i < 30; i += 1) {
        nav.stepCrowd(1 / 60);
        xs.push(nav.agentPosition(id)!.x);
      }
      return xs;
    };
    const a = run();
    const b = run();
    expect(a).toEqual(b);
  });

  it("returns empty queries before importNavMesh", () => {
    const nav = createNavigationBackend();
    expect(nav.findPath({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 1 })).toEqual([]);
    expect(nav.closestPoint({ x: 0, y: 0, z: 0 })).toBeNull();
    expect(nav.randomPointInRadius({ x: 0, y: 0, z: 0 }, 1)).toBeNull();
    expect(nav.addAgent({ x: 0, y: 0, z: 0 })).toBe("");
    expect(nav.agentPosition("missing")).toBeNull();
    expect(nav.setAgentTarget("missing", { x: 1, y: 0, z: 0 })).toBe(false);
    nav.removeAgent("missing");
  });

  it("throws when Recast cannot build a mesh", async () => {
    await expect(generateNavMesh({ positions: [], indices: [] })).rejects.toThrow(
      /Failed|generateNavMesh/,
    );
  });

  it("includes the Recast generator error when solo generate fails", async () => {
    await expect(generateNavMesh({ positions: [], indices: [] })).rejects.toThrow(
      /generateNavMesh failed:/,
    );
  });
});
