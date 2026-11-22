import {
  Crowd,
  CrowdAgent,
  Detour,
  NavMesh,
  NavMeshQuery,
  TileCache,
  TileCacheMeshProcess,
  Raw,
  crowdAgentParamsDefaults,
  init,
  statusDetail,
  type CrowdAgentParams,
  type CylinderObstacle,
  type Obstacle,
} from "@recast-navigation/core";
import { DEFAULT_NAV_AGENT_PARAMS } from "./settings";
import {
  type NavAgentParams,
  type NavAgentDebugState,
  type NavCostVolume,
  type NavObstacleKind,
  type NavPoint,
  type NavigationBackend,
} from "./types";

const QUERY_EXTENTS = { x: 4, y: 4, z: 4 };
const TILE_CACHE_MAGIC = new Uint8Array([0x48, 0x50, 0x4e, 0x54]); // HPNT
const WALKABLE_AREA = 63;
// Detour supports 64 area IDs; 0 and 63 are reserved for walkable polygons.
const MAX_COST_AREAS = WALKABLE_AREA - 1;
const WALKABLE_FLAGS = 1;
const DEFAULT_COST_AREA_COST = 10;
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

/**
 * Loads this context's Recast module, for a backend to import into (`createNavigationBackend`). It stays loaded while
 * something holds it: a backend holding a navmesh, or `withNavigation` work. When the last of them lets go, the module
 * unloads (`unloadNavigation`), and a later import needs this again.
 */
export function initNavigation(): Promise<void> {
  return loadNavigation();
}

function loadNavigation(): Promise<void> {
  recastReady ??= init();
  return recastReady;
}

/** Holders of this context's Recast module: unfinished `withNavigation` work, and backends holding a navmesh. */
let holders = 0;

function holdNavigation(): void {
  holders += 1;
}

/** Lets go of the module, and unloads it when nothing holds it any more. */
function releaseNavigation(): void {
  holders -= 1;
  if (holders === 0) unloadNavigation();
}

/**
 * Runs `work` with the Recast module loaded and held: for short work that leaves no Recast object alive (the main
 * thread's navmesh overlay, which decodes a bake into debug triangles). The module unloads once nothing holds it, so a
 * context that only does such work keeps none of the module's memory between them; the next work loads it again.
 */
export async function withNavigation<T>(work: () => T | Promise<T>): Promise<T> {
  holdNavigation();
  try {
    await loadNavigation();
    return await work();
  } finally {
    releaseNavigation();
  }
}

/** Whether the Recast module is loaded (or loading) in this context. */
export function navigationLoaded(): boolean {
  return recastReady !== null;
}

/**
 * Drops this context's Recast module, its WebAssembly memory with it, so the next `initNavigation` loads a new one.
 * Only once nothing holds it (`releaseNavigation`): a live Recast object would point into the dropped memory.
 */
function unloadNavigation(): void {
  if (!recastReady) return;
  const raw = Raw as unknown as Record<string, unknown>;
  for (const key of Object.keys(raw)) if (key !== "isNull" && key !== "destroy") delete raw[key];
  recastReady = null;
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

/**
 * Frees a tile cache whole: Recast's `TileCache.destroy` frees Detour's tile cache but not the wrapper object that held
 * it, which the generator or importer allocated.
 */
export function destroyTileCache(tileCache: TileCache): void {
  tileCache.destroy();
  Raw.destroy(tileCache.raw);
}

/** A decoded bake: its navmesh, and for a tile-cache bake its tile cache and the allocator and compressor it uses. */
export type ImportedNavMesh = {
  navMesh: NavMesh;
  tileCache: { tileCache: TileCache; allocator: unknown; compressor: unknown } | null;
};

/**
 * Recast's `importNavMesh` / `importTileCache`, without the request each leaves on the heap: they never free the
 * `NavMeshExport` that hands Recast the bytes. The importer copies what it keeps, so the bytes and request are freed here.
 */
export function importBakedNavMesh(bytes: Uint8Array, meshProcess: TileCacheMeshProcess | null): ImportedNavMesh {
  const module = Raw.Module;
  const pointer = module._malloc(bytes.byteLength);
  const request = new module.NavMeshExport();
  try {
    module.HEAPU8.set(bytes, pointer);
    request.dataPointer = pointer;
    request.size = bytes.byteLength;
    // The result is the importer's static record: nothing to free but what it points to.
    const result = Raw.NavMeshImporter.importNavMesh(request, meshProcess?.raw as never);
    const navMesh = new NavMesh(result.navMesh);
    if (!meshProcess) return { navMesh, tileCache: null };
    return { navMesh, tileCache: { tileCache: new TileCache(result.tileCache), allocator: result.allocator, compressor: result.compressor } };
  } finally {
    Raw.destroy(request);
    module._free(pointer);
  }
}

/** Frees everything an import made (`importBakedNavMesh`). */
export function destroyImportedNavMesh(imported: ImportedNavMesh): void {
  if (imported.tileCache) {
    destroyTileCache(imported.tileCache.tileCache);
    Raw.destroy(imported.tileCache.allocator);
    Raw.destroy(imported.tileCache.compressor);
  }
  imported.navMesh.destroy();
}

/** Writes `params` over Recast's defaults into a Detour agent parameter record. */
function writeAgentParams(target: InstanceType<typeof Raw.Module.dtCrowdAgentParams>, params: CrowdAgentParams): void {
  target.radius = params.radius;
  target.height = params.height;
  target.maxAcceleration = params.maxAcceleration;
  target.maxSpeed = params.maxSpeed;
  target.collisionQueryRange = params.collisionQueryRange;
  target.pathOptimizationRange = params.pathOptimizationRange;
  target.separationWeight = params.separationWeight;
  target.updateFlags = params.updateFlags;
  target.obstacleAvoidanceType = params.obstacleAvoidanceType;
  target.queryFilterType = params.queryFilterType;
  target.userData = params.userData;
}

/**
 * Recast's `Crowd.addAgent`, freeing the parameter record it leaves on the heap (Detour copies it into the agent).
 * Null when the crowd has no free slot.
 */
function addCrowdAgent(crowd: Crowd, position: NavPoint, params: Partial<CrowdAgentParams>): CrowdAgent | null {
  const record = new Raw.Module.dtCrowdAgentParams();
  try {
    writeAgentParams(record, { ...crowdAgentParamsDefaults, ...params });
    const index = crowd.raw.addAgent([position.x, position.y, position.z], record);
    if (index < 0) return null;
    const agent = new CrowdAgent(crowd, index);
    crowd.agents[index] = agent;
    return agent;
  } finally {
    Raw.destroy(record);
  }
}

/**
 * Recast's `TileCache.addCylinderObstacle`, freeing the position it leaves on the heap (its box obstacles free theirs).
 */
function addCylinderObstacle(tileCache: TileCache, position: NavPoint, radius: number, height: number): { success: boolean; obstacle?: Obstacle } {
  const rawPosition = new Raw.Module.Vec3(position.x, position.y, position.z);
  try {
    const result = tileCache.raw.addCylinderObstacle(rawPosition, radius, height);
    if (result.status !== Detour.DT_SUCCESS) return { success: false };
    const obstacle: CylinderObstacle = { type: "cylinder", ref: result.ref, position: { ...position }, radius, height };
    tileCache.obstacles.set(obstacle.ref, obstacle);
    return { success: true, obstacle };
  } finally {
    Raw.destroy(rawPosition);
  }
}

/** Marks tile-cache bake bytes (`HPNT`), which `loadNavMesh` imports with a tile cache. */
export function wrapTileCacheBytes(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(TILE_CACHE_MAGIC.length + bytes.byteLength);
  out.set(TILE_CACHE_MAGIC, 0);
  out.set(bytes, TILE_CACHE_MAGIC.length);
  return out;
}

export function unwrapTileCacheBytes(bytes: Uint8Array): Uint8Array | null {
  if (bytes.byteLength < TILE_CACHE_MAGIC.length) return null;
  for (let i = 0; i < TILE_CACHE_MAGIC.length; i += 1) {
    if (bytes[i] !== TILE_CACHE_MAGIC[i]) return null;
  }
  return bytes.subarray(TILE_CACHE_MAGIC.length);
}

type LoadedNavMesh = {
  imported: ImportedNavMesh;
  /** The tile-cache bake's mesh process, which its tile cache calls for every rebuilt tile. */
  meshProcess: TileCacheMeshProcess | null;
};

/** Decode baked bytes without touching any live navigation state. */
function loadNavMesh(bytes: Uint8Array): LoadedNavMesh {
  const tileBytes = unwrapTileCacheBytes(bytes);
  if (!tileBytes) return { imported: importBakedNavMesh(bytes, null), meshProcess: null };
  const meshProcess = walkableTileCacheMeshProcess();
  try {
    return { imported: importBakedNavMesh(tileBytes, meshProcess), meshProcess };
  } catch (error) {
    Raw.destroy(meshProcess.raw);
    throw error;
  }
}

class RecastNavigationBackend implements NavigationBackend {
  private loaded: LoadedNavMesh | null = null;
  private navMesh: NavMesh | null = null;
  private query: NavMeshQuery | null = null;
  private crowd: Crowd | null = null;
  private tileCache: TileCache | null = null;
  /** Whether this backend holds the Recast module (`holdNavigation`): from its first import until `dispose`. */
  private holdsModule = false;
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
  /** Each agent's last `syncAgentPosition`: the position it got, where it projected, and the navmesh it read. */
  private readonly agentSyncs = new Map<string, AgentSync>();
  /** Advances on an import, a dispose and each flush that rebuilt tiles or restamped areas, which can move a projection. */
  private meshRevision = 0;
  private costVolumes = new Map<
    string,
    { volume: NavCostVolume; polyRefs: number[] }
  >();
  private nextCost = 1;
  private costAreas = new Map<number, number>();

  importNavMesh(bytes: Uint8Array): void {
    // A failed decode leaves the current navmesh, crowd and obstacles live.
    const loaded = loadNavMesh(bytes);
    if (!this.holdsModule) {
      holdNavigation();
      this.holdsModule = true;
    }
    this.releaseNavMesh();
    this.loaded = loaded;
    this.navMesh = loaded.imported.navMesh;
    this.tileCache = loaded.imported.tileCache?.tileCache ?? null;
    this.query = new NavMeshQuery(this.navMesh);
    this.crowd = new Crowd(this.navMesh, {
      maxAgents: CROWD_MAX_AGENTS,
      maxAgentRadius: CROWD_MAX_AGENT_RADIUS,
    });
    // Move targets project onto the mesh with the same reach as path queries.
    this.crowd.navMeshQuery.defaultQueryHalfExtents = { ...QUERY_EXTENTS };
    this.applyAreaCosts();
    this.meshRevision += 1;
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

  navMeshRevision(): number {
    this.flushPendingChanges();
    return this.meshRevision;
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
        return addCylinderObstacle(
          tileCache,
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
    const agent = addCrowdAgent(this.crowd, position, {
      radius: params?.radius ?? DEFAULT_NAV_AGENT_PARAMS.radius,
      height: params?.height ?? DEFAULT_NAV_AGENT_PARAMS.height,
      maxSpeed: params?.maxSpeed ?? DEFAULT_NAV_AGENT_PARAMS.maxSpeed,
      maxAcceleration: params?.maxAcceleration ?? DEFAULT_NAV_AGENT_PARAMS.maxAcceleration,
    });
    if (!agent) return "";
    const id = `agent-${this.nextAgent}`;
    this.nextAgent += 1;
    this.agents.set(id, agent);
    return id;
  }

  updateAgent(id: string, params: NavAgentParams): void {
    const agent = this.agents.get(id);
    if (!agent) return;
    // Written into the agent's own parameters, as Detour's `updateAgentParameters` copies them: Recast's
    // `updateParameters` would leave a parameter record on the heap for every call.
    const finite = (value: number | undefined): value is number => typeof value === "number" && Number.isFinite(value);
    if (finite(params.radius)) agent.radius = params.radius;
    if (finite(params.height)) agent.height = params.height;
    if (finite(params.maxSpeed)) agent.maxSpeed = params.maxSpeed;
    if (finite(params.maxAcceleration)) agent.maxAcceleration = params.maxAcceleration;
  }

  stopAgent(id: string): void {
    this.agents.get(id)?.resetMoveTarget();
  }

  removeAgent(id: string): void {
    const agent = this.agents.get(id);
    this.agentSyncs.delete(id);
    if (!agent || !this.crowd) {
      this.agents.delete(id);
      return;
    }
    this.crowd.removeAgent(agent);
    this.agents.delete(id);
  }

  agentPosition(id: string): NavPoint | null {
    const point = { x: 0, y: 0, z: 0 };
    return this.agentPositionInto(id, point) ? point : null;
  }

  agentVelocity(id: string): NavPoint | null {
    const point = { x: 0, y: 0, z: 0 };
    return this.agentVelocityInto(id, point) ? point : null;
  }

  agentPositionInto(id: string, out: NavPoint): boolean {
    const raw = this.agents.get(id)?.raw;
    if (!raw) return false;
    out.x = raw.get_npos(0);
    out.y = raw.get_npos(1);
    out.z = raw.get_npos(2);
    return true;
  }

  agentVelocityInto(id: string, out: NavPoint): boolean {
    const raw = this.agents.get(id)?.raw;
    if (!raw) return false;
    out.x = raw.get_vel(0);
    out.y = raw.get_vel(1);
    out.z = raw.get_vel(2);
    return true;
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
    // As `closestPoint` would, so the revision below covers every pending change.
    this.flushPendingChanges();
    const agent = this.agents.get(id);
    const last = this.agentSyncs.get(id);
    // The same input over the same navmesh projects to the same point. npos holds
    // that point exactly (both are float32) unless the crowd step moved it since.
    if (agent && last && last.revision === this.meshRevision &&
      last.x === position.x && last.y === position.y && last.z === position.z &&
      agent.raw.get_npos(0) === last.px && agent.raw.get_npos(1) === last.py && agent.raw.get_npos(2) === last.pz) {
      return true;
    }
    const projected = this.closestPoint(position);
    if (!agent || !projected) {
      this.agentSyncs.delete(id);
      return false;
    }
    // Detour moves the corridor to npos during update. teleport() would reset
    // both the target and accumulated velocity, preventing physical steering.
    agent.raw.set_npos(0, projected.x);
    agent.raw.set_npos(1, projected.y);
    agent.raw.set_npos(2, projected.z);
    const sync = last ?? { x: 0, y: 0, z: 0, px: 0, py: 0, pz: 0, revision: 0 };
    sync.x = position.x;
    sync.y = position.y;
    sync.z = position.z;
    sync.px = projected.x;
    sync.py = projected.y;
    sync.pz = projected.z;
    sync.revision = this.meshRevision;
    this.agentSyncs.set(id, sync);
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
    this.meshRevision += 1;
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
      this.meshRevision += 1;
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

  /** Frees the navmesh and everything built on it, and lets go of the Recast module. Idempotent. */
  dispose(): void {
    this.releaseNavMesh();
    if (this.holdsModule) {
      this.holdsModule = false;
      releaseNavigation();
    }
  }

  /** Frees the navmesh and everything built on it; the backend keeps holding the module. */
  private releaseNavMesh(): void {
    // Recast's NavMeshQuery.destroy frees only the native query, leaving its C++ wrapper and default filter allocated,
    // and the crowd holds a second such wrapper and filter. Deleting a wrapper never frees the query it points to, so
    // the crowd's wrapper is released here while freeing the crowd frees that query.
    if (this.crowd) {
      Raw.destroy(this.crowd.navMeshQuery.defaultFilter.raw);
      Raw.destroy(this.crowd.navMeshQuery.raw);
    }
    this.crowd?.destroy();
    if (this.query) {
      this.query.destroy();
      Raw.destroy(this.query.defaultFilter.raw);
      Raw.destroy(this.query.raw);
    }
    if (this.loaded) {
      destroyImportedNavMesh(this.loaded.imported);
      if (this.loaded.meshProcess) Raw.destroy(this.loaded.meshProcess.raw);
    }
    this.loaded = null;
    this.crowd = null;
    this.query = null;
    this.tileCache = null;
    this.navMesh = null;
    this.meshRevision += 1;
    this.tileCacheDirty = false;
    this.pendingObstacleRequests = 0;
    this.tileCacheStalled = false;
    this.costVolumesDirty = false;
    this.obstacles.clear();
    this.agents.clear();
    this.agentSyncs.clear();
    this.costVolumes.clear();
    this.costAreas.clear();
  }
}

type AgentSync = { x: number; y: number; z: number; px: number; py: number; pz: number; revision: number };

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
