import {
  Color3,
  Mesh,
  MeshBuilder,
  Quaternion,
  StandardMaterial,
  Vector3,
  type LinesMesh,
  type Scene,
} from "@babylonjs/core";
import type { CommandMessage, DebugColliderPrimitive } from "@babylonslate/bridge";
import { convexHullEdges } from "@babylonslate/assets";
import { NavMeshDebugOverlay, type NavDebugBlockerPose } from "./nav-debug-overlay";
import { isPlayConsoleVizSkipMesh } from "./snapshot-apply";
import { RENDERING_GROUP } from "./sorting";

const DEBUG_OVERLAY_PREFIX = "playConsoleViz:";

function markDebugOverlay(mesh: Mesh | LinesMesh): void {
  mesh.isPickable = false;
  mesh.renderingGroupId = RENDERING_GROUP.world;
  mesh.metadata = { ...(mesh.metadata ?? {}), playDebugOverlay: true };
}

function playMeshes(scene: Scene): Mesh[] {
  return scene.meshes.filter(
    (mesh): mesh is Mesh =>
      mesh instanceof Mesh &&
      !mesh.name.startsWith(DEBUG_OVERLAY_PREFIX) &&
      !isPlayConsoleVizSkipMesh(mesh),
  );
}

export function applyPlayWireframe(scene: Scene, enabled: boolean): void {
  for (const mesh of playMeshes(scene)) {
    const material = mesh.material as { wireframe?: boolean } | null;
    if (!material || typeof material.wireframe !== "boolean") continue;
    const meta = (mesh.metadata ?? {}) as {
      playWireframeRestore?: boolean;
    };
    if (enabled) {
      if (meta.playWireframeRestore === undefined) {
        mesh.metadata = {
          ...(mesh.metadata ?? {}),
          playWireframeRestore: material.wireframe,
        };
      }
      material.wireframe = true;
    } else if (meta.playWireframeRestore !== undefined) {
      material.wireframe = meta.playWireframeRestore;
      const next = { ...(mesh.metadata ?? {}) } as {
        playWireframeRestore?: boolean;
      };
      delete next.playWireframeRestore;
      mesh.metadata = next;
    }
  }
}

export function applyPlayShowBounds(scene: Scene, enabled: boolean): void {
  for (const mesh of playMeshes(scene)) {
    mesh.showBoundingBox = enabled;
  }
}

function colliderShapeKey(collider: DebugColliderPrimitive): string | null {
  if (collider.shape === "box" && collider.halfExtents) {
    const { x, y, z } = collider.halfExtents;
    return `box:${x}:${y}:${z}`;
  }
  if (collider.shape === "sphere" && collider.radius != null) {
    return `sphere:${collider.radius}`;
  }
  if (collider.shape === "circle" && collider.radius != null) {
    return `circle:${collider.radius}`;
  }
  if (collider.shape === "polyline") {
    const points = collider.points;
    if (!points || points.length <= 1) return null;
    return `line:${points.map((p) => `${p.x},${p.y},${p.z}`).join(";")}`;
  }
  if (
    collider.shape === "capsule" &&
    collider.radius != null &&
    collider.halfHeight != null
  ) {
    return `capsule:${collider.radius}:${collider.halfHeight}`;
  }
  if (collider.shape === "convex" && collider.points && collider.points.length >= 4) {
    return `convex:${collider.points.map((p) => `${p.x},${p.y},${p.z}`).join(";")}`;
  }
  return null;
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
  const slots = new Map<string, { mesh: Mesh | LinesMesh; key: string }>();
  const material = new StandardMaterial(`${DEBUG_OVERLAY_PREFIX}collisionMat`, scene);
  material.diffuseColor = new Color3(0.2, 0.95, 0.35);
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
      const seen = new Set<string>();
      for (const collider of colliders) {
        const key = colliderShapeKey(collider);
        if (!key) continue;
        seen.add(collider.id);
        let slot = slots.get(collider.id);
        if (!slot || slot.key !== key) {
          slot?.mesh.dispose();
          const mesh = createMesh(collider);
          if (!mesh) continue;
          slot = { mesh, key };
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
  } = {},
): PlayConsoleVizController {
  let wireframe = false;
  let bounds = false;
  const collision = createPlayCollisionOverlay(scene);
  const nav = new NavMeshDebugOverlay(scene);

  const refresh = () => {
    if (wireframe) applyPlayWireframe(scene, true);
    if (bounds) applyPlayShowBounds(scene, true);
  };

  return {
    applyCommand(command) {
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
          void nav.sync(options.navmeshBytes ?? null, options.navBlockers ?? []);
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
    },
  };
}
