import {
  ArcRotateCamera,
  Color4,
  HemisphericLight,
  MeshBuilder,
  RenderTargetTexture,
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
 * presented via RTT rather than a second WebGL context or `registerView`.
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
  // The camera renders into `outputRenderTarget`, so this clears the preview
  // RTT rather than the shared Engine's default framebuffer.
  scene.autoClear = true;

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

const TAP_TOLERANCE_PX = 8;
const ORBIT_SCALE = 0.005;
export const MATERIAL_PREVIEW_MAX_SIZE = 512;

interface PointerSample {
  x: number;
  y: number;
}

function pointerSpread(points: PointerSample[]): number {
  if (points.length < 2) return 0;
  return Math.hypot(points[0]!.x - points[1]!.x, points[0]!.y - points[1]!.y);
}

function zoomPreviewCamera(camera: ArcRotateCamera, factor: number): void {
  const lower = camera.lowerRadiusLimit ?? 0.5;
  const upper = camera.upperRadiusLimit ?? 400;
  camera.radius = Math.min(upper, Math.max(lower, camera.radius / factor));
}

/**
 * Orbit / pinch / wheel on the preview canvas only.
 *
 * Do not use `camera.attachControl` — Babylon 8 binds that to the Engine
 * input element (the Scene / Play canvas).
 */
export function attachMaterialPreviewGestures(
  canvas: HTMLCanvasElement,
  camera: ArcRotateCamera,
): { dispose: () => void } {
  const pointers = new Map<number, PointerSample>();
  let lastPoint: PointerSample | null = null;
  let downPoint: PointerSample | null = null;
  let lastSpread = 0;
  let moved = false;

  const toCanvas = (event: PointerEvent): PointerSample => {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const onPointerDown = (event: PointerEvent) => {
    const point = toCanvas(event);
    pointers.set(event.pointerId, point);
    canvas.setPointerCapture?.(event.pointerId);
    if (pointers.size === 1) {
      downPoint = point;
      lastPoint = point;
      moved = false;
      lastSpread = 0;
    } else {
      lastSpread = pointerSpread([...pointers.values()]);
      lastPoint = null;
    }
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, toCanvas(event));
    const samples = [...pointers.values()];
    if (samples.length === 1 && lastPoint) {
      const point = samples[0]!;
      if (
        downPoint &&
        Math.hypot(point.x - downPoint.x, point.y - downPoint.y) >
          TAP_TOLERANCE_PX
      ) {
        moved = true;
      }
      if (moved) {
        camera.alpha -= (point.x - lastPoint.x) * ORBIT_SCALE;
        camera.beta = Math.min(
          Math.PI - 0.01,
          Math.max(0.01, camera.beta + (point.y - lastPoint.y) * ORBIT_SCALE),
        );
      }
      lastPoint = point;
      return;
    }
    if (samples.length === 2) {
      const currentSpread = pointerSpread(samples);
      if (lastSpread > 0 && currentSpread > 0) {
        const factor = currentSpread / lastSpread;
        if (Math.abs(factor - 1) > 0.001) {
          zoomPreviewCamera(camera, factor);
        }
      }
      lastSpread = currentSpread;
    }
  };

  const endPointer = (event: PointerEvent) => {
    pointers.delete(event.pointerId);
    if (pointers.size === 1) {
      lastPoint = [...pointers.values()][0]!;
      lastSpread = 0;
    } else if (pointers.size === 0) {
      lastPoint = null;
      downPoint = null;
      lastSpread = 0;
      moved = false;
    } else {
      lastSpread = pointerSpread([...pointers.values()]);
    }
  };

  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    zoomPreviewCamera(camera, event.deltaY < 0 ? 1.1 : 1 / 1.1);
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

export interface MaterialPreviewPresenter {
  present: () => void;
  setFrozen: (frozen: boolean) => void;
  dispose: () => void;
}

function previewBufferSize(
  canvas: HTMLCanvasElement,
  maxSize: number,
): { width: number; height: number } | null {
  const width = Math.floor(canvas.clientWidth || 0);
  const height = Math.floor(canvas.clientHeight || 0);
  if (width <= 0 || height <= 0) return null;
  const longest = Math.max(width, height);
  const scale = longest > maxSize ? maxSize / longest : 1;
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}

/**
 * Draw the preview Scene into an RTT (`camera.outputRenderTarget`) and blit
 * that buffer onto a 2D canvas. Never `registerView` or default-framebuffer
 * `scene.render()` — those overwrite Scene viewport and Play overlay.
 */
export function createMaterialPreviewPresenter(
  host: MaterialPreviewScene,
  canvas: HTMLCanvasElement,
  options: { maxSize?: number; maxFps?: number; now?: () => number } = {},
): MaterialPreviewPresenter {
  const maxSize = options.maxSize ?? MATERIAL_PREVIEW_MAX_SIZE;
  const maxFps = options.maxFps ?? 30;
  const minIntervalMs = 1000 / Math.max(1, maxFps);
  const now = options.now ?? (() => performance.now());
  let frozen = false;
  let rtt: RenderTargetTexture | null = null;
  let blitInFlight = false;
  let lastPresentMs = Number.NEGATIVE_INFINITY;

  const releaseRtt = () => {
    host.camera.outputRenderTarget = null;
    rtt?.dispose();
    rtt = null;
  };

  const ensureRtt = (width: number, height: number): RenderTargetTexture => {
    const current = rtt?.getSize();
    if (rtt && current && current.width === width && current.height === height) {
      return rtt;
    }
    releaseRtt();
    rtt = new RenderTargetTexture(
      "materialPreview",
      { width, height },
      host.scene,
      false,
    );
    host.camera.outputRenderTarget = rtt;
    return rtt;
  };

  const blit = (texture: RenderTargetTexture) => {
    if (blitInFlight) return;
    blitInFlight = true;
    void (async () => {
      try {
        const buffer = await texture.readPixels();
        if (!buffer || !canvas.getContext) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        const { width, height } = texture.getSize();
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
        const bytes =
          buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer.buffer);
        ctx.putImageData(
          new ImageData(new Uint8ClampedArray(bytes), width, height),
          0,
          0,
        );
      } catch {
        // NullEngine / missing GPU readback is fine — tests assert the RTT.
      } finally {
        blitInFlight = false;
      }
    })();
  };

  return {
    present: () => {
      canvas.dataset.cameraRadius = String(host.camera.radius);
      if (frozen || blitInFlight) return;
      const at = now();
      if (at - lastPresentMs < minIntervalMs) return;
      const size = previewBufferSize(canvas, maxSize);
      if (!size) return;
      lastPresentMs = at;
      const texture = ensureRtt(size.width, size.height);
      host.scene.render();
      blit(texture);
    },
    setFrozen: (value) => {
      frozen = value;
    },
    dispose: () => {
      releaseRtt();
    },
  };
}
