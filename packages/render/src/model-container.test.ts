import { describe, expect, it } from "vitest";
import { encodeGlbJsonBin, splitGlbJsonBin } from "@babylonslate/assets";
import { createTestEngine } from "./create-null-engine";
import { encodeParentedAnimatedTriangleGlb, encodeTriangleGlb } from "./model-mesh";
import { createModelPreviewScene, loadModelPreviewSource } from "./model-preview";

describe("model pose and clip ranges", () => {
  it("retains the authored pose, with no playback, until a specific animation is requested", async () => {
    const handle = createTestEngine();
    const host = createModelPreviewScene(handle.engine);
    try {
      const split = splitGlbJsonBin(encodeParentedAnimatedTriangleGlb("Walk"))!;
      const json = split.json as { nodes: { translation?: number[] }[]; accessors: { min: number[]; max: number[] }[] };
      json.nodes[1]!.translation = [0, 7, 0];
      json.accessors[1]!.min = [47];
      json.accessors[1]!.max = [48];
      new DataView(split.bin.buffer, split.bin.byteOffset).setFloat32(36, 47, true);
      new DataView(split.bin.buffer, split.bin.byteOffset).setFloat32(40, 48, true);
      const loaded = await loadModelPreviewSource(host, encodeGlbJsonBin(split.json, split.bin));
      const group = loaded!.animationGroups[0]!;
      const target = group.targetedAnimations[0]!.target;
      expect(target.position.y).toBe(7);
      for (let i = 0; i < 3; i++) host.scene.render();
      expect(target.position.y).toBe(7);
      expect(host.scene.animatables).toHaveLength(0);
      expect(group.from).toBeCloseTo(47 * 60);
      expect(group.to - group.from).toBeCloseTo(60);
      group.start(true);
      group.pause();
      group.goToFrame(group.from + 30);
      expect(target.position.y).toBeCloseTo(0.5);
      expect(group.loopAnimation).toBe(true);
    } finally { host.dispose(); handle.engine.dispose(); }
  });

  it("still loads ordinary models without skeletons or animations", async () => {
    const handle = createTestEngine();
    const host = createModelPreviewScene(handle.engine);
    try {
      const loaded = await loadModelPreviewSource(host, encodeTriangleGlb());
      expect(loaded!.animationGroups).toEqual([]);
      expect(host.mesh.getChildMeshes().some((mesh) => mesh.getTotalVertices() > 0)).toBe(true);
      host.scene.render();
    } finally { host.dispose(); handle.engine.dispose(); }
  });
});
