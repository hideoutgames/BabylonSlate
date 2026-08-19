import { describe, expect, it } from "vitest";
import { parseGlbForBrowse, splitGlbJsonBin } from "@babylonslate/assets";
import { loadKenneyMannequinGlb } from "./kenney-mannequin";

describe("Kenney Mannequin GLB", () => {
  it("loads glTF-binary bytes from the engine-content pack", async () => {
    const bytes = await loadKenneyMannequinGlb();
    expect(bytes.byteLength).toBeGreaterThan(1000);
    expect(String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!)).toBe(
      "glTF",
    );
  });

  it("embeds mannequin.png over the missing Textures/texture-d.png URI", async () => {
    const bytes = await loadKenneyMannequinGlb();
    const split = splitGlbJsonBin(bytes);
    expect(split).not.toBeNull();
    const images = split!.json.images as Array<{ uri?: string; bufferView?: number }>;
    expect(images[0]?.uri).toBeUndefined();
    expect(images[0]?.bufferView).toEqual(expect.any(Number));
    const browse = parseGlbForBrowse(bytes);
    expect(browse?.images[0]?.bytes.byteLength).toBeGreaterThan(100);
    expect(browse?.materials[0]?.unlit).toBe(true);
  });
});
