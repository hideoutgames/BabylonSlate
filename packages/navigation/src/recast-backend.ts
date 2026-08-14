import {
  Crowd,
  type CrowdAgent,
  NavMesh,
  NavMeshQuery,
  TileCache,
  TileCacheMeshProcess,
  exportNavMesh,
  exportTileCache,
  importNavMesh,
  importTileCache,
  init,
  type Obstacle,
} from "@recast-navigation/core";
import {
  generateSoloNavMesh,
  generateTileCache,
} from "@recast-navigation/generators";
import {
  DEFAULT_NAV_MESH_SETTINGS,
  type NavAgentParams,
  type NavMeshGenerateInput,
  type NavMeshSettings,
  type NavObstacleKind,
  type NavPoint,
  type NavigationBackend,
} from "./types";

const QUERY_EXTENTS = { x: 4, y: 4, z: 4 };
const TILE_CACHE_MAGIC = new Uint8Array([0x42, 0x53, 0x4e, 0x54]); // BSNT
const WALKABLE_AREA = 63;
const WALKABLE_FLAGS = 1;

let recastReady: Promise<void> | null = null;

export function initNavigation(): Promise<void> {
  recastReady ??= init();
  return recastReady;
}

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

function walkableTileCacheMeshProcess(): TileCacheMeshProcess {
  return new TileCacheMeshProcess((params, polyAreas, polyFlags) => {
    const count = params.polyCount();
    for (let i = 0; i < count; i += 1) {
      polyAreas.set(i, WALKABLE_AREA);
      polyFlags.set(i, WALKABLE_FLAGS);
    }
  });
}

function wrapTileCacheBytes(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(TILE_CACHE_MAGIC.length + bytes.byteLength);
  out.set(TILE_CACHE_MAGIC, 0);
  out.set(bytes, TILE_CACHE_MAGIC.length);
  return out;
}

function unwrapTileCacheBytes(bytes: Uint8Array): Uint8Array | null {
  if (bytes.byteLength < TILE_CACHE_MAGIC.length) return null;
  for (let i = 0; i < TILE_CACHE_MAGIC.length; i += 1) {
    if (bytes[i] !== TILE_CACHE_MAGIC[i]) return null;
  }
  return bytes.subarray(TILE_CACHE_MAGIC.length);
}

export async function generateNavMesh(
  input: NavMeshGenerateInput,
): Promise<Uint8Array> {
  await initNavigation();
  const settings = { ...DEFAULT_NAV_MESH_SETTINGS, ...input.settings };
  if (input.settings?.supportDynamicObstacles) {
    const result = generateTileCache(input.positions, input.indices, {
      ...toRecastConfig(settings),
      tileSize: 32,
      expectedLayersPerTile: 4,
      maxObstacles: 128,
      tileCacheMeshProcess: walkableTileCacheMeshProcess(),
    });
    if (!result.success) {
      throw new Error(
        result.error ? String(result.error) : "generateNavMesh failed",
      );
    }
    try {
      return wrapTileCacheBytes(exportTileCache(result.navMesh, result.tileCache));
    } finally {
      result.tileCache.destroy();
      result.navMesh.destroy();
    }
  }
  const result = generateSoloNavMesh(
    input.positions,
    input.indices,
    toRecastConfig(settings),
  );
  if (result.success) {
    try {
      return exportNavMesh(result.navMesh);
    } finally {
      result.navMesh.destroy();
    }
  }
  throw new Error("generateNavMesh failed");
}

class RecastNavigationBackend implements NavigationBackend {
  private navMesh: NavMesh | null = null;
  private query: NavMeshQuery | null = null;
  private crowd: Crowd | null = null;
  private tileCache: TileCache | null = null;
  private tileCacheKeepAlive: unknown[] = [];
  private obstacles = new Map<
    string,
    {
      kind: NavObstacleKind;
      pose: NavPoint;
      size: NavPoint;
      recast: Obstacle | null;
    }
  >();
  private nextObstacle = 1;
  private agents = new Map<string, CrowdAgent>();
  private nextAgent = 1;

  importNavMesh(bytes: Uint8Array): void {
    this.dispose();
    const tileBytes = unwrapTileCacheBytes(bytes);
    if (tileBytes) {
      const process = walkableTileCacheMeshProcess();
      const imported = importTileCache(tileBytes, process);
      this.navMesh = imported.navMesh;
      this.tileCache = imported.tileCache;
      this.tileCacheKeepAlive = [imported.allocator, imported.compressor, process];
    } else {
      const imported = importNavMesh(bytes);
      this.navMesh = imported.navMesh;
    }
    this.query = new NavMeshQuery(this.navMesh);
    this.crowd = new Crowd(this.navMesh, { maxAgents: 32, maxAgentRadius: 0.6 });
  }

  findPath(from: NavPoint, to: NavPoint): NavPoint[] {
    if (!this.query) return [];
    const result = this.query.computePath(from, to, { halfExtents: QUERY_EXTENTS });
    if (!result.success) return [];
    return result.path.map((point) => ({ x: point.x, y: point.y, z: point.z }));
  }

  closestPoint(point: NavPoint): NavPoint | null {
    if (!this.query) return null;
    const result = this.query.findClosestPoint(point, { halfExtents: QUERY_EXTENTS });
    if (!result.success) return null;
    return { x: result.point.x, y: result.point.y, z: result.point.z };
  }

  randomPointInRadius(center: NavPoint, radius: number): NavPoint | null {
    if (!this.query) return null;
    const result = this.query.findRandomPointAroundCircle(center, radius, {
      halfExtents: QUERY_EXTENTS,
    });
    if (!result.success) return null;
    return { x: result.randomPoint.x, y: result.randomPoint.y, z: result.randomPoint.z };
  }

  addObstacle(kind: NavObstacleKind, pose: NavPoint, size: NavPoint): string {
    const id = `obstacle-${this.nextObstacle}`;
    this.nextObstacle += 1;
    let recast: Obstacle | null = null;
    if (this.tileCache) {
      if (kind === "cylinder") {
        const added = this.tileCache.addCylinderObstacle(
          pose,
          Math.max(size.x, 0.05),
          Math.max(size.y, 0.05),
        );
        if (added.success) recast = added.obstacle;
      } else {
        const added = this.tileCache.addBoxObstacle(
          pose,
          {
            x: Math.max(size.x, 0.05) / 2,
            y: Math.max(size.y, 0.05) / 2,
            z: Math.max(size.z, 0.05) / 2,
          },
          0,
        );
        if (added.success) recast = added.obstacle;
      }
      this.flushTileCache();
    }
    this.obstacles.set(id, { kind, pose, size, recast });
    return id;
  }

  removeObstacle(id: string): void {
    const record = this.obstacles.get(id);
    this.obstacles.delete(id);
    if (record?.recast && this.tileCache) {
      this.tileCache.removeObstacle(record.recast);
      this.flushTileCache();
    }
  }

  addAgent(position: NavPoint, params?: NavAgentParams): string {
    if (!this.crowd) return "";
    const agent = this.crowd.addAgent(position, {
      radius: params?.radius ?? 0.5,
      height: params?.height ?? 1,
      maxSpeed: params?.maxSpeed ?? 3.5,
      maxAcceleration: params?.maxAcceleration ?? 8,
    });
    const id = `agent-${this.nextAgent}`;
    this.nextAgent += 1;
    this.agents.set(id, agent);
    return id;
  }

  stopAgent(id: string): void {
    this.agents.get(id)?.resetMoveTarget();
  }

  removeAgent(id: string): void {
    const agent = this.agents.get(id);
    if (!agent || !this.crowd) {
      this.agents.delete(id);
      return;
    }
    this.crowd.removeAgent(agent);
    this.agents.delete(id);
  }

  agentPosition(id: string): NavPoint | null {
    const agent = this.agents.get(id);
    if (!agent) return null;
    const point = agent.position();
    return { x: point.x, y: point.y, z: point.z };
  }

  agentVelocity(id: string): NavPoint | null {
    const agent = this.agents.get(id);
    if (!agent) return null;
    const point = agent.velocity();
    return { x: point.x, y: point.y, z: point.z };
  }

  setAgentTarget(id: string, target: NavPoint): boolean {
    const agent = this.agents.get(id);
    if (!agent) return false;
    return agent.requestMoveTarget(target);
  }

  stepCrowd(dtSeconds: number): void {
    this.flushTileCache();
    this.crowd?.update(dtSeconds);
  }

  private flushTileCache(): void {
    if (!this.tileCache || !this.navMesh) return;
    for (let i = 0; i < 64; i += 1) {
      const result = this.tileCache.update(this.navMesh);
      if (result.upToDate) break;
    }
    this.query?.destroy();
    this.query = new NavMeshQuery(this.navMesh);
  }

  private dispose(): void {
    this.crowd?.destroy();
    this.query?.destroy();
    this.tileCache?.destroy();
    this.navMesh?.destroy();
    this.crowd = null;
    this.query = null;
    this.tileCache = null;
    this.navMesh = null;
    this.tileCacheKeepAlive = [];
    this.obstacles.clear();
    this.agents.clear();
  }
}

export function createNavigationBackend(): NavigationBackend {
  return new RecastNavigationBackend();
}
