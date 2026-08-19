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
      bakeBoundsEnabled: false,
      bakeBoundsMin: { x: -50, y: -10, z: -50 },
      bakeBoundsMax: { x: 50, y: 10, z: 50 },
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

  it("parses bake bounds vectors when enabled", () => {
    const parsed = parseNavMeshActorSettings({
      bakeBoundsEnabled: true,
      bakeBoundsMin: { x: -2, y: -1, z: -2 },
      bakeBoundsMax: { x: 2, y: 3, z: 2 },
    });
    expect(parsed.bakeBoundsEnabled).toBe(true);
    expect(parsed.bakeBoundsMin).toEqual({ x: -2, y: -1, z: -2 });
    expect(parsed.bakeBoundsMax).toEqual({ x: 2, y: 3, z: 2 });
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
      cost: 10,
    });
    expect(
      parseNavMeshBlockerProperties({
        dynamic: true,
        kind: "cylinder",
        area: "cost",
        cost: 25,
      }),
    ).toEqual({ dynamic: true, kind: "cylinder", area: "cost", cost: 25 });
    expect(parseNavMeshBlockerProperties({ cost: 1 }).cost).toBe(10);
    expect(parseNavMeshBlockerProperties({ cost: 0.5 }).cost).toBe(10);
  });
});
