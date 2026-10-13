import {
  Crowd,
  Detour,
  type CrowdAgent,
  NavMesh,
  NavMeshQuery,
  Recast,
  type RecastBuildContext,
  TileCache,
  TileCacheMeshProcess,
  Raw,
  exportNavMesh,
  exportTileCache,
  importNavMesh,
  importTileCache,
  init,
  statusDetail,
  type Obstacle,
} from "@recast-navigation/core";
import {
  generateSoloNavMesh,
  generateTileCache,
  generateTiledNavMesh,
} from "@recast-navigation/generators";
import { DEFAULT_NAV_AGENT_PARAMS } from "./settings";
import {
  DEFAULT_NAV_MESH_SETTINGS,
  type NavAgentParams,
  type NavAgentDebugState,
  type NavCostVolume,
  type NavMeshGenerateInput,
  type NavMeshSettings,
  type NavObstacleKind,
  type NavPoint,
  type NavigationBackend,
} from "./types";

const QUERY_EXTENTS = { x: 4, y: 4, z: 4 };
const TILE_CACHE_MAGIC = new Uint8Array([0x42, 0x53, 0x4e, 0x54]); // BSNT
const WALKABLE_AREA = 63;
// Detour supports 64 area IDs; 0 and 63 are reserved for walkable polygons.
const MAX_COST_AREAS = WALKABLE_AREA - 1;
const WALKABLE_FLAGS = 1;
const DEFAULT_COST_AREA_COST = 10;
/** Tiled and tile-cache bakes split the input into square tiles of this many cells. */
const TILE_SIZE = 32;
/** Tile-cache layer budget per tile; a bake that overflows it is retried with twice the budget. */
const TILE_CACHE_LAYERS_PER_TILE = 4;
const TILE_CACHE_MAX_LAYERS_PER_TILE = 32;
const TILE_CACHE_MAX_OBSTACLES = 128;
/**
 * Obstacle adds and removes queue as tile-cache requests until an update. Detour holds at most 64 requests and
 * lists at most 64 distinct tiles to rebuild, and each request touches at most 8 tiles. Updates run before every
 * query, so the backlog is bounded by flushing at 8 requests: 8 x 8 touched tiles always fit the list. A tile the
 * list cannot hold would silently stay uncarved, so no request is queued behind an update that failed and has
 * not finished (`tileCacheStalled`).
 */
const TILE_CACHE_MAX_PENDING_REQUESTS = 8;
/** Crowd capacity; Detour places a new agent within (2, 1.5, 2) x the max agent radius. */
const CROWD_MAX_AGENTS = 128;
const CROWD_MAX_AGENT_RADIUS = 2;
const MAX_PATH_POLYS = 1024;
const MIN_OBSTACLE_EXTENT = 0.05;
/** Recast surfaces sit up to a few cells off the authored floor, so cost volumes reach this far past their box vertically. */
const COST_VOLUME_SURFACE_MARGIN = 0.5;
const COST_VOLUME_QUERY_POLYS = 512;

let recastReady: Promise<void> | null = null;

export function initNavigation(): Promise<void> {
  recastReady ??= init();
  return recastReady;
}

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

export function walkableTileCacheMeshProcess(): TileCacheMeshProcess {
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

function recastGenerateErrorMessage(error: string | undefined): Error {
  return new Error(
    error ? `generateNavMesh failed: ${error}` : "generateNavMesh failed",
  );
}

export function unwrapTileCacheBytes(bytes: Uint8Array): Uint8Array | null {
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
        result.tileCache.destroy();
        result.navMesh.destroy();
      }
    } finally {
      Raw.destroy(process.raw);
    }
  }
}

type LoadedNavMesh = {
  navMesh: NavMesh;
  tileCache: TileCache | null;
  release: (() => void) | null;
};

/** Decode baked bytes without touching any live navigation state. */
function loadNavMesh(bytes: Uint8Array): LoadedNavMesh {
  const tileBytes = unwrapTileCacheBytes(bytes);
  if (!tileBytes) return { navMesh: importNavMesh(bytes).navMesh, tileCache: null, release: null };
  const process = walkableTileCacheMeshProcess();
  try {
    const imported = importTileCache(tileBytes, process);
    return {
      navMesh: imported.navMesh,
      tileCache: imported.tileCache,
      release: () => {
        Raw.destroy(imported.allocator);
        Raw.destroy(imported.compressor);
        Raw.destroy(process.raw);
      },
    };
  } catch (error) {
    Raw.destroy(process.raw);
    throw error;
  }
}

class RecastNavigationBackend implements NavigationBackend {
  private navMesh: NavMesh | null = null;
  private query: NavMeshQuery | null = null;
  private crowd: Crowd | null = null;
  private tileCache: TileCache | null = null;
  private releaseTileCacheResources: (() => void) | null = null;
  private tileCacheDirty = false;
  /** Obstacle requests queued in the tile cache since its last update. */
  private pendingObstacleRequests = 0;
  /** An update failed with tile rebuilds unfinished; obstacle changes wait until a retry completes them. */
  private tileCacheStalled = false;
  private costVolumesDirty = false;
  private obstacles = new Map<string, Obstacle>();
  private nextObstacle = 1;
  private agents = new Map<string, CrowdAgent>();
  private nextAgent = 1;
  private costVolumes = new Map<
    string,
    { volume: NavCostVolume; polyRefs: number[] }
  >();
  private nextCost = 1;
  private costAreas = new Map<number, number>();

  importNavMesh(bytes: Uint8Array): void {
    // A failed decode leaves the current navmesh, crowd and obstacles live.
    const loaded = loadNavMesh(bytes);
    this.dispose();
    this.navMesh = loaded.navMesh;
    this.tileCache = loaded.tileCache;
    this.releaseTileCacheResources = loaded.release;
    this.query = new NavMeshQuery(this.navMesh);
    this.crowd = new Crowd(this.navMesh, {
      maxAgents: CROWD_MAX_AGENTS,
      maxAgentRadius: CROWD_MAX_AGENT_RADIUS,
    });
    // Move targets project onto the mesh with the same reach as path queries.
    this.crowd.navMeshQuery.defaultQueryHalfExtents = { ...QUERY_EXTENTS };
    this.applyAreaCosts();
  }

  findPath(from: NavPoint, to: NavPoint): NavPoint[] {
    this.flushPendingChanges();
    const query = this.query;
    if (!query) return [];
    const start = query.findNearestPoly(from, { halfExtents: QUERY_EXTENTS });
    const end = query.findNearestPoly(to, { halfExtents: QUERY_EXTENTS });
    if (!start.success || !end.success || !start.nearestRef || !end.nearestRef) return [];
    const corridor = query.findPath(start.nearestRef, end.nearestRef, from, to, {
      maxPathPolys: MAX_PATH_POLYS,
    });
    try {
      const count = corridor.polys.size;
      // Detour returns a partial corridor toward an unreachable goal; that is no path.
      if (!corridor.success || count === 0 || corridor.polys.get(count - 1) !== end.nearestRef) return [];
      const straight = query.findStraightPath(from, to, corridor.polys, {
        maxStraightPathPoints: MAX_PATH_POLYS,
      });
      try {
        if (!straight.success) return [];
        const points: NavPoint[] = [];
        for (let i = 0; i < straight.straightPathCount; i += 1) {
          points.push({
            x: straight.straightPath.get(i * 3),
            y: straight.straightPath.get(i * 3 + 1),
            z: straight.straightPath.get(i * 3 + 2),
          });
        }
        return points;
      } finally {
        straight.straightPath.destroy();
        straight.straightPathFlags.destroy();
        straight.straightPathRefs.destroy();
      }
    } finally {
      corridor.polys.destroy();
    }
  }

  closestPoint(point: NavPoint): NavPoint | null {
    this.flushPendingChanges();
    if (!this.query) return null;
    const result = this.query.findClosestPoint(point, { halfExtents: QUERY_EXTENTS });
    if (!result.success) return null;
    return { x: result.point.x, y: result.point.y, z: result.point.z };
  }

  randomPointInRadius(center: NavPoint, radius: number): NavPoint | null {
    this.flushPendingChanges();
    if (!this.query) return null;
    const result = this.query.findRandomPointAroundCircle(center, radius, {
      halfExtents: QUERY_EXTENTS,
    });
    if (!result.success) return null;
    return { x: result.randomPoint.x, y: result.randomPoint.y, z: result.randomPoint.z };
  }

  addObstacle(kind: NavObstacleKind, pose: NavPoint, size: NavPoint, yaw = 0): string {
    const tileCache = this.tileCache;
    if (!tileCache || !this.tileCacheReady()) return "";
    const extent = (value: number) => Math.max(Math.abs(value), MIN_OBSTACLE_EXTENT);
    const request = (): { success: boolean; obstacle?: Obstacle } => {
      if (kind === "cylinder") {
        // Tile-cache cylinders stand on their base; callers pass the volume center.
        const height = extent(size.y);
        return tileCache.addCylinderObstacle(
          { x: pose.x, y: pose.y - height / 2, z: pose.z },
          Math.max(extent(size.x), extent(size.z)) / 2,
          height,
        );
      }
      return tileCache.addBoxObstacle(
        pose,
        { x: extent(size.x) / 2, y: extent(size.y) / 2, z: extent(size.z) / 2 },
        Number.isFinite(yaw) ? yaw : 0,
      );
    };
    let added = request();
    // A removal frees its obstacle slot only when the queue is applied, so a full cache retries once after that.
    if ((!added.success || !added.obstacle) && this.pendingObstacleRequests > 0) {
      this.flushTileCache();
      if (!this.tileCacheStalled) added = request();
    }
    // A full tile cache carves nothing, so the caller gets no id to remove.
    if (!added.success || !added.obstacle) return "";
    const id = `obstacle-${this.nextObstacle}`;
    this.nextObstacle += 1;
    this.obstacles.set(id, added.obstacle);
    this.queueObstacleRequest();
    return id;
  }

  removeObstacle(id: string): void {
    const obstacle = this.obstacles.get(id);
    if (!obstacle || !this.tileCache) return;
    // Keep the id while the carve is still in place so removal can be retried.
    if (!this.tileCacheReady() || !this.tileCache.removeObstacle(obstacle).success) return;
    this.obstacles.delete(id);
    this.queueObstacleRequest();
  }

  applyCostVolume(volume: NavCostVolume): void {
    const cost =
      Number.isFinite(volume.cost) && volume.cost > 1
        ? volume.cost
        : DEFAULT_COST_AREA_COST;
    const id = volume.id?.trim() ? volume.id : `cost-${this.nextCost++}`;
    const record: NavCostVolume = {
      id,
      kind: volume.kind === "cylinder" ? "cylinder" : "box",
      pose: { ...volume.pose },
      size: { ...volume.size },
      cost,
    };
    const previous = this.costVolumes.get(id);
    const before = previous?.volume;
    if (before?.cost !== cost) {
      const distinctCosts = new Set([cost]);
      for (const [otherId, other] of this.costVolumes) {
        if (otherId !== id) distinctCosts.add(other.volume.cost);
      }
      if (distinctCosts.size > MAX_COST_AREAS) {
        throw new RangeError(`Navigation supports at most ${MAX_COST_AREAS} distinct volume costs.`);
      }
    }
    const changed = !before || before.cost !== record.cost || before.kind !== record.kind ||
      before.pose.x !== record.pose.x || before.pose.y !== record.pose.y || before.pose.z !== record.pose.z ||
      before.size.x !== record.size.x || before.size.y !== record.size.y || before.size.z !== record.size.z;
    // Keep the previous polygon refs until the batch restores their old areas.
    this.costVolumes.set(id, { volume: record, polyRefs: previous?.polyRefs ?? [] });
    if (changed) this.costVolumesDirty = true;
  }

  removeCostVolume(id: string): void {
    const record = this.costVolumes.get(id);
    if (!record) return;
    const walkable = this.walkablePolyArea();
    for (const ref of record.polyRefs) {
      if (ref) this.navMesh?.setPolyArea(ref, walkable);
    }
    this.costVolumes.delete(id);
    // Overlapping volumes and the area table restamp before the next query.
    this.costVolumesDirty = true;
  }

  addAgent(position: NavPoint, params?: NavAgentParams): string {
    this.flushPendingChanges();
    // Detour has no slot for another agent once the crowd is full.
    if (!this.crowd || this.agents.size >= CROWD_MAX_AGENTS) return "";
    const agent = this.crowd.addAgent(position, {
      radius: params?.radius ?? DEFAULT_NAV_AGENT_PARAMS.radius,
      height: params?.height ?? DEFAULT_NAV_AGENT_PARAMS.height,
      maxSpeed: params?.maxSpeed ?? DEFAULT_NAV_AGENT_PARAMS.maxSpeed,
      maxAcceleration: params?.maxAcceleration ?? DEFAULT_NAV_AGENT_PARAMS.maxAcceleration,
    });
    if (agent.agentIndex < 0) {
      delete this.crowd.agents[agent.agentIndex];
      return "";
    }
    const id = `agent-${this.nextAgent}`;
    this.nextAgent += 1;
    this.agents.set(id, agent);
    return id;
  }

  updateAgent(id: string, params: NavAgentParams): void {
    const agent = this.agents.get(id);
    if (!agent) return;
    const next: {
      radius?: number;
      height?: number;
      maxSpeed?: number;
      maxAcceleration?: number;
    } = {};
    if (typeof params.radius === "number" && Number.isFinite(params.radius)) {
      next.radius = params.radius;
    }
    if (typeof params.height === "number" && Number.isFinite(params.height)) {
      next.height = params.height;
    }
    if (typeof params.maxSpeed === "number" && Number.isFinite(params.maxSpeed)) {
      next.maxSpeed = params.maxSpeed;
    }
    if (
      typeof params.maxAcceleration === "number" &&
      Number.isFinite(params.maxAcceleration)
    ) {
      next.maxAcceleration = params.maxAcceleration;
    }
    if (Object.keys(next).length === 0) return;
    agent.updateParameters(next);
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

  agentDebugState(id: string): NavAgentDebugState | null {
    const agent = this.agents.get(id);
    if (!agent) return null;
    const request = agent.raw.targetState;
    const hasTarget = request !== Detour.DT_CROWDAGENT_TARGET_NONE &&
      request !== Detour.DT_CROWDAGENT_TARGET_VELOCITY;
    const position = agent.position();
    const velocity = agent.velocity();
    const target = hasTarget ? agent.target() : null;
    const corners = hasTarget ? agent.corners() : [];
    const arrived = target !== null && Math.hypot(target.x - position.x, target.z - position.z) <= agent.radius &&
      Math.hypot(velocity.x, velocity.y, velocity.z) < 0.05;
    const state = agent.state() === Detour.DT_CROWDAGENT_STATE_INVALID ? "invalid" :
      agent.state() === Detour.DT_CROWDAGENT_STATE_OFFMESH ? "off mesh" :
      request === Detour.DT_CROWDAGENT_TARGET_FAILED ? "failed" :
      !hasTarget ? "idle" : arrived ? "arrived" :
      request === Detour.DT_CROWDAGENT_TARGET_VALID ? "moving" : "planning";
    return {
      position, velocity, radius: agent.radius, height: agent.height, target,
      path: corners.length > 0 && !arrived ? [position, ...corners] : [],
      state,
    };
  }

  syncAgentPosition(id: string, position: NavPoint): boolean {
    const agent = this.agents.get(id);
    const projected = this.closestPoint(position);
    if (!agent || !projected) return false;
    // Detour moves the corridor to npos during update. teleport() would reset
    // both the target and accumulated velocity, preventing physical steering.
    agent.raw.set_npos(0, projected.x);
    agent.raw.set_npos(1, projected.y);
    agent.raw.set_npos(2, projected.z);
    return true;
  }

  setAgentTarget(id: string, target: NavPoint): boolean {
    this.flushPendingChanges();
    const agent = this.agents.get(id);
    if (!agent) return false;
    return agent.requestMoveTarget(target);
  }

  stepCrowd(dtSeconds: number): void {
    this.flushPendingChanges();
    this.crowd?.update(dtSeconds);
  }

  /**
   * An obstacle add or remove is queued, not carved: every query and crowd step flushes first, so a batch of
   * changes rebuilds each touched tile and restamps the cost volumes once.
   */
  private queueObstacleRequest(): void {
    this.tileCacheDirty = true;
    this.pendingObstacleRequests += 1;
    if (this.pendingObstacleRequests >= TILE_CACHE_MAX_PENDING_REQUESTS) this.flushTileCache();
  }

  /**
   * Whether the tile cache can take another obstacle request. After a failed update it first retries the
   * unfinished rebuilds, and while they stay unfinished it takes none: `addObstacle` then returns no id and
   * `removeObstacle` keeps the obstacle, so the caller can try again later.
   */
  private tileCacheReady(): boolean {
    if (this.tileCacheStalled) this.flushTileCache();
    return !this.tileCacheStalled;
  }

  private flushTileCache(): void {
    if (!this.tileCacheDirty || !this.tileCache || !this.navMesh) return;
    this.restoreCostVolumePolys();
    // Each update rebuilds one touched tile; finish them all before the next query.
    for (;;) {
      const result = this.tileCache.update(this.navMesh);
      if (result.upToDate) {
        this.tileCacheDirty = false;
        this.tileCacheStalled = false;
        this.pendingObstacleRequests = 0;
        break;
      }
      if (!result.success) {
        this.tileCacheStalled = true;
        break;
      }
    }
    // Detour queries retain the same mutable NavMesh. Tile rebuilds do not
    // require allocating a replacement query; only stamped areas need refresh.
    this.costVolumesDirty = true;
  }

  private flushPendingChanges(): void {
    this.flushTileCache();
    if (this.costVolumesDirty) {
      this.restoreCostVolumePolys();
      this.applyAreaCosts();
      this.stampCostVolumes();
      this.costVolumesDirty = false;
    }
  }

  private walkablePolyArea(): number {
    return this.tileCache ? WALKABLE_AREA : 0;
  }

  private restoreCostVolumePolys(): void {
    if (!this.navMesh) return;
    const walkable = this.walkablePolyArea();
    for (const record of this.costVolumes.values()) {
      for (const ref of record.polyRefs) {
        if (!ref) continue;
        this.navMesh.setPolyArea(ref, walkable);
      }
      record.polyRefs = [];
    }
  }

  private applyAreaCosts(): void {
    const costs = [...new Set([...this.costVolumes.values()].map((record) => record.volume.cost))].sort((a, b) => a - b);
    this.costAreas = new Map(costs.map((cost, index) => [cost, index + 1]));
    const walkable = 1;
    this.query?.defaultFilter.setAreaCost(0, walkable);
    this.query?.defaultFilter.setAreaCost(WALKABLE_AREA, walkable);
    const crowdFilter = this.crowd?.getFilter(0);
    crowdFilter?.setAreaCost(0, walkable);
    crowdFilter?.setAreaCost(WALKABLE_AREA, walkable);
    for (const [cost, area] of this.costAreas) {
      this.query?.defaultFilter.setAreaCost(area, cost);
      crowdFilter?.setAreaCost(area, cost);
    }
  }

  private stampCostVolumes(): void {
    if (!this.query || !this.navMesh) return;
    // More expensive overlapping volumes win independently of insertion order.
    const volumes = [...this.costVolumes.values()].sort((a, b) => a.volume.cost - b.volume.cost);
    for (const record of volumes) {
      const refs: number[] = [];
      for (const ref of this.costVolumePolys(this.query, record.volume)) {
        if (!ref) continue;
        this.navMesh.setPolyArea(ref, this.costAreas.get(record.volume.cost)!);
        refs.push(ref);
      }
      record.polyRefs = refs;
    }
  }

  /** Every polygon overlapping the volume's box, growing the result buffer until none are left out. */
  private costVolumePolys(query: NavMeshQuery, volume: NavCostVolume): number[] {
    const halfExtents = costVolumeHalfExtents(volume);
    for (let maxPolys = COST_VOLUME_QUERY_POLYS; ; maxPolys *= 2) {
      const result = query.queryPolygons(volume.pose, halfExtents, { maxPolys });
      if (!result.success) return [];
      if (!statusDetail(result.status, Detour.DT_BUFFER_TOO_SMALL)) return result.polyRefs;
    }
  }

  dispose(): void {
    this.crowd?.destroy();
    if (this.query) {
      this.query.destroy();
      // Recast's query wrapper does not release its separately allocated filter.
      Raw.destroy(this.query.defaultFilter.raw);
    }
    this.tileCache?.destroy();
    this.navMesh?.destroy();
    this.crowd = null;
    this.query = null;
    this.tileCache = null;
    this.navMesh = null;
    this.releaseTileCacheResources?.();
    this.releaseTileCacheResources = null;
    this.tileCacheDirty = false;
    this.pendingObstacleRequests = 0;
    this.tileCacheStalled = false;
    this.costVolumesDirty = false;
    this.obstacles.clear();
    this.agents.clear();
    this.costVolumes.clear();
    this.costAreas.clear();
  }
}

/** The box Detour searches for a volume's polygons; a cylinder uses its bounding box. */
function costVolumeHalfExtents(volume: NavCostVolume): NavPoint {
  return {
    x: Math.max(Math.abs(volume.size.x), MIN_OBSTACLE_EXTENT) / 2,
    y: Math.max(Math.abs(volume.size.y), MIN_OBSTACLE_EXTENT) / 2 + COST_VOLUME_SURFACE_MARGIN,
    z: Math.max(Math.abs(volume.size.z), MIN_OBSTACLE_EXTENT) / 2,
  };
}

export function createNavigationBackend(): NavigationBackend {
  return new RecastNavigationBackend();
}
