import "./gltf-loader";
import {
  ArcRotateCamera,
  Color4,
  Constants,
  MeshBuilder,
  NullEngine,
  RenderTargetTexture,
  Scene,
  Vector3,
  type AssetContainer,
  type AbstractEngine,
  type Material,
  type Mesh,
  type NodeMaterial,
} from "@babylonjs/core";
import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";
import type { MaterialParameterValue } from "@babylonslate/bridge";
import type { MaterialDocument, MaterialPreviewMesh } from "@babylonslate/shader-graph";
import { createRttCanvasBlitter } from "./flip-read-pixels";
import { adoptLoadedHierarchy } from "./glb-anim";
import {
  gltfLoaderExtension,
  isGltfModelBytes,
  packedGltfBytes,
} from "./model-mesh";
import {
  applyMaterialToVisualMeshes,
  visualHierarchyBoundingVectors,
} from "./visual-meshes";
import { installEngineDefaultMaterial } from "./default-material";
import type { MaterialLibrary } from "./material-library";
import type { AttachedPostProcessStack, PostProcessStackDiagnostic } from "./post-process-material";
import { SceneRenderCoordinator } from "./scene-render-coordinator";
import { createPreviewLighting } from "./preview-lighting";
import { previewMeshesReady } from "./preview-readiness";
import { createText2DMesh } from "./text2d-mesh";
import { resolveSceneRenderingQuality } from "./render-settings";
import { SCENE_SHADER_WARM_TIMEOUT_MS } from "./stall-deadline";

export const MATERIAL_PREVIEW_MESH_NAME = "materialPreviewMesh";

/** Keep orbit/pinch pivoted on the mesh, including custom Models that are off-origin. */
export function aimPreviewCameraAtMesh(
  camera: ArcRotateCamera,
  mesh: Mesh,
): void {
  mesh.computeWorldMatrix(true);
  const extent = visualHierarchyBoundingVectors(mesh);
  const center = extent.min.add(extent.max).scale(0.5);
  if (
    Number.isFinite(center.x) &&
    Number.isFinite(center.y) &&
    Number.isFinite(center.z)
  ) {
    camera.setTarget(center);
  }
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
    case "custom":
      // Hierarchy loads asynchronously in `setMesh`. Missing bytes stay a cube.
      return MeshBuilder.CreateBox(name, { size: 1.4 }, scene);
    case "sphere":
    default:
      return MeshBuilder.CreateSphere(
        name,
        { diameter: 1.6, segments: 32 },
        scene,
      );
  }
}

/** A post-process Material previewed as the preview camera's only pass. */
export interface MaterialPreviewPostProcess {
  library: MaterialLibrary;
  materialGuid: string;
  document: MaterialDocument;
  parameters?: Record<string, MaterialParameterValue>;
  onDiagnostic?: (diagnostic: PostProcessStackDiagnostic) => void;
}

const PREVIEW_POST_PROCESS_ENTRY = "preview";

export interface MaterialPreviewScene {
  scene: Scene;
  camera: ArcRotateCamera;
  /** Draws the preview Scene through the FrameGraph into the camera's output target. */
  renderer: SceneRenderCoordinator;
  /** Current preview mesh; replaced when the primitive choice changes. */
  mesh: Mesh;
  setMesh: (
    kind: MaterialPreviewMesh,
    customMeshBytes?: Uint8Array | null,
  ) => Promise<Mesh>;
  applyMaterial: (material: Material | null) => void;
  applyPostProcess: (source: MaterialPreviewPostProcess | null) => void;
  /** Sets a parameter on the previewed post-process pass; null restores its default. */
  setPostProcessParameter: (name: string, value: MaterialParameterValue | null) => boolean;
  applyParticleMaterial: (material: NodeMaterial | null) => void;
  dispose: () => void;
  /** Disposes, then resolves once the renderer's native resources are released
   * and the Scene is disposed; rejects if release failed. */
  whenReleased: () => Promise<void>;
}

/**
 * A disposable Scene on the shared app Engine.
 *
 * The editor keeps one Engine for its lifetime, so a Material tab adds a Scene
 * presented via RTT rather than a second WebGL context or `registerView`.
 */
export function createMaterialPreviewScene(
  engine: AbstractEngine,
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
  installEngineDefaultMaterial(scene);

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

  createPreviewLighting(scene);
  // Previews never draw planar water reflections.
  const renderer = new SceneRenderCoordinator(scene, { waterPlanarReflections: false });

  let mesh = createMaterialPreviewMesh(scene, options.mesh ?? "cube");
  aimPreviewCameraAtMesh(camera, mesh);
  let postProcess: AttachedPostProcessStack | null = null;
  let currentMaterial: Material | null = mesh.material;
  let particlePlane: Mesh | null = null;
  let textPreview: Mesh | null = null;
  const disposeTextPreview = () => { textPreview?.dispose(); textPreview = null; mesh.setEnabled(true); };
  const disposeParticles = () => { particlePlane?.dispose(); particlePlane = null; mesh.setEnabled(true); };
  let customContainer: AssetContainer | null = null;
  let meshGeneration = 0;

  // The renderer retires the pass with its graph.
  const disposePostProcess = () => {
    const stack = postProcess;
    postProcess = null;
    stack?.dispose();
  };

  const disposeCustomContainer = () => {
    customContainer?.dispose();
    customContainer = null;
  };

  // The preview Scene lives on the shared Engine: release it only after the
  // renderer confirms actual native release of its graph and passes.
  let released: Promise<void> | null = null;
  const releasePreview = () => {
    released ??= renderer.whenReleased().then(() => {
      if (!scene.isDisposed) scene.dispose();
    });
    return released;
  };

  const host: MaterialPreviewScene = {
    scene,
    camera,
    renderer,
    get mesh() {
      return mesh;
    },
    setMesh: async (kind, customMeshBytes) => {
      const generation = ++meshGeneration;
      disposeCustomContainer();
      mesh.dispose();
      mesh = createMaterialPreviewMesh(scene, kind);
      if (
        kind === "custom" &&
        customMeshBytes &&
        isGltfModelBytes(customMeshBytes)
      ) {
        mesh.visibility = 0;
        try {
          const packed = packedGltfBytes(customMeshBytes);
          const container = await LoadAssetContainerAsync(packed, scene, {
            pluginExtension: gltfLoaderExtension(customMeshBytes),
            name: "material-preview-custom.glb",
          });
          if (generation !== meshGeneration) {
            container.dispose();
            return mesh;
          }
          container.addAllToScene();
          adoptLoadedHierarchy(mesh, container);
          customContainer = container;
        } catch {
          if (generation === meshGeneration) {
            mesh.visibility = 1;
          }
        }
      }
      if (generation !== meshGeneration) return mesh;
      applyMaterialToVisualMeshes(mesh, currentMaterial);
      if (particlePlane || textPreview) mesh.setEnabled(false);
      else aimPreviewCameraAtMesh(camera, mesh);
      return mesh;
    },
    applyMaterial: (material) => {
      if (material) disposeParticles();
      disposeTextPreview();
      currentMaterial = material;
      if (material?.metadata?.materialDomain === "text") {
        mesh.setEnabled(false);
        textPreview = createText2DMesh(scene, "materialPreviewText", {
          text: "Text", size: 80, wrapWidth: 240, wrapHeight: 100, alignment: "center", materialGuid: "preview",
        }, { resolveMaterial: () => material });
        camera.alpha = -Math.PI / 2;
        camera.beta = Math.PI / 2;
        aimPreviewCameraAtMesh(camera, textPreview);
        return;
      }
      applyMaterialToVisualMeshes(mesh, material);
    },
    applyPostProcess: (source) => {
      disposePostProcess();
      if (!source) return;
      disposeTextPreview();
      disposeParticles();
      postProcess = renderer.attachPostProcess({
        scene,
        camera,
        library: source.library,
        documentFor: (guid) => guid === source.materialGuid ? source.document : null,
        stack: [{ id: PREVIEW_POST_PROCESS_ENTRY, materialGuid: source.materialGuid, enabled: true, order: 0, parameters: source.parameters }],
        onDiagnostic: source.onDiagnostic,
      });
    },
    setPostProcessParameter: (name, value) => {
      if (!postProcess) return false;
      return value
        ? postProcess.setParameter(PREVIEW_POST_PROCESS_ENTRY, name, value)
        : postProcess.resetParameter(PREVIEW_POST_PROCESS_ENTRY, name);
    },
    applyParticleMaterial: (material) => {
      disposeParticles();
      if (!material) return;
      disposeTextPreview();
      mesh.setEnabled(false);
      particlePlane = MeshBuilder.CreatePlane("materialPreviewParticlePlane", { size: 1.6 }, scene);
      particlePlane.material = material;
      camera.alpha = -Math.PI / 2;
      camera.beta = Math.PI / 2;
      camera.setTarget(Vector3.Zero());
    },
    dispose: () => {
      meshGeneration += 1;
      disposeTextPreview();
      disposeParticles();
      disposePostProcess();
      disposeCustomContainer();
      void releasePreview().catch((error: unknown) => {
        console.warn(`[render] Material preview scene is quarantined until actual release: ${String(error)}`);
      });
    },
    whenReleased: () => {
      host.dispose();
      return releasePreview();
    },
  };
  if (
    (options.mesh ?? "cube") === "custom" &&
    options.customMeshBytes &&
    isGltfModelBytes(options.customMeshBytes)
  ) {
    void host.setMesh("custom", options.customMeshBytes);
  }
  return host;
}

/**
 * Prepare the preview renderer for the camera's current output target and draw
 * one validated frame into it. False when the frame never became presentable
 * before the shader warm deadline or `isCurrent` turned false.
 */
export async function renderPreviewFrame(
  host: MaterialPreviewScene,
  isCurrent: () => boolean = () => true,
): Promise<boolean> {
  await host.renderer.prepare(() => {
    if (!isCurrent()) throw new Error("Preview frame was superseded.");
  });
  const deadline = performance.now() + SCENE_SHADER_WARM_TIMEOUT_MS;
  while (isCurrent()) {
    const frame = host.renderer.render();
    if (frame.rendered && frame.readyForPresentation) return true;
    if (performance.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 16));
  }
  return false;
}

/** A preview output target the FrameGraph can draw into: color plus depth. */
export function createPreviewRenderTarget(name: string, size: { width: number; height: number }, scene: Scene): RenderTargetTexture {
  const target = new RenderTargetTexture(name, size, scene, false);
  target.createDepthStencilTexture(0, false, false, 1, Constants.TEXTUREFORMAT_DEPTH24);
  return target;
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
  options?: {
    onChange?: () => void;
    blockOrbit?: (x: number, y: number) => boolean;
    onPointer?: (
      type: "down" | "move" | "up",
      x: number,
      y: number,
      pointerId: number,
    ) => void;
    onTap?: (x: number, y: number) => void;
  },
): { dispose: () => void } {
  const pointers = new Map<number, PointerSample>();
  let lastPoint: PointerSample | null = null;
  let downPoint: PointerSample | null = null;
  let lastSpread = 0;
  let moved = false;
  let stealing = false;
  // Cleared by a second pointer or a cancel, so a pinch release is never a tap.
  let tapCandidate = false;

  const toCanvas = (event: PointerEvent): PointerSample => {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const onPointerDown = (event: PointerEvent) => {
    const point = toCanvas(event);
    options?.onPointer?.("down", point.x, point.y, event.pointerId);
    pointers.set(event.pointerId, point);
    canvas.setPointerCapture?.(event.pointerId);
    if (pointers.size === 1) {
      stealing = options?.blockOrbit?.(point.x, point.y) === true;
      downPoint = point;
      lastPoint = stealing ? null : point;
      moved = false;
      lastSpread = 0;
      tapCandidate = true;
    } else {
      lastSpread = pointerSpread([...pointers.values()]);
      lastPoint = null;
      tapCandidate = false;
    }
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!pointers.has(event.pointerId)) return;
    const point = toCanvas(event);
    options?.onPointer?.("move", point.x, point.y, event.pointerId);
    pointers.set(event.pointerId, point);
    if (stealing) return;
    const samples = [...pointers.values()];
    if (samples.length === 1 && lastPoint) {
      const sample = samples[0]!;
      if (
        downPoint &&
        Math.hypot(sample.x - downPoint.x, sample.y - downPoint.y) >
          TAP_TOLERANCE_PX
      ) {
        moved = true;
      }
      if (moved) {
        camera.alpha -= (sample.x - lastPoint.x) * ORBIT_SCALE;
        camera.beta = Math.min(
          Math.PI - 0.01,
          Math.max(0.01, camera.beta - (sample.y - lastPoint.y) * ORBIT_SCALE),
        );
        options?.onChange?.();
      }
      lastPoint = sample;
      return;
    }
    if (samples.length === 2) {
      const currentSpread = pointerSpread(samples);
      if (lastSpread > 0 && currentSpread > 0) {
        const factor = currentSpread / lastSpread;
        if (Math.abs(factor - 1) > 0.001) {
          zoomPreviewCamera(camera, factor);
          options?.onChange?.();
        }
      }
      lastSpread = currentSpread;
    }
  };

  const endPointer = (event: PointerEvent) => {
    const point = toCanvas(event);
    options?.onPointer?.("up", point.x, point.y, event.pointerId);
    if (
      tapCandidate &&
      pointers.size === 1 &&
      pointers.has(event.pointerId) &&
      !moved &&
      !stealing
    ) {
      options?.onTap?.(point.x, point.y);
    }
    pointers.delete(event.pointerId);
    if (pointers.size === 1) {
      lastPoint = [...pointers.values()][0]!;
      lastSpread = 0;
    } else if (pointers.size === 0) {
      lastPoint = null;
      downPoint = null;
      lastSpread = 0;
      moved = false;
      stealing = false;
    } else {
      lastSpread = pointerSpread([...pointers.values()]);
    }
  };

  const cancelPointer = (event: PointerEvent) => {
    tapCandidate = false;
    endPointer(event);
  };

  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    zoomPreviewCamera(camera, event.deltaY < 0 ? 1.1 : 1 / 1.1);
    options?.onChange?.();
  };

  const onTouch = (event: TouchEvent) => {
    event.preventDefault();
  };

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", cancelPointer);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("touchstart", onTouch, { passive: false });
  canvas.addEventListener("touchmove", onTouch, { passive: false });

  return {
    dispose: () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", endPointer);
      canvas.removeEventListener("pointercancel", cancelPointer);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("touchstart", onTouch);
      canvas.removeEventListener("touchmove", onTouch);
      pointers.clear();
    },
  };
}

export interface MaterialPreviewPresenter {
  present: (options?: { force?: boolean }) => void;
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
 * Draw the preview Scene through its FrameGraph renderer into an RTT
 * (`camera.outputRenderTarget`) and blit that buffer onto a 2D canvas. Never
 * `registerView` or the default framebuffer — those overwrite Scene viewport
 * and Play overlay. A frame the renderer is still preparing stays pending and
 * is drawn on a later `present`.
 */
export function createMaterialPreviewPresenter(
  host: MaterialPreviewScene,
  canvas: HTMLCanvasElement,
  options: { maxSize?: number; maxFps?: number; now?: () => number; onError?: (message: string | null) => void } = {},
): MaterialPreviewPresenter {
  const maxSize = options.maxSize ?? MATERIAL_PREVIEW_MAX_SIZE;
  const maxFps = options.maxFps ?? 30;
  const minIntervalMs = 1000 / Math.max(1, maxFps);
  const now = options.now ?? (() => performance.now());
  let frozen = false;
  let rtt: RenderTargetTexture | null = null;
  let rttGeneration = 0;
  let blitInFlight = false;
  let lastPresentMs = Number.NEGATIVE_INFINITY;
  let pendingForce = false;
  let disposed = false;
  let renderError: string | null = null;
  let readbackError: string | null = null;
  const blitter = createRttCanvasBlitter();

  const releaseRtt = () => {
    rttGeneration += 1;
    host.camera.outputRenderTarget = null;
    rtt?.dispose();
    rtt = null;
  };

  const reportReadback = (message: string) => {
    if (message !== readbackError) options.onError?.(message);
    readbackError = message;
  };

  const ensureRtt = (width: number, height: number): RenderTargetTexture => {
    const current = rtt?.getSize();
    if (
      rtt &&
      current &&
      current.width === width &&
      current.height === height
    ) {
      return rtt;
    }
    releaseRtt();
    rtt = createPreviewRenderTarget("materialPreview", { width, height }, host.scene);
    host.camera.outputRenderTarget = rtt;
    return rtt;
  };

  const blit = (texture: RenderTargetTexture) => {
    if (blitInFlight) return;
    blitInFlight = true;
    const generation = rttGeneration;
    void (async () => {
      try {
        const buffer = await blitter.read(texture);
        // An RTT recreation supersedes in-flight readbacks: pixels from an
        // older generation must never reach the canvas.
        if (disposed || generation !== rttGeneration || !canvas.getContext)
          return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        const { width, height } = texture.getSize();
        if (!buffer || buffer.byteLength < width * height * 4) {
          // NullEngine has no GPU readback; its null result is expected.
          if (!(host.scene.getEngine() instanceof NullEngine)) {
            reportReadback("The material preview readback returned no pixels.");
          }
          return;
        }
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
        blitter.put(ctx, buffer, width, height);
        if (readbackError) {
          readbackError = null;
          options.onError?.(null);
        }
      } catch (error) {
        reportReadback(
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        blitInFlight = false;
      }
    })();
  };

  return {
    present: (presentOptions) => {
      if (disposed) return;
      pendingForce ||= presentOptions?.force === true;
      canvas.dataset.cameraRadius = String(host.camera.radius);
      if (frozen || blitInFlight) return;
      const at = now();
      if (!pendingForce && at - lastPresentMs < minIntervalMs) return;
      const size = previewBufferSize(canvas, maxSize);
      if (!size) return;
      try {
        const scale = resolveSceneRenderingQuality(host.scene).resolution.scale;
        const texture = ensureRtt(Math.max(1, Math.round(size.width * scale)), Math.max(1, Math.round(size.height * scale)));
        // Shader warm-up must not consume a static preview's presentation interval.
        const preview = host.scene.getMeshByName("materialPreviewText") ?? host.scene.getMeshByName("materialPreviewParticlePlane") ?? host.mesh;
        if (!previewMeshesReady(preview)) return;
        const frame = host.renderer.render();
        if (!frame.rendered || !frame.readyForPresentation) {
          // Surfaces a failed preparation; otherwise the frame stays pending.
          host.renderer.isReady();
          return;
        }
        pendingForce = false;
        lastPresentMs = at;
        blit(texture);
        if (renderError) { renderError = null; options.onError?.(null); }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message !== renderError) options.onError?.(message);
        renderError = message;
      }
    },
    setFrozen: (value) => {
      frozen = value;
    },
    dispose: () => {
      disposed = true;
      releaseRtt();
    },
  };
}
