import {
  DEFAULT_NAV_MESH_SETTINGS,
  type NavAgentParams,
  type NavMeshSettings,
} from "./types";

export type NavMeshActorSettings = NavMeshSettings & {
  tiled: boolean;
  supportDynamicObstacles: boolean;
  autoBakeOnSave: boolean;
  bakeBoundsEnabled: boolean;
  bakeBoundsMin: { x: number; y: number; z: number };
  bakeBoundsMax: { x: number; y: number; z: number };
  debugOverlay: boolean;
};

export const DEFAULT_NAV_AGENT_PARAMS: Required<NavAgentParams> = {
  radius: 0.5,
  height: 2,
  maxSpeed: 3.5,
  maxAcceleration: 8,
};

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asVector3(
  value: unknown,
  fallback: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  if (Array.isArray(value) && value.length >= 3) {
    return {
      x: asNumber(value[0], fallback.x),
      y: asNumber(value[1], fallback.y),
      z: asNumber(value[2], fallback.z),
    };
  }
  if (!value || typeof value !== "object") return { ...fallback };
  const row = value as { x?: unknown; y?: unknown; z?: unknown };
  return {
    x: asNumber(row.x, fallback.x),
    y: asNumber(row.y, fallback.y),
    z: asNumber(row.z, fallback.z),
  };
}

export function defaultNavMeshComponentProperties(): NavMeshActorSettings {
  return {
    ...DEFAULT_NAV_MESH_SETTINGS,
    tiled: false,
    supportDynamicObstacles: false,
    autoBakeOnSave: false,
    bakeBoundsEnabled: false,
    bakeBoundsMin: { x: -50, y: -10, z: -50 },
    bakeBoundsMax: { x: 50, y: 10, z: 50 },
    debugOverlay: false,
  };
}

export function parseNavMeshActorSettings(
  properties: Record<string, unknown>,
): NavMeshActorSettings {
  const defaults = defaultNavMeshComponentProperties();
  return {
    cellSize: asNumber(properties.cellSize, defaults.cellSize),
    cellHeight: asNumber(properties.cellHeight, defaults.cellHeight),
    walkableSlopeAngle: asNumber(
      properties.walkableSlopeAngle,
      defaults.walkableSlopeAngle,
    ),
    walkableHeight: asNumber(properties.walkableHeight, defaults.walkableHeight),
    walkableClimb: asNumber(properties.walkableClimb, defaults.walkableClimb),
    walkableRadius: asNumber(properties.walkableRadius, defaults.walkableRadius),
    maxEdgeLen: asNumber(properties.maxEdgeLen, defaults.maxEdgeLen),
    maxSimplificationError: asNumber(
      properties.maxSimplificationError,
      defaults.maxSimplificationError,
    ),
    minRegionArea: asNumber(properties.minRegionArea, defaults.minRegionArea),
    mergeRegionArea: asNumber(
      properties.mergeRegionArea,
      defaults.mergeRegionArea,
    ),
    maxVertsPerPoly: asNumber(
      properties.maxVertsPerPoly,
      defaults.maxVertsPerPoly,
    ),
    detailSampleDist: asNumber(
      properties.detailSampleDist,
      defaults.detailSampleDist,
    ),
    detailSampleMaxError: asNumber(
      properties.detailSampleMaxError,
      defaults.detailSampleMaxError,
    ),
    tiled: asBoolean(properties.tiled, defaults.tiled),
    supportDynamicObstacles: asBoolean(
      properties.supportDynamicObstacles,
      defaults.supportDynamicObstacles,
    ),
    autoBakeOnSave: asBoolean(properties.autoBakeOnSave, defaults.autoBakeOnSave),
    bakeBoundsEnabled: asBoolean(
      properties.bakeBoundsEnabled,
      defaults.bakeBoundsEnabled,
    ),
    bakeBoundsMin: asVector3(properties.bakeBoundsMin, defaults.bakeBoundsMin),
    bakeBoundsMax: asVector3(properties.bakeBoundsMax, defaults.bakeBoundsMax),
    debugOverlay: asBoolean(properties.debugOverlay, defaults.debugOverlay),
  };
}

export function parseNavMeshSettings(
  properties: Record<string, unknown>,
): NavMeshSettings {
  const parsed = parseNavMeshActorSettings(properties);
  return {
    cellSize: parsed.cellSize,
    cellHeight: parsed.cellHeight,
    walkableSlopeAngle: parsed.walkableSlopeAngle,
    walkableHeight: parsed.walkableHeight,
    walkableClimb: parsed.walkableClimb,
    walkableRadius: parsed.walkableRadius,
    maxEdgeLen: parsed.maxEdgeLen,
    maxSimplificationError: parsed.maxSimplificationError,
    minRegionArea: parsed.minRegionArea,
    mergeRegionArea: parsed.mergeRegionArea,
    maxVertsPerPoly: parsed.maxVertsPerPoly,
    detailSampleDist: parsed.detailSampleDist,
    detailSampleMaxError: parsed.detailSampleMaxError,
  };
}

export type NavMeshBlockerProperties = {
  dynamic: boolean;
  kind: "box" | "cylinder";
  area: "unwalkable" | "cost";
};

export function defaultNavMeshBlockerComponentProperties(): NavMeshBlockerProperties {
  return { dynamic: false, kind: "box", area: "unwalkable" };
}

export function parseNavMeshBlockerProperties(
  properties: Record<string, unknown>,
): NavMeshBlockerProperties {
  const defaults = defaultNavMeshBlockerComponentProperties();
  return {
    dynamic: asBoolean(properties.dynamic, defaults.dynamic),
    kind: properties.kind === "cylinder" ? "cylinder" : "box",
    area: properties.area === "cost" ? "cost" : "unwalkable",
  };
}

export function parseNavAgentParams(
  properties: Record<string, unknown>,
): Required<NavAgentParams> {
  return {
    radius: asNumber(properties.radius, DEFAULT_NAV_AGENT_PARAMS.radius),
    height: asNumber(properties.height, DEFAULT_NAV_AGENT_PARAMS.height),
    maxSpeed: asNumber(properties.maxSpeed, DEFAULT_NAV_AGENT_PARAMS.maxSpeed),
    maxAcceleration: asNumber(
      properties.maxAcceleration,
      DEFAULT_NAV_AGENT_PARAMS.maxAcceleration,
    ),
  };
}
