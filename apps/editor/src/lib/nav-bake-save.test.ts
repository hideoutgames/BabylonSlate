import { describe, expect, it, vi } from "vitest";
import { createActor, createDefaultScene } from "@babylonslate/core";
import {
  flushNavBakeForSave,
  lastNavBakeSaveResult,
  navMeshAutoBakeProperties,
  recordNavBakeSaveResult,
  registerNavBakeSaveFlush,
} from "./nav-bake-save";

describe("nav bake save flush", () => {
  it("lists NavMeshComponent properties when Auto Bake On Save is on", () => {
    const scene = {
      ...createDefaultScene(),
      actors: [
        createActor("nav", "NavMesh", {
          components: [
            {
              id: "nav",
              classId: "NavMeshComponent",
              properties: { autoBakeOnSave: true, cellSize: 0.3 },
            },
          ],
        }),
        createActor("skip", "Other", {
          components: [
            {
              id: "nav-off",
              classId: "NavMeshComponent",
              properties: { autoBakeOnSave: false },
            },
          ],
        }),
      ],
    };
    expect(navMeshAutoBakeProperties(scene)).toEqual([
      { autoBakeOnSave: true, cellSize: 0.3 },
    ]);
  });

  it("invokes registered startBake flushes sequentially and skips when none are registered", async () => {
    const startBake = vi.fn<(properties: Record<string, unknown>) => Promise<void>>();
    startBake.mockResolvedValue(undefined);
    await flushNavBakeForSave();
    expect(startBake).not.toHaveBeenCalled();
    const unregister = registerNavBakeSaveFlush(async () => {
      await startBake({ autoBakeOnSave: true });
    });
    await flushNavBakeForSave();
    expect(startBake).toHaveBeenCalledWith({ autoBakeOnSave: true });
    unregister();
    startBake.mockClear();
    await flushNavBakeForSave();
    expect(startBake).not.toHaveBeenCalled();
  });

  it("records the last bake result for the Save / Playwright hatch", () => {
    recordNavBakeSaveResult({
      ok: true,
      path: "assets/main.scene.babasset",
      byteLength: 12,
      error: null,
    });
    expect(lastNavBakeSaveResult()).toEqual({
      ok: true,
      path: "assets/main.scene.babasset",
      byteLength: 12,
      error: null,
    });
  });
});
