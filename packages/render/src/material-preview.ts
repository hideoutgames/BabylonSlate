import {
  ArcRotateCamera,
  Color4,
  HemisphericLight,
  MeshBuilder,
  Scene,
  Vector3,
  type Engine,
  type Mesh,
  type NodeMaterial,
  type PostProcess,
} from "@babylonjs/core";
import type { MaterialPreviewMesh } from "@babylonslate/shader-graph";
import { createMeshFromModelBytes } from "./model-mesh";

export const MATERIAL_PREVIEW_MESH_NAME = "materialPreviewMesh";

/** Keep orbit/pinch pivoted on the mesh, including custom Models that are off-origin. */
export function aimPreviewCameraAtMesh(
  camera: ArcRotateCamera,
  mesh: Mesh,
): void {
  mesh.computeWorldMatrix(true);
  const bounds = mesh.getBoundingInfo();
  camera.setTarget(bounds.boundingBox.centerWorld.clone());
}

/**
 * Build the preview primitive for a Material document.
 *
 * Cone is a cylinder with a zero top diameter, and Plane is the 2D quad so a
 * sprite-style material can be judged flat-on.
 */
export function createMaterialPreviewMesh(
  scene: Scene,
  kind: MaterialPreviewMesh,
  customMeshBytes?: Uint8Array | null,
): Mesh {
  const name = MATERIAL_PREVIEW_MESH_NAME;
  switch (kind) {
    case "cube":
      return MeshBuilder.CreateBox(name, { size: 1.4 }, scene);
    case "cylinder":
      return MeshBuilder.CreateCylinder(
        name,
        { height: 1.8, diameter: 1.2 },
        scene,
      );
    case "cone":
      return MeshBuilder.CreateCylinder(
        name,
        { height: 1.8, diameterTop: 0, diameterBottom: 1.4 },
        scene,
      );
    case "plane":
      return MeshBuilder.CreatePlane(name, { size: 1.8 }, scene);
    case "custom": {
      if (customMeshBytes && customMeshBytes.byteLength > 0) {
        const loaded = createMeshFromModelBytes(scene, name, customMeshBytes);
        if (loaded) return loaded;
      }
      // Fall back to the sphere so an unresolved pick still previews.
      return MeshBuilder.CreateSphere(name, { diameter: 1.6 }, scene);
    }
    case "sphere":
    default:
      return MeshBuilder.CreateSphere(
        name,
        { diameter: 1.6, segments: 32 },
        scene,
      );
  }
}

export interface MaterialPreviewScene {
  scene: Scene;
  camera: ArcRotateCamera;
  /** Current preview mesh; replaced when the primitive choice changes. */
  mesh: Mesh;
  setMesh: (
    kind: MaterialPreviewMesh,
    customMeshBytes?: Uint8Array | null,
  ) => Mesh;
  applyMaterial: (material: NodeMaterial | null) => void;
  applyPostProcess: (material: NodeMaterial | null) => void;
  dispose: () => void;
}

/**
 * A disposable Scene on the shared app Engine.
 *
 * The editor keeps one Engine for its lifetime, so a Material tab adds a Scene
 * and a view rather than a second WebGL context.
 */
export function createMaterialPreviewScene(
  engine: Engine,
  options: {
    mesh?: MaterialPreviewMesh;
    customMeshBytes?: Uint8Array | null;
  } = {},
): MaterialPreviewScene {
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.05, 0.05, 0.07, 1);
  scene.skipPointerMovePicking = true;

  const camera = new ArcRotateCamera(
    "materialPreviewCamera",
    -Math.PI / 3,
    Math.PI / 2.6,
    4,
    Vector3.Zero(),
    scene,
  );
  camera.lowerRadiusLimit = 1.6;
  camera.upperRadiusLimit = 12;
  camera.wheelDeltaPercentage = 0.02;
  camera.panningSensibility = 0;
  camera.pinchPrecision = 24;
  camera.pinchDeltaPercentage = 0.02;
  camera.useNaturalPinchZoom = true;

  const key = new HemisphericLight(
    "materialPreviewLight",
    new Vector3(0.4, 1, 0.6),
    scene,
  );
  key.intensity = 1.1;
  const fill = new HemisphericLight(
    "materialPreviewFill",
    new Vector3(-0.6, -0.4, -0.8),
    scene,
  );
  fill.intensity = 0.35;

  let mesh = createMaterialPreviewMesh(
    scene,
    options.mesh ?? "sphere",
    options.customMeshBytes,
  );
  aimPreviewCameraAtMesh(camera, mesh);
  let postProcess: PostProcess | null = null;

  const disposePostProcess = () => {
    if (!postProcess) return;
    postProcess.dispose(camera);
    postProcess = null;
  };

  const host: MaterialPreviewScene = {
    scene,
    camera,
    get mesh() {
      return mesh;
    },
    setMesh: (kind, customMeshBytes) => {
      const material = mesh.material;
      mesh.dispose();
      mesh = createMaterialPreviewMesh(scene, kind, customMeshBytes);
      mesh.material = material;
      aimPreviewCameraAtMesh(camera, mesh);
      return mesh;
    },
    applyMaterial: (material) => {
      mesh.material = material;
    },
    applyPostProcess: (material) => {
      disposePostProcess();
      if (!material) return;
      postProcess = material.createPostProcess(camera) ?? null;
    },
    dispose: () => {
      disposePostProcess();
      scene.dispose();
    },
  };
  return host;
}

export interface MaterialPreviewGestureHandle {
  dispose: () => void;
}

function clampPreviewRadius(camera: ArcRotateCamera, radius: number): number {
  const lower = camera.lowerRadiusLimit ?? 0.01;
  const upper = camera.upperRadiusLimit ?? Number.POSITIVE_INFINITY;
  return Math.min(upper, Math.max(lower, radius));
}

/**
 * Drive the preview orbit camera from the registerView canvas.
 *
 * `camera.attachControl` listens on the shared Engine's hidden canvas, so
 * wheel and pinch on the visible preview would otherwise never move radius.
 */
export function attachMaterialPreviewGestures(
  canvas: HTMLCanvasElement,
  camera: ArcRotateCamera,
): MaterialPreviewGestureHandle {
  const pointers = new Map<number, { x: number; y: number }>();
  let lastSpread = 0;
  let lastPoint: { x: number; y: number } | null = null;

  const pointOf = (event: PointerEvent) => ({
    x: event.clientX,
    y: event.clientY,
  });

  const applyPinch = () => {
    if (pointers.size !== 2) {
      lastSpread = 0;
      return;
    }
    const samples = [...pointers.values()];
    const spread = Math.hypot(
      samples[0]!.x - samples[1]!.x,
      samples[0]!.y - samples[1]!.y,
    );
    if (lastSpread > 1 && spread > 1) {
      camera.radius = clampPreviewRadius(
        camera,
        camera.radius * (lastSpread / spread),
      );
    }
    lastSpread = spread;
  };

  const onPointerDown = (event: PointerEvent) => {
    pointers.set(event.pointerId, pointOf(event));
    lastPoint = pointOf(event);
    try {
      canvas.setPointerCapture?.(event.pointerId);
    } catch {
      /* jsdom / already captured */
    }
    if (pointers.size === 2) lastPoint = null;
    applyPinch();
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!pointers.has(event.pointerId)) return;
    const next = pointOf(event);
    pointers.set(event.pointerId, next);
    if (pointers.size === 2) {
      applyPinch();
      return;
    }
    if (pointers.size === 1 && lastPoint) {
      camera.alpha -= (next.x - lastPoint.x) * 0.005;
      camera.beta += (next.y - lastPoint.y) * 0.005;
      lastPoint = next;
    }
  };

  const endPointer = (event: PointerEvent) => {
    pointers.delete(event.pointerId);
    lastPoint = pointers.size === 1 ? [...pointers.values()][0]! : null;
    if (pointers.size < 2) lastSpread = 0;
  };

  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1 / 1.1 : 1.1;
    camera.radius = clampPreviewRadius(camera, camera.radius * factor);
  };

  const onTouch = (event: TouchEvent) => {
    event.preventDefault();
  };

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("touchstart", onTouch, { passive: false });
  canvas.addEventListener("touchmove", onTouch, { passive: false });

  return {
    dispose: () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", endPointer);
      canvas.removeEventListener("pointercancel", endPointer);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("touchstart", onTouch);
      canvas.removeEventListener("touchmove", onTouch);
      pointers.clear();
    },
  };
}
