/**
 * Navmesh baking (Recast's generators). Editor-only: games load baked navmeshes (`createNavigationBackend`) and never
 * bundle the generators.
 */
import { Raw, Recast, exportNavMesh, exportTileCache, type RecastBuildContext } from "@recast-navigation/core";
import { generateSoloNavMesh, generateTileCache, generateTiledNavMesh } from "@recast-navigation/generators";
import { destroyTileCache, initNavigation, walkableTileCacheMeshProcess, wrapTileCacheBytes } from "./recast-backend";
import { DEFAULT_NAV_MESH_SETTINGS, type NavMeshGenerateInput, type NavMeshSettings } from "./types";

/** Tiled and tile-cache bakes split the input into square tiles of this many cells. */
const TILE_SIZE = 32;
/** Tile-cache layer budget per tile; a bake that overflows it is retried with twice the budget. */
const TILE_CACHE_LAYERS_PER_TILE = 4;
const TILE_CACHE_MAX_LAYERS_PER_TILE = 32;
const TILE_CACHE_MAX_OBSTACLES = 128;

/**
 * Settings pass through in Recast's own units (see `NavMeshSettings`); the
 * generators scale cell counts by the cell size and square the region areas.
 */
function toRecastConfig(settings: NavMeshSettings) {
  return {
    cs: settings.cellSize,
    ch: settings.cellHeight,
    walkableSlopeAngle: settings.walkableSlopeAngle,
    walkableHeight: settings.walkableHeight,
    walkableClimb: settings.walkableClimb,
    walkableRadius: settings.walkableRadius,
    maxEdgeLen: settings.maxEdgeLen,
    maxSimplificationError: settings.maxSimplificationError,
    minRegionArea: settings.minRegionArea,
    mergeRegionArea: settings.mergeRegionArea,
    maxVertsPerPoly: settings.maxVertsPerPoly,
    detailSampleDist: settings.detailSampleDist,
    detailSampleMaxError: settings.detailSampleMaxError,
  };
}

function recastGenerateErrorMessage(error: string | undefined): Error {
  return new Error(
    error ? `generateNavMesh failed: ${error}` : "generateNavMesh failed",
  );
}

export async function generateNavMesh(
  input: NavMeshGenerateInput,
): Promise<Uint8Array> {
  // A bake keeps no Recast object: it loads the module without pinning it (`withNavigation`).
  await initNavigation();
  const config = toRecastConfig({ ...DEFAULT_NAV_MESH_SETTINGS, ...input.settings });
  if (input.settings?.supportDynamicObstacles) return generateTileCacheBytes(input, config);
  const result = input.settings?.tiled
    ? generateTiledNavMesh(input.positions, input.indices, { ...config, tileSize: TILE_SIZE })
    : generateSoloNavMesh(input.positions, input.indices, config);
  if (!result.success) {
    throw recastGenerateErrorMessage(
      "error" in result ? result.error : undefined,
    );
  }
  try {
    return exportNavMesh(result.navMesh);
  } finally {
    result.navMesh.destroy();
  }
}

/** The tile-cache generator only logs the walkable layers that did not fit its tile budget. */
function droppedTileCacheLayers(buildContext: RecastBuildContext): boolean {
  return buildContext.logs.some((entry) =>
    entry.category === Recast.RC_LOG_WARNING && entry.msg.startsWith("Failed to add tile to tile cache"));
}

function generateTileCacheBytes(
  input: NavMeshGenerateInput,
  config: ReturnType<typeof toRecastConfig>,
): Uint8Array {
  for (let layers = TILE_CACHE_LAYERS_PER_TILE; ; layers *= 2) {
    const process = walkableTileCacheMeshProcess();
    try {
      const result = generateTileCache(input.positions, input.indices, {
        ...config,
        tileSize: TILE_SIZE,
        expectedLayersPerTile: layers,
        maxObstacles: TILE_CACHE_MAX_OBSTACLES,
        tileCacheMeshProcess: process,
      });
      if (!result.success) {
        throw recastGenerateErrorMessage(
          "error" in result ? result.error : undefined,
        );
      }
      try {
        if (droppedTileCacheLayers(result.intermediates.buildContext)) {
          if (layers < TILE_CACHE_MAX_LAYERS_PER_TILE) continue;
          throw recastGenerateErrorMessage("too many stacked walkable layers for the tile cache");
        }
        return wrapTileCacheBytes(exportTileCache(result.navMesh, result.tileCache));
      } finally {
        destroyTileCache(result.tileCache);
        result.navMesh.destroy();
      }
    } finally {
      Raw.destroy(process.raw);
    }
  }
}
