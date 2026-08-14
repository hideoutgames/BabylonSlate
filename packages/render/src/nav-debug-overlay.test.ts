import { afterEach, describe, expect, it } from "vitest";
import { generateNavMesh, initNavigation } from "@babylonslate/navigation";
import { createTestEngine } from "./create-null-engine";
import { NavMeshDebugOverlay } from "./nav-debug-overlay";

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
    overlay.clear();
    expect(overlay.mesh).toBeNull();
    overlay.dispose();
  });
});
