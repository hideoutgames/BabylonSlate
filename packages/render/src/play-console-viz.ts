import {
  Color3,
  Mesh,
  MeshBuilder,
  Quaternion,
  StandardMaterial,
  Vector3,
  VertexData,
  type AbstractMesh,
  type LinesMesh,
  type Material,
  type Scene,
} from "@babylonjs/core";
import type { CommandMessage, DebugColliderPrimitive } from "@babylonslate/bridge";
import { convexHullEdges } from "@babylonslate/assets";
import type { PhysicsWorldKind } from "@babylonslate/core";
import { NavMeshDebugOverlay, type NavDebugBlockerPose } from "./nav-debug-overlay";
import { isPlayConsoleVizSkipMesh } from "./snapshot-apply";
import { RENDERING_GROUP } from "./sorting";
import { createPlayNavigationOverlay } from "./play-navigation-overlay";

const DEBUG_OVERLAY_PREFIX = "playConsoleViz:";
const wireframeRestore = new WeakMap<Scene, Map<Material, boolean>>();

function markDebugOverlay(mesh: Mesh | LinesMesh): void {
  mesh.isPickable = false;
  mesh.receiveShadows = false;
  mesh.applyFog = false;
  mesh.renderingGroupId = RENDERING_GROUP.world;
  mesh.metadata = { ...(mesh.metadata ?? {}), playDebugOverlay: true };
}

// Refresh runs per applied snapshot; callers walk scene.meshes in place.
function isPlayMesh(mesh: AbstractMesh): mesh is Mesh {
  return (
    mesh instanceof Mesh &&
    !mesh.name.startsWith(DEBUG_OVERLAY_PREFIX) &&
    !isPlayConsoleVizSkipMesh(mesh)
  );
}

export function applyPlayWireframe(scene: Scene, enabled: boolean): void {
  if (!enabled) {
    const originals = wireframeRestore.get(scene);
    for (const [material, wireframe] of originals ?? []) {
      material.wireframe = wireframe;
    }
    wireframeRestore.delete(scene);
    return;
  }
  let originals = wireframeRestore.get(scene);
  if (!originals) {
    originals = new Map();
    wireframeRestore.set(scene, originals);
  }
  for (const mesh of scene.meshes) {
    if (!isPlayMesh(mesh)) continue;
    const material = mesh.material;
    if (!material || typeof material.wireframe !== "boolean") continue;
    if (!originals.has(material)) originals.set(material, material.wireframe);
    material.wireframe = true;
  }
}

export function applyPlayShowBounds(scene: Scene, enabled: boolean): void {
  for (const mesh of scene.meshes) {
    if (isPlayMesh(mesh)) mesh.showBoundingBox = enabled;
  }
}

function hasColliderShape(collider: DebugColliderPrimitive): boolean {
  switch (collider.shape) {
    case "box":
      return Boolean(collider.halfExtents);
    case "sphere":
    case "circle":
      return collider.radius != null;
    case "polyline":
      return Boolean(collider.points && collider.points.length > 1);
    case "capsule":
    case "capsule2d":
      return collider.radius != null && collider.halfHeight != null;
    case "cylinder":
      return collider.radius != null && collider.height != null;
    case "mesh":
      return Boolean(collider.points && collider.indices && collider.indices.length >= 3);
    case "convex":
      return Boolean(collider.points && collider.points.length >= 4);
    default:
      return false;
  }
}

/** Equal like their string forms were: NaN matches NaN and -0 matches 0. */
function sameValue(a: number | undefined, b: number | undefined): boolean {
  return a === b || Object.is(a, b);
}

function samePoints(
  a: readonly { x: number; y: number; z: number }[] | undefined,
  b: readonly { x: number; y: number; z: number }[] | undefined,
): boolean {
  if (!a || !b || a.length !== b.length) return a === b;
  for (let i = 0; i < a.length; i++) {
    const p = a[i]!;
    const q = b[i]!;
    if (!sameValue(p.x, q.x) || !sameValue(p.y, q.y) || !sameValue(p.z, q.z)) return false;
  }
  return true;
}

/**
 * Compares only the fields that shape the overlay mesh, without building a
 * key string of every vertex on each debugColliders tick. Pose is excluded.
 */
function sameColliderShape(a: DebugColliderPrimitive, b: DebugColliderPrimitive): boolean {
  if (a.shape !== b.shape) return false;
  switch (b.shape) {
    case "box":
      return sameValue(a.halfExtents?.x, b.halfExtents?.x) &&
        sameValue(a.halfExtents?.y, b.halfExtents?.y) &&
        sameValue(a.halfExtents?.z, b.halfExtents?.z);
    case "sphere":
    case "circle":
      return sameValue(a.radius, b.radius);
    case "capsule":
    case "capsule2d":
      return sameValue(a.radius, b.radius) && sameValue(a.halfHeight, b.halfHeight);
    case "cylinder":
      return sameValue(a.radius, b.radius) && sameValue(a.height, b.height);
    case "polyline":
    case "convex":
      return samePoints(a.points, b.points);
    case "mesh": {
      if (!samePoints(a.points, b.points)) return false;
      const ai = a.indices ?? [];
      const bi = b.indices ?? [];
      if (ai.length !== bi.length) return false;
      for (let i = 0; i < ai.length; i++) if (!sameValue(ai[i], bi[i])) return false;
      return true;
    }
    default:
      return false;
  }
}

function applyColliderPose(
  mesh: Mesh | LinesMesh,
  collider: DebugColliderPrimitive,
): void {
  mesh.position.set(
    collider.position.x,
    collider.position.y,
    collider.position.z,
  );
  if (mesh instanceof Mesh) {
    mesh.rotationQuaternion ??= new Quaternion();
    mesh.rotationQuaternion.set(
      collider.rotation.x,
      collider.rotation.y,
      collider.rotation.z,
      collider.rotation.w,
    );
  }
}

export function createPlayCollisionOverlay(scene: Scene): {
  sync(colliders: readonly DebugColliderPrimitive[]): void;
  dispose(): void;
} {
  // Runtime primitives are fresh objects per tick, so the slot keeps its source.
  const slots = new Map<string, { mesh: Mesh | LinesMesh; shape: DebugColliderPrimitive }>();
  const seen = new Set<string>();
  const material = new StandardMaterial(`${DEBUG_OVERLAY_PREFIX}collisionMat`, scene);
  material.diffuseColor = new Color3(0.2, 0.95, 0.35);
  material.disableLighting = true;
  material.emissiveColor = material.diffuseColor.clone();
  material.wireframe = true;
  material.alpha = 0.5;
  material.backFaceCulling = false;
  const lineColor = new Color3(0.2, 0.95, 0.35);

  const clear = () => {
    for (const slot of slots.values()) slot.mesh.dispose();
    slots.clear();
  };

  const createMesh = (
    collider: DebugColliderPrimitive,
  ): Mesh | LinesMesh | null => {
    const name = `${DEBUG_OVERLAY_PREFIX}${collider.id}`;
    if (collider.shape === "box" && collider.halfExtents) {
      const mesh = MeshBuilder.CreateBox(
        name,
        {
          width: collider.halfExtents.x * 2,
          height: collider.halfExtents.y * 2,
          depth: collider.halfExtents.z * 2,
        },
        scene,
      );
      mesh.material = material;
      markDebugOverlay(mesh);
      return mesh;
    }
    if (collider.shape === "sphere" && collider.radius != null) {
      const mesh = MeshBuilder.CreateSphere(
        name,
        { diameter: collider.radius * 2 },
        scene,
      );
      mesh.material = material;
      markDebugOverlay(mesh);
      return mesh;
    }
    if (collider.shape === "circle" && collider.radius != null) {
      const points: Vector3[] = [];
      const steps = 24;
      for (let i = 0; i <= steps; i++) {
        const angle = (i / steps) * Math.PI * 2;
        points.push(
          new Vector3(
            Math.cos(angle) * collider.radius,
            Math.sin(angle) * collider.radius,
            0,
          ),
        );
      }
      const line = MeshBuilder.CreateLines(name, { points }, scene);
      line.color = lineColor;
      markDebugOverlay(line);
      return line;
    }
    if (collider.shape === "polyline" && collider.points && collider.points.length > 1) {
      const points = collider.points.map(
        (point: { x: number; y: number; z: number }) =>
          new Vector3(point.x, point.y, point.z),
      );
      const line = MeshBuilder.CreateLines(name, { points }, scene);
      line.color = lineColor;
      markDebugOverlay(line);
      return line;
    }
    if (collider.shape === "capsule2d" && collider.radius != null && collider.halfHeight != null) {
      const points: Vector3[] = [];
      for (const end of [1, -1]) {
        for (let step = 0; step <= 16; step++) {
          const angle = (step / 16) * Math.PI + (end === 1 ? 0 : Math.PI);
          points.push(new Vector3(
            Math.cos(angle) * collider.radius,
            Math.sin(angle) * collider.radius + end * collider.halfHeight,
            0,
          ));
        }
      }
      points.push(points[0]!.clone());
      const line = MeshBuilder.CreateLines(name, { points }, scene);
      line.color = lineColor;
      markDebugOverlay(line);
      return line;
    }
    if (collider.shape === "cylinder" && collider.radius != null && collider.height != null) {
      const mesh = MeshBuilder.CreateCylinder(name, {
        diameter: collider.radius * 2,
        height: collider.height,
        tessellation: 24,
      }, scene);
      mesh.material = material;
      markDebugOverlay(mesh);
      return mesh;
    }
    if (collider.shape === "mesh" && collider.points && collider.indices) {
      const mesh = new Mesh(name, scene);
      const data = new VertexData();
      data.positions = collider.points.flatMap((point) => [point.x, point.y, point.z]);
      data.indices = collider.indices;
      data.applyToMesh(mesh);
      mesh.material = material;
      markDebugOverlay(mesh);
      return mesh;
    }
    if (
      collider.shape === "capsule" &&
      collider.radius != null &&
      collider.halfHeight != null
    ) {
      const mesh = MeshBuilder.CreateCapsule(
        name,
        {
          radius: collider.radius,
          height: 2 * collider.halfHeight + 2 * collider.radius,
        },
        scene,
      );
      mesh.material = material;
      markDebugOverlay(mesh);
      return mesh;
    }
    if (collider.shape === "convex" && collider.points && collider.points.length >= 4) {
      const lines = convexHullEdges(collider.points).map(([from, to]) => [
        new Vector3(from.x, from.y, from.z),
        new Vector3(to.x, to.y, to.z),
      ]);
      if (lines.length === 0) return null;
      const line = MeshBuilder.CreateLineSystem(name, { lines }, scene);
      line.color = lineColor;
      markDebugOverlay(line);
      return line;
    }
    return null;
  };

  return {
    sync(colliders) {
      seen.clear();
      for (const collider of colliders) {
        if (!hasColliderShape(collider)) continue;
        seen.add(collider.id);
        let slot = slots.get(collider.id);
        if (!slot || !sameColliderShape(slot.shape, collider)) {
          slot?.mesh.dispose();
          const mesh = createMesh(collider);
          if (!mesh) continue;
          slot = { mesh, shape: collider };
          slots.set(collider.id, slot);
        }
        if (collider.shape !== "polyline") {
          applyColliderPose(slot.mesh, collider);
        }
      }
      for (const [id, slot] of slots) {
        if (seen.has(id)) continue;
        slot.mesh.dispose();
        slots.delete(id);
      }
    },
    dispose() {
      clear();
      material.dispose();
    },
  };
}

export type PlayConsoleVizController = {
  applyCommand(command: CommandMessage): boolean;
  refresh(): void;
  dispose(): void;
};

export function createPlayConsoleViz(
  scene: Scene,
  options: {
    navmeshBytes?: Uint8Array | null;
    navBlockers?: readonly NavDebugBlockerPose[] | null;
    world?: PhysicsWorldKind;
  } = {},
): PlayConsoleVizController {
  let wireframe = false;
  let bounds = false;
  const collision = createPlayCollisionOverlay(scene);
  const nav = new NavMeshDebugOverlay(scene);
  const navigation = createPlayNavigationOverlay(scene);

  const refresh = () => {
    if (wireframe) applyPlayWireframe(scene, true);
    if (bounds) applyPlayShowBounds(scene, true);
  };

  return {
    applyCommand(command) {
      if (navigation.applyCommand(command)) return true;
      if (command.type === "setWireframe") {
        wireframe = command.enabled;
        applyPlayWireframe(scene, wireframe);
        return true;
      }
      if (command.type === "setShowBounds") {
        bounds = command.enabled;
        applyPlayShowBounds(scene, bounds);
        return true;
      }
      if (command.type === "debugColliders") {
        collision.sync(command.colliders);
        return true;
      }
      if (command.type === "setShowCollision" && !command.enabled) {
        collision.sync([]);
        return true;
      }
      if (command.type === "setShowNav") {
        if (command.enabled) {
          void nav.sync(options.navmeshBytes ?? null, options.navBlockers ?? [], options.world);
        } else {
          nav.clear();
        }
        return true;
      }
      return false;
    },
    refresh,
    dispose() {
      applyPlayWireframe(scene, false);
      applyPlayShowBounds(scene, false);
      collision.dispose();
      nav.dispose();
      navigation.dispose();
    },
  };
}
