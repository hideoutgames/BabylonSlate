import { describe, expect, it } from "vitest";
import { loadKenneyMannequinGlb } from "./kenney-mannequin";

describe("Kenney Mannequin GLB", () => {
  it("loads glTF-binary bytes from the engine-content pack", async () => {
    const bytes = await loadKenneyMannequinGlb();
    expect(bytes.byteLength).toBeGreaterThan(1000);
    expect(String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!)).toBe(
      "glTF",
    );
  });
});
