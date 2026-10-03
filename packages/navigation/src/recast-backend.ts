import {
  Crowd,
  Detour,
  type CrowdAgent,
  NavMesh,
  NavMeshQuery,
  TileCache,
  TileCacheMeshProcess,
  Raw,
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
      throw recastGenerateErrorMessage(
        "error" in result ? result.error : undefined,
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

class RecastNavigationBackend implements NavigationBackend {
  private navMesh: NavMesh | null = null;
  private query: NavMeshQuery | null = null;
  private crowd: Crowd | null = null;
  private tileCache: TileCache | null = null;
  private releaseTileCacheResources: (() => void) | null = null;
  private tileCacheDirty = false;
  private costVolumesDirty = false;
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
  private costVolumes = new Map<
    string,
    { volume: NavCostVolume; polyRefs: number[] }
  >();
  private nextCost = 1;
  private costAreas = new Map<number, number>();

  importNavMesh(bytes: Uint8Array): void {
    this.dispose();
    const tileBytes = unwrapTileCacheBytes(bytes);
    if (tileBytes) {
      const process = walkableTileCacheMeshProcess();
      try {
        const imported = importTileCache(tileBytes, process);
        this.navMesh = imported.navMesh;
        this.tileCache = imported.tileCache;
        this.releaseTileCacheResources = () => {
          Raw.destroy(imported.allocator);
          Raw.destroy(imported.compressor);
          Raw.destroy(process.raw);
        };
      } catch (error) {
        Raw.destroy(process.raw);
        throw error;
      }
    } else {
      const imported = importNavMesh(bytes);
      this.navMesh = imported.navMesh;
    }
    this.query = new NavMeshQuery(this.navMesh);
    this.crowd = new Crowd(this.navMesh, { maxAgents: 32, maxAgentRadius: 0.6 });
    this.applyAreaCosts();
  }

  findPath(from: NavPoint, to: NavPoint): NavPoint[] {
    this.flushPendingChanges();
    if (!this.query) return [];
    const result = this.query.computePath(from, to, { halfExtents: QUERY_EXTENTS });
    if (!result.success) return [];
    return result.path.map((point) => ({ x: point.x, y: point.y, z: point.z }));
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
      if (recast) this.tileCacheDirty = true;
      this.flushTileCache();
    }
    this.obstacles.set(id, { kind, pose, size, recast });
    return id;
  }

  removeObstacle(id: string): void {
    const record = this.obstacles.get(id);
    this.obstacles.delete(id);
    if (record?.recast && this.tileCache) {
      const removed = this.tileCache.removeObstacle(record.recast);
      if (removed.success) this.tileCacheDirty = true;
      this.flushTileCache();
    }
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

  addAgent(position: NavPoint, params?: NavAgentParams): string {
    this.flushPendingChanges();
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

  private flushTileCache(): void {
    if (!this.tileCacheDirty || !this.tileCache || !this.navMesh) return;
    this.restoreCostVolumePolys();
    for (let i = 0; i < 64; i += 1) {
      const result = this.tileCache.update(this.navMesh);
      if (result.upToDate) { this.tileCacheDirty = false; break; }
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
      const halfExtents = costVolumeHalfExtents(record.volume);
      const result = this.query.queryPolygons(record.volume.pose, halfExtents, {
        maxPolys: 512,
      });
      if (!result.success) continue;
      const refs: number[] = [];
      for (const ref of result.polyRefs) {
        if (!ref) continue;
        this.navMesh.setPolyArea(ref, this.costAreas.get(record.volume.cost)!);
        refs.push(ref);
      }
      record.polyRefs = refs;
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
    this.costVolumesDirty = false;
    this.obstacles.clear();
    this.agents.clear();
    this.costVolumes.clear();
    this.costAreas.clear();
  }
}

function costVolumeHalfExtents(volume: NavCostVolume): NavPoint {
  if (volume.kind === "cylinder") {
    const radius = Math.max(Math.abs(volume.size.x), 0.05);
    return {
      x: radius,
      y: Math.max(Math.abs(volume.size.y) / 2, 4),
      z: radius,
    };
  }
  return {
    x: Math.max(Math.abs(volume.size.x) / 2, 0.05),
    y: Math.max(Math.abs(volume.size.y) / 2, 4),
    z: Math.max(Math.abs(volume.size.z) / 2, 0.05),
  };
}

export function createNavigationBackend(): NavigationBackend {
  return new RecastNavigationBackend();
}
