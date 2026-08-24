import { describe, expect, it } from "vitest";
import { accountedTextureBytes } from "./texture-bytes";
import {
  accountedGeometryBytes,
  DRAW_CALL_WARN_CEILING,
  drawCallCeilingWarning,
  GEOMETRY_BYTE_CEILING,
  geometryByteCeilingWarning,
  IPAD_TEXTURE_BYTE_SUGGESTION,
  TEXTURE_BYTE_CEILING,
  TEXTURE_EVICTION_TARGET_FACTOR,
  textureByteCeilingWarning,
} from "./perf-ceilings";

describe("perf ceilings", () => {
  it("defaults the texture budget to 2 GB and keeps 512 MB as an iPad suggestion", () => {
    expect(TEXTURE_BYTE_CEILING).toBe(2 * 1024 * 1024 * 1024);
    expect(IPAD_TEXTURE_BYTE_SUGGESTION).toBe(512 * 1024 * 1024);
    expect(TEXTURE_EVICTION_TARGET_FACTOR).toBe(0.8);
  });

  it("keeps the tiny CI fixture under texture and geometry ceilings", () => {
    const textureBytes = accountedTextureBytes(64, 64, "rgba8", true);
    const geometryBytes = accountedGeometryBytes(24, 36);
    expect(textureBytes).toBe(Math.ceil(64 * 64 * 4 * (4 / 3)));
    expect(geometryBytes).toBe(24 * 32 + 36 * 4);
    expect(textureBytes).toBeLessThan(TEXTURE_BYTE_CEILING);
    expect(geometryBytes).toBeLessThan(GEOMETRY_BYTE_CEILING);
    expect(textureByteCeilingWarning(textureBytes)).toBeNull();
    expect(geometryByteCeilingWarning(geometryBytes)).toBeNull();
  });

  it("warns when accounted bytes or draw calls drift past the budget", () => {
    expect(textureByteCeilingWarning(TEXTURE_BYTE_CEILING + 1)).toMatch(/ceiling/);
    expect(geometryByteCeilingWarning(GEOMETRY_BYTE_CEILING + 1)).toMatch(/ceiling/);
    expect(drawCallCeilingWarning(DRAW_CALL_WARN_CEILING)).toBeNull();
    expect(drawCallCeilingWarning(DRAW_CALL_WARN_CEILING + 1)).toMatch(
      /Draw calls/,
    );
  });
});
