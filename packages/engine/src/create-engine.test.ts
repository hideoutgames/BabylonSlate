import { describe, expect, it } from "vitest";
import { createDefaultScene } from "@babylonslate/shared";

describe("engine scene data", () => {
  it("creates a default scene with a cube", () => {
    const scene = createDefaultScene();
    expect(scene.meshes).toHaveLength(1);
    expect(scene.meshes[0]?.type).toBe("box");
  });
});
