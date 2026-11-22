import type { OrientedConnection } from "./graph-connect";

export type ProximityPin = {
  nodeId: string;
  pinId: string;
  direction: "in" | "out";
  /** Measured handle center in graph coordinates. */
  x: number;
  y: number;
};

type ProximityEdge = Pick<OrientedConnection, "source" | "target"> & {
  sourceHandle?: string | null;
  targetHandle?: string | null;
};

type ProximityOptions = {
  pins: readonly ProximityPin[];
  edges: readonly ProximityEdge[];
  movingNodeIds: ReadonlySet<string>;
  /** Graph-coordinate radius; callers divide screen pixels by viewport zoom. */
  maxDistance: number;
  resolveConnection?: (
    connection: OrientedConnection,
  ) => OrientedConnection | null;
  isValidConnection: (connection: OrientedConnection) => boolean;
};

function pinKey(nodeId: string, pinId: string): string {
  return `${nodeId}\u0000${pinId}`;
}

/** Edges stay the same array for a whole node drag, so each tick reuses its pin set. */
const occupiedByEdges = new WeakMap<readonly ProximityEdge[], ReadonlySet<string>>();

function occupiedPins(edges: readonly ProximityEdge[]): ReadonlySet<string> {
  const cached = occupiedByEdges.get(edges);
  if (cached) return cached;
  const occupied = new Set<string>();
  for (const edge of edges) {
    if (edge.sourceHandle != null) {
      occupied.add(pinKey(edge.source, edge.sourceHandle));
    }
    if (edge.targetHandle != null) {
      occupied.add(pinKey(edge.target, edge.targetHandle));
    }
  }
  occupiedByEdges.set(edges, occupied);
  return occupied;
}

function compareConnections(
  left: OrientedConnection,
  right: OrientedConnection,
): number {
  for (const field of [
    "source",
    "sourceHandle",
    "target",
    "targetHandle",
  ] as const) {
    if (left[field] < right[field]) return -1;
    if (left[field] > right[field]) return 1;
  }
  return 0;
}

/** The box around a set of pin centres (non-finite ones left out); null for none. */
export type PinBox = { minX: number; minY: number; maxX: number; maxY: number };

export function pinBox(pins: readonly ProximityPin[]): PinBox | null {
  let box: PinBox | null = null;
  for (const { x, y } of pins) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (!box) box = { minX: x, minY: y, maxX: x, maxY: y };
    else {
      box.minX = Math.min(box.minX, x);
      box.minY = Math.min(box.minY, y);
      box.maxX = Math.max(box.maxX, x);
      box.maxY = Math.max(box.maxY, y);
    }
  }
  return box;
}

/**
 * Whether pins inside `box` can be within `maxDistance` of a pin inside
 * `reach` (the moving pins' box). Pins it rules out can join no suggestion:
 * `findProximityConnections` pairs, and after resolving re-checks, only a
 * moving and a stationary pin at most `maxDistance` apart, so leaving them
 * out of its `pins` changes nothing it returns.
 */
export function pinBoxWithinReach(box: PinBox | null, reach: PinBox, maxDistance: number): boolean {
  if (!box) return false;
  return !(box.maxX < reach.minX - maxDistance || box.minX > reach.maxX + maxDistance ||
    box.maxY < reach.minY - maxDistance || box.minY > reach.maxY + maxDistance);
}

/** Suggest nearby, facing, unused pins without changing existing topology. */
export function findProximityConnections({
  pins,
  edges,
  movingNodeIds,
  maxDistance,
  resolveConnection,
  isValidConnection,
}: ProximityOptions): OrientedConnection[] {
  if (
    movingNodeIds.size === 0 ||
    !Number.isFinite(maxDistance) ||
    maxDistance < 0
  ) {
    return [];
  }

  const occupied = occupiedPins(edges);
  const available = new Map<string, ProximityPin>();
  const movingOutputs: ProximityPin[] = [];
  const movingInputs: ProximityPin[] = [];
  const stationaryOutputs: ProximityPin[] = [];
  const stationaryInputs: ProximityPin[] = [];
  for (const pin of pins) {
    const key = pinKey(pin.nodeId, pin.pinId);
    if (
      occupied.has(key) ||
      !Number.isFinite(pin.x) ||
      !Number.isFinite(pin.y)
    ) {
      continue;
    }
    available.set(key, pin);
    const moving = movingNodeIds.has(pin.nodeId);
    const group =
      pin.direction === "out"
        ? moving
          ? movingOutputs
          : stationaryOutputs
        : moving
          ? movingInputs
          : stationaryInputs;
    group.push(pin);
  }

  const maxDistanceSquared = maxDistance * maxDistance;
  function distanceSquared(
    source: ProximityPin,
    target: ProximityPin,
  ): number | null {
    if (
      source.nodeId === target.nodeId ||
      source.direction !== "out" ||
      target.direction !== "in" ||
      movingNodeIds.has(source.nodeId) === movingNodeIds.has(target.nodeId)
    ) {
      return null;
    }
    const dx = target.x - source.x;
    const dy = target.y - source.y;
    const distance = dx * dx + dy * dy;
    return dx >= 0 && distance <= maxDistanceSquared ? distance : null;
  }

  const candidates: Array<{
    connection: OrientedConnection;
    distance: number;
  }> = [];
  function consider(source: ProximityPin, target: ProximityPin): void {
    if (distanceSquared(source, target) === null) return;
    const raw: OrientedConnection = {
      source: source.nodeId,
      sourceHandle: source.pinId,
      target: target.nodeId,
      targetHandle: target.pinId,
    };
    const connection = resolveConnection ? resolveConnection(raw) : raw;
    if (!connection) return;
    const resolvedSource = available.get(
      pinKey(connection.source, connection.sourceHandle),
    );
    const resolvedTarget = available.get(
      pinKey(connection.target, connection.targetHandle),
    );
    if (!resolvedSource || !resolvedTarget) return;
    const distance = distanceSquared(resolvedSource, resolvedTarget);
    if (distance === null || !isValidConnection(connection)) return;
    candidates.push({ connection, distance });
  }

  for (const source of movingOutputs) {
    for (const target of stationaryInputs) consider(source, target);
  }
  for (const source of stationaryOutputs) {
    for (const target of movingInputs) consider(source, target);
  }
  candidates.sort(
    (left, right) =>
      left.distance - right.distance ||
      compareConnections(left.connection, right.connection),
  );

  const claimed = new Set<string>();
  const connections: OrientedConnection[] = [];
  for (const { connection } of candidates) {
    const source = pinKey(connection.source, connection.sourceHandle);
    const target = pinKey(connection.target, connection.targetHandle);
    if (claimed.has(source) || claimed.has(target)) continue;
    claimed.add(source);
    claimed.add(target);
    connections.push(connection);
  }
  return connections;
}
