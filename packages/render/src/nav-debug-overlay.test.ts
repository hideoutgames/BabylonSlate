import { VertexBuffer } from "@babylonjs/core";
import { afterEach, describe, expect, it } from "vitest";
import { generateNavMesh, initNavigation, navMeshDebugPrimitives } from "@babylonslate/navigation";
import { createTestEngine } from "./create-null-engine";
import {
  NAVMESH_DEBUG_Y_OFFSET,
  NavMeshDebugOverlay,
  navDebugBlockersFromActors,
  navmeshOverlayEnabled,
} from "./nav-debug-overlay";
import { createActor } from "@babylonslate/core";

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

  it("draws NavMesh Blocker volumes when the overlay is on", async () => {
    const handle = createTestEngine();
    handles.push(handle);
    const overlay = new NavMeshDebugOverlay(handle.scene);
    await overlay.sync(null, [
      {
        id: "door",
        kind: "box",
        position: [1, 0, 2],
        rotation: [0, 0, 0, 1],
        scale: [2, 3, 4],
      },
    ]);
    expect(overlay.mesh).toBeNull();
    expect(overlay.blockerMeshes).toHaveLength(1);
    expect(overlay.blockerMeshes[0]!.renderingGroupId).toBe(1);
    expect(overlay.blockerMeshes[0]!.position.x).toBe(1);
    expect(overlay.blockerMeshes[0]!.scaling.z).toBe(4);
    overlay.clear();
    expect(overlay.blockerMeshes).toHaveLength(0);
  });
});

describe("navmesh overlay helpers", () => {
  it("collects NavMesh Blocker poses and ignores other actors", () => {
    const poses = navDebugBlockersFromActors([
      createActor("empty", "Empty"),
      createActor("door", "Door", {
        transform: {
          position: [3, 1, 0],
          rotation: [0, 0, 0, 1],
          scale: [2, 4, 6],
        },
        components: [
          {
            id: "vol",
            classId: "NavMeshBlockerComponent",
            properties: { kind: "cylinder" },
          },
        ],
      }),
    ]);
    expect(poses).toEqual([
      {
        id: "door",
        kind: "cylinder",
        position: [3, 1, 0],
        rotation: [0, 0, 0, 1],
        scale: [2, 4, 6],
      },
    ]);
  });

  it("enables the overlay from showNavmesh or a leftover debugOverlay flag", () => {
    expect(
      navmeshOverlayEnabled({
        settings: { showNavmesh: false },
        actors: [
          createActor("nav", "Nav", {
            components: [
              {
                id: "n",
                classId: "NavMeshComponent",
                properties: { debugOverlay: false },
              },
            ],
          }),
        ],
      }),
    ).toBe(false);
    expect(
      navmeshOverlayEnabled({
        settings: { showNavmesh: true },
        actors: [],
      }),
    ).toBe(true);
    expect(
      navmeshOverlayEnabled({
        settings: {},
        actors: [
          createActor("nav", "Nav", {
            components: [
              {
                id: "n",
                classId: "NavMeshComponent",
                properties: { debugOverlay: true },
              },
            ],
          }),
        ],
      }),
    ).toBe(true);
  });
});
