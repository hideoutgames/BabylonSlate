import { beforeAll, describe, expect, it } from "vitest";
import { importNavMesh } from "@recast-navigation/core";
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

  it("finds no path to a goal on a disconnected island", async () => {
    const island = (x: number) => [x - 4, 0, -4, x + 4, 0, -4, x + 4, 0, 4, x - 4, 0, 4];
    const nav = createNavigationBackend();
    nav.importNavMesh(await generateNavMesh({
      positions: [...island(-6), ...island(6)],
      indices: [0, 3, 2, 0, 2, 1, 4, 7, 6, 4, 6, 5],
    }));
    try {
      const within = nav.findPath({ x: -8, y: 0, z: 0 }, { x: -4, y: 0, z: 0 });
      expect(within.at(-1)?.x).toBeCloseTo(-4, 1);
      expect(nav.findPath({ x: -6, y: 0, z: 0 }, { x: 6, y: 0, z: 0 })).toEqual([]);
    } finally { nav.dispose(); }
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

  it("uses the default agent height and refuses an agent beyond the crowd's capacity", () => {
    const nav = createNavigationBackend();
    nav.importNavMesh(bytes);
    try {
      const ids = Array.from({ length: 128 }, (_, index) =>
        nav.addAgent({ x: -9.5 + (index % 16) * 1.2, y: 0, z: -9.5 + Math.floor(index / 16) * 1.2 }));
      expect(ids.every((id) => id !== "")).toBe(true);
      expect(nav.agentDebugState(ids[0]!)?.height).toBeCloseTo(2);
      expect(nav.addAgent({ x: 0, y: 0, z: 0 })).toBe("");
      nav.removeAgent(ids[0]!);
      expect(nav.addAgent({ x: 0, y: 0, z: 0 })).not.toBe("");
    } finally { nav.dispose(); }
  });

  it("projects a raw move target with the path query reach", () => {
    const nav = createNavigationBackend();
    nav.importNavMesh(bytes);
    try {
      const id = nav.addAgent({ x: -4, y: 0, z: 0 });
      // Two units past the ground's edge: outside Detour's default 1-unit search box.
      expect(nav.setAgentTarget(id, { x: 12, y: 0, z: 0 })).toBe(true);
    } finally { nav.dispose(); }
  });

  it("updateAgent maxSpeed changes how far the crowd walks in the same steps", () => {
    const walk = (maxSpeed: number, updateTo?: number) => {
      const nav = createNavigationBackend();
      nav.importNavMesh(bytes);
      const id = nav.addAgent({ x: -4, y: 0, z: -4 }, { maxSpeed });
      if (updateTo !== undefined) nav.updateAgent(id, { maxSpeed: updateTo });
      nav.setAgentTarget(id, { x: 4, y: 0, z: 4 });
      for (let i = 0; i < 60; i += 1) nav.stepCrowd(1 / 60);
      return nav.agentPosition(id)!.x;
    };
    expect(walk(0.5, 8)).toBeGreaterThan(walk(0.5) + 0.5);
  });

  it("reports live crowd corners and clears the active path when stopped or removed", () => {
    const nav = createNavigationBackend();
    nav.importNavMesh(bytes);
    const id = nav.addAgent({ x: -4, y: 0, z: -4 }, { radius: 0.4, height: 1.8 });
    expect(nav.agentDebugState?.(id)).toMatchObject({ target: null, path: [], state: "idle" });
    nav.setAgentTarget(id, { x: 4, y: 0, z: 4 });
    for (let i = 0; i < 30; i += 1) nav.stepCrowd(1 / 60);
    const debug = nav.agentDebugState?.(id);
    expect(debug).toMatchObject({ state: "moving" });
    expect(debug?.radius).toBeCloseTo(0.4);
    expect(debug?.height).toBeCloseTo(1.8);
    expect(debug?.position.x).toBeGreaterThan(-4);
    expect(debug?.target?.x).toBeCloseTo(4);
    expect(debug?.path.length).toBeGreaterThan(0);
    expect(debug?.path.at(-1)?.z).toBeCloseTo(4);
    nav.stopAgent(id);
    expect(nav.agentDebugState?.(id)).toMatchObject({ target: null, path: [], state: "idle" });
    nav.removeAgent(id);
    expect(nav.agentDebugState?.(id)).toBeNull();
  });

  it("correcting a crowd pose preserves its destination and acceleration", () => {
    const nav = createNavigationBackend();
    nav.importNavMesh(bytes);
    const id = nav.addAgent({ x: -4, y: 0, z: 0 }, { maxSpeed: 3, maxAcceleration: 6 });
    expect(nav.setAgentTarget(id, { x: 4, y: 0, z: 0 })).toBe(true);
    let position = { x: -4, y: 0, z: 0 };
    for (let i = 0; i < 60; i += 1) {
      expect(nav.syncAgentPosition(id, position)).toBe(true);
      nav.stepCrowd(1 / 60);
      const velocity = nav.agentVelocity(id)!;
      // A physical body can lag behind the simulated crowd after contact.
      position = { x: position.x + velocity.x / 120, y: 0, z: 0 };
    }
    expect(position.x).toBeGreaterThan(-3);
    expect(nav.agentVelocity(id)!.x).toBeGreaterThan(2.5);
    nav.stopAgent(id);
    for (let i = 0; i < 60; i += 1) {
      nav.syncAgentPosition(id, position);
      nav.stepCrowd(1 / 60);
    }
    expect(nav.agentVelocity(id)!.x).toBeCloseTo(0, 3);
  });

  it("bakes a tiled navmesh when requested without dynamic obstacles", async () => {
    const half = 20;
    const tiled = await generateNavMesh({
      positions: [-half, 0, -half, half, 0, -half, half, 0, half, -half, 0, half],
      indices: [0, 3, 2, 0, 2, 1],
      settings: { tiled: true },
    });
    expect(String.fromCharCode(...tiled.subarray(0, 4))).not.toBe("BSNT");
    const decoded = importNavMesh(tiled).navMesh;
    // 40 m at 0.2 m cells is several 32-cell tiles; a solo bake has one.
    expect(decoded.getMaxTiles()).toBeGreaterThan(1);
    decoded.destroy();
    const nav = createNavigationBackend();
    nav.importNavMesh(tiled);
    try {
      const path = nav.findPath({ x: -18, y: 0, z: -18 }, { x: 18, y: 0, z: 18 });
      expect(path.at(-1)?.x).toBeCloseTo(18, 1);
      expect(path.at(-1)?.z).toBeCloseTo(18, 1);
    } finally { nav.dispose(); }
  });

  it("grows the tile-cache layer budget for stacked floors", async () => {
    // Ten 6 m floors 3 m apart share one 32-cell tile column, beyond the first budget of 4 layers.
    const positions: number[] = [];
    const indices: number[] = [];
    for (let floor = 0; floor < 10; floor++) {
      const y = floor * 3;
      const base = positions.length / 3;
      positions.push(-3, y, -3, 3, y, -3, 3, y, 3, -3, y, 3);
      indices.push(base, base + 3, base + 2, base, base + 2, base + 1);
    }
    const nav = createNavigationBackend();
    nav.importNavMesh(await generateNavMesh({ positions, indices, settings: { supportDynamicObstacles: true } }));
    try {
      for (let floor = 0; floor < 10; floor++) {
        expect(nav.closestPoint({ x: 0, y: floor * 3 + 0.5, z: 0 })?.y).toBeCloseTo(floor * 3, 0);
      }
    } finally { nav.dispose(); }
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
