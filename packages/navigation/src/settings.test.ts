import { describe, expect, it } from "vitest";
import { DEFAULT_NAV_MESH_SETTINGS } from "./types";
import {
  defaultNavMeshBlockerComponentProperties,
  defaultNavMeshComponentProperties,
  parseNavAgentParams,
  parseNavMeshActorSettings,
  parseNavMeshBlockerProperties,
} from "./settings";

describe("nav mesh settings", () => {
  it("fills Recast defaults and host toggles", () => {
    expect(defaultNavMeshComponentProperties()).toMatchObject({
      ...DEFAULT_NAV_MESH_SETTINGS,
      tiled: false,
      supportDynamicObstacles: false,
      autoBakeOnSave: false,
      debugOverlay: false,
    });
  });

  it("parses authored Recast numbers and host toggles", () => {
    const parsed = parseNavMeshActorSettings({
      cellSize: 0.4,
      tiled: true,
      supportDynamicObstacles: true,
      debugOverlay: true,
    });
    expect(parsed.cellSize).toBe(0.4);
    expect(parsed.walkableRadius).toBe(DEFAULT_NAV_MESH_SETTINGS.walkableRadius);
    expect(parsed.tiled).toBe(true);
    expect(parsed.supportDynamicObstacles).toBe(true);
    expect(parsed.debugOverlay).toBe(true);
    expect(parsed.autoBakeOnSave).toBe(false);
  });

  it("parses crowd agent params", () => {
    expect(parseNavAgentParams({ radius: 1, maxSpeed: 8 })).toEqual({
      radius: 1,
      height: 2,
      maxSpeed: 8,
      maxAcceleration: 8,
    });
  });

  it("defaults and parses NavMeshBlockerComponent properties", () => {
    expect(defaultNavMeshBlockerComponentProperties()).toEqual({
      dynamic: false,
      kind: "box",
      area: "unwalkable",
    });
    expect(
      parseNavMeshBlockerProperties({
        dynamic: true,
        kind: "cylinder",
        area: "cost",
      }),
    ).toEqual({ dynamic: true, kind: "cylinder", area: "cost" });
  });
});
