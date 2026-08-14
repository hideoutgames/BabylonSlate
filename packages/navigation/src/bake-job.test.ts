import { describe, expect, it, vi } from "vitest";
import { runNavBakeJob } from "./bake-job";

describe("runNavBakeJob", () => {
  it("calls generateNavMesh with the posted positions and settings", async () => {
    const generate = vi.fn(async () => new Uint8Array([4, 5]));
    const bytes = await runNavBakeJob(
      {
        positions: [0, 0, 0, 1, 0, 0, 1, 0, 1],
        indices: [0, 1, 2],
        settings: { cellSize: 0.5 },
      },
      generate,
    );
    expect(bytes).toEqual(new Uint8Array([4, 5]));
    expect(generate).toHaveBeenCalledWith({
      positions: [0, 0, 0, 1, 0, 0, 1, 0, 1],
      indices: [0, 1, 2],
      settings: { cellSize: 0.5 },
    });
  });
});
