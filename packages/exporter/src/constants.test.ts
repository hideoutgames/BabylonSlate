import { describe, expect, it } from "vitest";
import {
  NAVMESH_EXPORT_TYPE,
  navmeshExportGuid,
  sceneGuidFromNavmeshExport,
} from "./constants";

describe("navmesh export ids", () => {
  it("round-trips a scene guid through the sidecar prefix", () => {
    expect(NAVMESH_EXPORT_TYPE).toBe("NavMesh");
    const guid = navmeshExportGuid("scene-1");
    expect(guid).toBe("navmesh:scene-1");
    expect(sceneGuidFromNavmeshExport(guid)).toBe("scene-1");
    expect(sceneGuidFromNavmeshExport("scene-1")).toBeNull();
  });
});
