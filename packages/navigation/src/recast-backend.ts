import {
  Crowd,
  type CrowdAgent,
  NavMesh,
  NavMeshQuery,
  exportNavMesh,
  importNavMesh,
  init,
} from "@recast-navigation/core";
import { generateSoloNavMesh } from "@recast-navigation/generators";
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

export async function generateNavMesh(input: NavMeshGenerateInput): Promise<Uint8Array> {
  await initNavigation();
  const settings = { ...DEFAULT_NAV_MESH_SETTINGS, ...input.settings };
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
  private obstacles = new Map<string, { kind: NavObstacleKind; pose: NavPoint; size: NavPoint }>();
  private nextObstacle = 1;
  private agents = new Map<string, CrowdAgent>();
  private nextAgent = 1;

  importNavMesh(bytes: Uint8Array): void {
    this.dispose();
    const imported = importNavMesh(bytes);
    this.navMesh = imported.navMesh;
    this.query = new NavMeshQuery(imported.navMesh);
    this.crowd = new Crowd(imported.navMesh, { maxAgents: 8, maxAgentRadius: 0.6 });
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
    this.obstacles.set(id, { kind, pose, size });
    return id;
  }

  removeObstacle(id: string): void {
    this.obstacles.delete(id);
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
    this.crowd?.update(dtSeconds);
  }

  private dispose(): void {
    this.crowd?.destroy();
    this.query?.destroy();
    this.navMesh?.destroy();
    this.crowd = null;
    this.query = null;
    this.navMesh = null;
    this.obstacles.clear();
    this.agents.clear();
  }
}

export function createNavigationBackend(): NavigationBackend {
  return new RecastNavigationBackend();
}
