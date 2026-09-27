import { describe, expect, it } from "vitest";
import {
  accountedGeometryBytes,
  DRAW_CALL_WARN_CEILING,
  drawCallCeilingWarning,
  GEOMETRY_BYTE_CEILING,
  geometryByteCeilingWarning,
} from "./perf-ceilings";

describe("perf ceilings", () => {
  it("keeps the tiny CI fixture under the geometry ceiling", () => {
    const geometryBytes = accountedGeometryBytes(24, 36);
    expect(geometryBytes).toBe(24 * 32 + 36 * 4);
    expect(geometryBytes).toBeLessThan(GEOMETRY_BYTE_CEILING);
    expect(geometryByteCeilingWarning(geometryBytes)).toBeNull();
  });

  it("warns when accounted bytes or draw calls drift past the budget", () => {
    expect(geometryByteCeilingWarning(GEOMETRY_BYTE_CEILING + 1)).toMatch(/ceiling/);
    expect(drawCallCeilingWarning(DRAW_CALL_WARN_CEILING)).toBeNull();
    expect(drawCallCeilingWarning(DRAW_CALL_WARN_CEILING + 1)).toMatch(
      /Draw calls/,
    );
  });
});
