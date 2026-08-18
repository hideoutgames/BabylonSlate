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
import { NavMeshDebugOverlay } from "./nav-debug-overlay";
import { isPlayConsoleVizSkipMesh } from "./snapshot-apply";

const DEBUG_OVERLAY_PREFIX = "playConsoleViz:";

function markDebugOverlay(mesh: Mesh | LinesMesh): void {
  mesh.isPickable = false;
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

export function createPlayCollisionOverlay(scene: Scene): {
  sync(colliders: readonly DebugColliderPrimitive[]): void;
  dispose(): void;
} {
  const meshes: Array<Mesh | LinesMesh> = [];
  const material = new StandardMaterial(`${DEBUG_OVERLAY_PREFIX}collisionMat`, scene);
  material.diffuseColor = new Color3(0.2, 0.95, 0.35);
  material.wireframe = true;
  material.alpha = 0.5;
  material.backFaceCulling = false;

  const clear = () => {
    for (const mesh of meshes) mesh.dispose();
    meshes.length = 0;
  };

  return {
    sync(colliders) {
      clear();
      for (const collider of colliders) {
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
          mesh.position.set(
            collider.position.x,
            collider.position.y,
            collider.position.z,
          );
          mesh.rotationQuaternion = new Quaternion(
            collider.rotation.x,
            collider.rotation.y,
            collider.rotation.z,
            collider.rotation.w,
          );
          mesh.material = material;
          markDebugOverlay(mesh);
          meshes.push(mesh);
          continue;
        }
        if (
          (collider.shape === "sphere" || collider.shape === "circle") &&
          collider.radius != null
        ) {
          if (collider.shape === "circle") {
            const points: Vector3[] = [];
            const steps = 24;
            for (let i = 0; i <= steps; i++) {
              const angle = (i / steps) * Math.PI * 2;
              points.push(
                new Vector3(
                  collider.position.x + Math.cos(angle) * collider.radius,
                  collider.position.y + Math.sin(angle) * collider.radius,
                  collider.position.z,
                ),
              );
            }
            const line = MeshBuilder.CreateLines(name, { points }, scene);
            line.color = new Color3(0.2, 0.95, 0.35);
            markDebugOverlay(line);
            meshes.push(line);
            continue;
          }
          const mesh = MeshBuilder.CreateSphere(
            name,
            { diameter: collider.radius * 2 },
            scene,
          );
          mesh.position.set(
            collider.position.x,
            collider.position.y,
            collider.position.z,
          );
          mesh.material = material;
          markDebugOverlay(mesh);
          meshes.push(mesh);
          continue;
        }
        if (collider.shape === "polyline" && collider.points && collider.points.length > 1) {
          const points = collider.points.map(
            (point: { x: number; y: number; z: number }) =>
              new Vector3(point.x, point.y, point.z),
          );
          const line = MeshBuilder.CreateLines(name, { points }, scene);
          line.color = new Color3(0.2, 0.95, 0.35);
          markDebugOverlay(line);
          meshes.push(line);
        }
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
  options: { navmeshBytes?: Uint8Array | null } = {},
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
        if (command.enabled && options.navmeshBytes) {
          void nav.sync(options.navmeshBytes);
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
