import {
  Color3,
  MeshBuilder,
  Quaternion,
  Vector3,
  type AbstractMesh,
  type LinesMesh,
  type Observer,
  type Scene,
} from "@babylonjs/core";
import { CreateGreasedLine } from "@babylonjs/core/Meshes/Builders/greasedLineBuilder";
import type { CommandMessage, DebugDrawCommand } from "@babylonslate/bridge";
import { eulerDegreesToQuaternion } from "@babylonslate/core";
import { RENDERING_GROUP } from "./sorting";

export const PLAY_DEBUG_DRAW_PREFIX = "playDebugDraw:";

type DrawEntry = {
  meshes: AbstractMesh[];
  birthTick: number | null;
  remainingMs: number | null;
  presented: boolean;
};

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asVec3(
  value: unknown,
  fallback: { x: number; y: number; z: number },
): Vector3 {
  if (!value || typeof value !== "object") {
    return new Vector3(fallback.x, fallback.y, fallback.z);
  }
  const record = value as Record<string, unknown>;
  return new Vector3(
    asNumber(record.x, fallback.x),
    asNumber(record.y, fallback.y),
    asNumber(record.z, fallback.z),
  );
}

function asRotator(value: unknown): Quaternion {
  if (!value || typeof value !== "object") {
    return Quaternion.Identity();
  }
  const record = value as Record<string, unknown>;
  const [x, y, z, w] = eulerDegreesToQuaternion([
    asNumber(record.pitch, 0),
    asNumber(record.yaw, 0),
    asNumber(record.roll, 0),
  ]);
  return new Quaternion(x, y, z, w);
}

function asColor(value: unknown): Color3 {
  if (!value || typeof value !== "object") return new Color3(1, 1, 1);
  const record = value as Record<string, unknown>;
  return new Color3(
    asNumber(record.x, 1),
    asNumber(record.y, 1),
    asNumber(record.z, 1),
  );
}

function markOverlay(mesh: AbstractMesh): void {
  mesh.isPickable = false;
  mesh.receiveShadows = false;
  mesh.applyFog = false;
  mesh.renderingGroupId = RENDERING_GROUP.world;
  mesh.metadata = { ...(mesh.metadata ?? {}), playDebugOverlay: true };
  for (const child of mesh.getChildMeshes()) {
    child.renderingGroupId = RENDERING_GROUP.world;
    child.isPickable = false;
    child.receiveShadows = false;
    child.applyFog = false;
  }
}

function posePoint(local: Vector3, origin: Vector3, rotation: Quaternion): Vector3 {
  return local.applyRotationQuaternion(rotation).addInPlace(origin);
}

function orthonormalBasis(direction: Vector3): { right: Vector3; up: Vector3 } {
  const axis = direction.lengthSquared() < 1e-8 ? Vector3.Up() : direction.normalize();
  const helper =
    Math.abs(axis.y) > 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
  const right = Vector3.Cross(axis, helper).normalize();
  const up = Vector3.Cross(right, axis).normalize();
  return { right, up };
}

export type PlayDebugDrawController = {
  applyCommand(command: CommandMessage): boolean;
  noteSimTick(tickIndex: number): void;
  dispose(): void;
};

export function createPlayDebugDraw(scene: Scene): PlayDebugDrawController {
  const entries: DrawEntry[] = [];
  let seq = 0;
  let lastSimTick = 0;

  const nextName = (kind: string): string =>
    `${PLAY_DEBUG_DRAW_PREFIX}${kind}:${seq++}`;

  const addLines = (
    kind: string,
    points: Vector3[],
    color: Color3,
  ): LinesMesh | null => {
    if (points.length < 2) return null;
    const mesh = MeshBuilder.CreateLines(
      nextName(kind),
      { points, updatable: false },
      scene,
    );
    mesh.color = color;
    markOverlay(mesh);
    return mesh;
  };

  const addPolyline = (
    kind: string,
    points: Vector3[],
    color: Color3,
    meshes: AbstractMesh[],
  ): void => {
    const mesh = addLines(kind, points, color);
    if (mesh) meshes.push(mesh);
  };

  const addClosed = (
    kind: string,
    points: Vector3[],
    color: Color3,
    meshes: AbstractMesh[],
  ): void => {
    if (points.length < 2) return;
    addPolyline(kind, [...points, points[0]!.clone()], color, meshes);
  };

  const addCircle = (
    kind: string,
    origin: Vector3,
    radius: number,
    rotation: Quaternion,
    segments: number,
    color: Color3,
    meshes: AbstractMesh[],
  ): Vector3[] => {
    const count = Math.max(3, Math.round(segments));
    const points: Vector3[] = [];
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      points.push(
        posePoint(
          new Vector3(Math.cos(angle) * radius, Math.sin(angle) * radius, 0),
          origin,
          rotation,
        ),
      );
    }
    addClosed(kind, points, color, meshes);
    return points;
  };

  const addBox = (
    center: Vector3,
    extent: Vector3,
    rotation: Quaternion,
    color: Color3,
    meshes: AbstractMesh[],
  ): void => {
    const corners: Vector3[] = [];
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        for (const sz of [-1, 1]) {
          corners.push(
            posePoint(
              new Vector3(sx * extent.x, sy * extent.y, sz * extent.z),
              center,
              rotation,
            ),
          );
        }
      }
    }
    const edges: Array<[number, number]> = [
      [0, 1],
      [1, 3],
      [3, 2],
      [2, 0],
      [4, 5],
      [5, 7],
      [7, 6],
      [6, 4],
      [0, 4],
      [1, 5],
      [2, 6],
      [3, 7],
    ];
    for (const [a, b] of edges) {
      addPolyline("box", [corners[a]!, corners[b]!], color, meshes);
    }
  };

  const addSphere = (
    center: Vector3,
    radius: number,
    segments: number,
    color: Color3,
    meshes: AbstractMesh[],
  ): void => {
    const rings = Math.max(4, Math.round(segments));
    for (let i = 1; i < rings; i++) {
      const lat = (i / rings) * Math.PI - Math.PI / 2;
      const y = Math.sin(lat) * radius;
      const ringRadius = Math.cos(lat) * radius;
      const points: Vector3[] = [];
      for (let j = 0; j <= rings; j++) {
        const lon = (j / rings) * Math.PI * 2;
        points.push(
          new Vector3(
            center.x + Math.cos(lon) * ringRadius,
            center.y + y,
            center.z + Math.sin(lon) * ringRadius,
          ),
        );
      }
      addPolyline("sphere", points, color, meshes);
    }
    for (let i = 0; i < rings; i++) {
      const lon = (i / rings) * Math.PI * 2;
      const points: Vector3[] = [];
      for (let j = 0; j <= rings; j++) {
        const lat = (j / rings) * Math.PI - Math.PI / 2;
        const ringRadius = Math.cos(lat) * radius;
        const y = Math.sin(lat) * radius;
        points.push(
          new Vector3(
            center.x + Math.cos(lon) * ringRadius,
            center.y + y,
            center.z + Math.sin(lon) * ringRadius,
          ),
        );
      }
      addPolyline("sphere", points, color, meshes);
    }
  };

  const addLine = (command: DebugDrawCommand, meshes: AbstractMesh[]): void => {
    const start = asVec3(command.start, { x: 0, y: 0, z: 0 });
    const end = asVec3(command.end, { x: 1, y: 0, z: 0 });
    const color = asColor(command.color);
    const thickness = asNumber(command.thickness, 1);
    if (thickness > 1) {
      try {
        const mesh = CreateGreasedLine(
          nextName("line"),
          { points: [start, end] },
          { width: thickness, color, createAndAssignMaterial: true },
          scene,
        );
        markOverlay(mesh);
        meshes.push(mesh);
        return;
      } catch {
        // NullEngine / missing plugins fall back to CreateLines.
      }
    }
    addPolyline("line", [start, end], color, meshes);
  };

  const addPoint = (command: DebugDrawCommand, meshes: AbstractMesh[]): void => {
    const position = asVec3(command.position, { x: 0, y: 0, z: 0 });
    const size = Math.max(0.01, asNumber(command.size, 0.1));
    const color = asColor(command.color);
    const half = size / 2;
    addPolyline(
      "point",
      [
        position.add(new Vector3(-half, 0, 0)),
        position.add(new Vector3(half, 0, 0)),
      ],
      color,
      meshes,
    );
    addPolyline(
      "point",
      [
        position.add(new Vector3(0, -half, 0)),
        position.add(new Vector3(0, half, 0)),
      ],
      color,
      meshes,
    );
    addPolyline(
      "point",
      [
        position.add(new Vector3(0, 0, -half)),
        position.add(new Vector3(0, 0, half)),
      ],
      color,
      meshes,
    );
  };

  const addCone = (command: DebugDrawCommand, meshes: AbstractMesh[]): void => {
    const origin = asVec3(command.origin, { x: 0, y: 0, z: 0 });
    const direction = asVec3(command.direction, { x: 0, y: 1, z: 0 });
    const length = Math.max(0.01, asNumber(command.length, 1));
    const angle = (asNumber(command.angle, 30) * Math.PI) / 180;
    const color = asColor(command.color);
    const axis =
      direction.lengthSquared() < 1e-8
        ? new Vector3(0, 1, 0)
        : direction.normalize();
    const base = origin.add(axis.scale(length));
    const radius = length * Math.tan(Math.max(0, angle));
    const { right, up } = orthonormalBasis(axis);
    const segments = 12;
    const rim: Vector3[] = [];
    for (let i = 0; i < segments; i++) {
      const t = (i / segments) * Math.PI * 2;
      rim.push(
        base.add(right.scale(Math.cos(t) * radius)).add(up.scale(Math.sin(t) * radius)),
      );
    }
    addClosed("cone", rim, color, meshes);
    for (const point of rim) {
      addPolyline("cone", [origin.clone(), point], color, meshes);
    }
  };

  const addCylinder = (
    command: DebugDrawCommand,
    meshes: AbstractMesh[],
  ): void => {
    const start = asVec3(command.start, { x: 0, y: 0, z: 0 });
    const end = asVec3(command.end, { x: 0, y: 1, z: 0 });
    const radius = Math.max(0.01, asNumber(command.radius, 0.25));
    const color = asColor(command.color);
    const axis = end.subtract(start);
    const { right, up } = orthonormalBasis(axis);
    const segments = 12;
    const bottom: Vector3[] = [];
    const top: Vector3[] = [];
    for (let i = 0; i < segments; i++) {
      const t = (i / segments) * Math.PI * 2;
      const offset = right.scale(Math.cos(t) * radius).add(up.scale(Math.sin(t) * radius));
      bottom.push(start.add(offset));
      top.push(end.add(offset));
    }
    addClosed("cylinder", bottom, color, meshes);
    addClosed("cylinder", top, color, meshes);
    for (let i = 0; i < segments; i += 3) {
      addPolyline("cylinder", [bottom[i]!, top[i]!], color, meshes);
    }
  };

  const addArrow = (command: DebugDrawCommand, meshes: AbstractMesh[]): void => {
    const start = asVec3(command.start, { x: 0, y: 0, z: 0 });
    const end = asVec3(command.end, { x: 0, y: 1, z: 0 });
    const size = Math.max(0.01, asNumber(command.size, 0.2));
    const color = asColor(command.color);
    addPolyline("arrow", [start, end], color, meshes);
    const axis = end.subtract(start);
    if (axis.lengthSquared() < 1e-8) return;
    const dir = axis.normalize();
    const { right, up } = orthonormalBasis(dir);
    const neck = end.subtract(dir.scale(size));
    addPolyline("arrow", [end, neck.add(right.scale(size * 0.4))], color, meshes);
    addPolyline("arrow", [end, neck.subtract(right.scale(size * 0.4))], color, meshes);
    addPolyline("arrow", [end, neck.add(up.scale(size * 0.4))], color, meshes);
    addPolyline("arrow", [end, neck.subtract(up.scale(size * 0.4))], color, meshes);
  };

  const addFrustum = (
    command: DebugDrawCommand,
    meshes: AbstractMesh[],
  ): void => {
    const origin = asVec3(command.origin, { x: 0, y: 0, z: 0 });
    const rotation = asRotator(command.rotation);
    const near = Math.max(0.01, asNumber(command.near, 0.1));
    const far = Math.max(near + 0.01, asNumber(command.far, 10));
    const fov = (asNumber(command.fov, 90) * Math.PI) / 180;
    const aspect = Math.max(0.01, asNumber(command.aspect, 16 / 9));
    const tan = Math.tan(fov / 2);
    const nearH = tan * near;
    const farH = tan * far;
    const nearW = nearH * aspect;
    const farW = farH * aspect;
    const local = [
      new Vector3(-nearW, -nearH, near),
      new Vector3(nearW, -nearH, near),
      new Vector3(nearW, nearH, near),
      new Vector3(-nearW, nearH, near),
      new Vector3(-farW, -farH, far),
      new Vector3(farW, -farH, far),
      new Vector3(farW, farH, far),
      new Vector3(-farW, farH, far),
    ].map((point) => posePoint(point, origin, rotation));
    const edges: Array<[number, number]> = [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 0],
      [4, 5],
      [5, 6],
      [6, 7],
      [7, 4],
      [0, 4],
      [1, 5],
      [2, 6],
      [3, 7],
    ];
    const color = asColor(command.color);
    for (const [a, b] of edges) {
      addPolyline("frustum", [local[a]!, local[b]!], color, meshes);
    }
  };

  const addCoordinateSystem = (
    command: DebugDrawCommand,
    meshes: AbstractMesh[],
  ): void => {
    const origin = asVec3(command.origin, { x: 0, y: 0, z: 0 });
    const rotation = asRotator(command.rotation);
    const scale = Math.max(0.01, asNumber(command.scale, 1));
    const axes: Array<{ local: Vector3; color: Color3 }> = [
      { local: new Vector3(scale, 0, 0), color: new Color3(1, 0.15, 0.15) },
      { local: new Vector3(0, scale, 0), color: new Color3(0.15, 1, 0.2) },
      { local: new Vector3(0, 0, scale), color: new Color3(0.2, 0.4, 1) },
    ];
    for (const axis of axes) {
      addPolyline(
        "coordinateSystem",
        [origin.clone(), posePoint(axis.local, origin.clone(), rotation)],
        axis.color,
        meshes,
      );
    }
  };

  const build = (command: DebugDrawCommand): AbstractMesh[] => {
    const meshes: AbstractMesh[] = [];
    switch (command.kind) {
      case "line":
        addLine(command, meshes);
        break;
      case "point":
        addPoint(command, meshes);
        break;
      case "box":
        addBox(
          asVec3(command.center, { x: 0, y: 0, z: 0 }),
          asVec3(command.extent, { x: 0.5, y: 0.5, z: 0.5 }),
          asRotator(command.rotation),
          asColor(command.color),
          meshes,
        );
        break;
      case "sphere":
        addSphere(
          asVec3(command.center, { x: 0, y: 0, z: 0 }),
          Math.max(0.01, asNumber(command.radius, 0.5)),
          asNumber(command.segments, 12),
          asColor(command.color),
          meshes,
        );
        break;
      case "circle":
        addCircle(
          "circle",
          asVec3(command.center, { x: 0, y: 0, z: 0 }),
          Math.max(0.01, asNumber(command.radius, 0.5)),
          asRotator(command.rotation),
          24,
          asColor(command.color),
          meshes,
        );
        break;
      case "rectangle": {
        const center = asVec3(command.center, { x: 0, y: 0, z: 0 });
        const rotation = asRotator(command.rotation);
        const halfW = asNumber(command.width, 1) / 2;
        const halfH = asNumber(command.height, 1) / 2;
        const corners = [
          posePoint(new Vector3(-halfW, -halfH, 0), center, rotation),
          posePoint(new Vector3(halfW, -halfH, 0), center, rotation),
          posePoint(new Vector3(halfW, halfH, 0), center, rotation),
          posePoint(new Vector3(-halfW, halfH, 0), center, rotation),
        ];
        addClosed("rectangle", corners, asColor(command.color), meshes);
        break;
      }
      case "square": {
        const center = asVec3(command.center, { x: 0, y: 0, z: 0 });
        const rotation = asRotator(command.rotation);
        const half = asNumber(command.size, 1) / 2;
        const corners = [
          posePoint(new Vector3(-half, -half, 0), center, rotation),
          posePoint(new Vector3(half, -half, 0), center, rotation),
          posePoint(new Vector3(half, half, 0), center, rotation),
          posePoint(new Vector3(-half, half, 0), center, rotation),
        ];
        addClosed("square", corners, asColor(command.color), meshes);
        break;
      }
      case "cone":
        addCone(command, meshes);
        break;
      case "cylinder":
        addCylinder(command, meshes);
        break;
      case "arrow":
        addArrow(command, meshes);
        break;
      case "frustum":
        addFrustum(command, meshes);
        break;
      case "coordinateSystem":
        addCoordinateSystem(command, meshes);
        break;
      default:
        break;
    }
    return meshes;
  };

  const drop = (entry: DrawEntry): void => {
    for (const mesh of entry.meshes) mesh.dispose();
    entry.meshes.length = 0;
  };

  const dropExpiredSimDraws = (assignBirth: boolean): void => {
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]!;
      if (entry.remainingMs != null) continue;
      if (entry.birthTick == null) {
        if (assignBirth) entry.birthTick = lastSimTick;
        continue;
      }
      if (!entry.presented || entry.birthTick >= lastSimTick) continue;
      drop(entry);
      entries.splice(i, 1);
    }
  };

  const observer: Observer<Scene> = scene.onAfterRenderObservable.add(() => {
    const dt = scene.getEngine().getDeltaTime();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]!;
      entry.presented = true;
      if (entry.remainingMs != null) {
        entry.remainingMs -= dt;
        if (entry.remainingMs > 0) continue;
        drop(entry);
        entries.splice(i, 1);
      }
    }
    dropExpiredSimDraws(false);
  })!;

  return {
    applyCommand(command) {
      if (command.type !== "debugDraw") return false;
      const duration = asNumber(command.duration, 0);
      const meshes = build(command);
      if (meshes.length === 0) return true;
      if (duration <= 0) {
        for (let i = entries.length - 1; i >= 0; i--) {
          const entry = entries[i]!;
          if (entry.remainingMs != null) continue;
          drop(entry);
          entries.splice(i, 1);
        }
      }
      entries.push({
        meshes,
        birthTick: null,
        remainingMs: duration > 0 ? duration * 1000 : null,
        presented: false,
      });
      return true;
    },
    noteSimTick(tickIndex) {
      lastSimTick = tickIndex;
      dropExpiredSimDraws(true);
    },
    dispose() {
      scene.onAfterRenderObservable.remove(observer);
      for (const entry of entries) drop(entry);
      entries.length = 0;
    },
  };
}
