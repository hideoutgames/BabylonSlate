import "./gltf-loader";
import { ArcRotateCamera } from "@babylonjs/core/Cameras/arcRotateCamera";
import { Camera } from "@babylonjs/core/Cameras/camera";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import type { NodeMaterial } from "@babylonjs/core/Materials/Node/nodeMaterial";
import type { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import type { Material } from "@babylonjs/core/Materials/material";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { DEFAULT_DECAL_PROPERTIES } from "@haptic/core";
import type { AssetContainer } from "@babylonjs/core/assetContainer";
import { Scene } from "@babylonjs/core/scene";
import type { MaterialParameterValue } from "@haptic/bridge";
import type { MaterialDocument, MaterialPreviewMesh } from "@haptic/shader-graph";
import { createRttCanvasBlitter } from "./flip-read-pixels";
import { adoptLoadedHierarchy } from "./glb-anim";
import { loadModelContainer } from "./model-container";
import { isGltfModelBytes } from "./model-mesh";
import {
  applyMaterialToVisualMeshes,
  visualHierarchyBoundingVectors,
} from "./visual-meshes";
import { installEngineDefaultMaterial } from "./default-material";
import type { MaterialLibrary } from "./material-library";
import type { AttachedPostProcessStack, PostProcessStackDiagnostic } from "./post-process-material";
import { SceneRenderCoordinator } from "./scene-render-coordinator";
import { createPreviewLighting } from "./preview-lighting";
import { previewMeshesReady, waitUntilReady } from "./preview-readiness";
import { globalParameterDefaults } from "./global-parameter-values";
import { createText2DMesh } from "./text2d-mesh";
import { resolveSceneRenderingQuality } from "./render-settings";
import { DriverCompileWatch } from "./driver-compile";
import { createDepthTextureTarget } from "./depth-texture-target";
import { MAX_CAMERA_RADIUS, MIN_CAMERA_RADIUS } from "./editor-camera";
import type { RenderScheduler } from "./render-scheduler";
import { createViewportZoomDrive, type ViewportZoomDirection, type ViewportZoomDrive } from "./viewport-zoom-drive";
import type { HeldThreadBudget } from "./stall-deadline";
import { refreshDecalMaterials, removeDecals, sceneDecalsPending, setDecalMaterialSource, upsertDecals } from "./decal-pass";

/** Names of the Decal domain's preview stage: a floor and a ball, which one decal projects onto from above. */
export const MATERIAL_PREVIEW_DECAL_RECEIVER = "materialPreviewDecalReceiver";
const MATERIAL_PREVIEW_DECAL_ACTOR = "materialPreviewDecal";

/**
 * A Decal Material's preview: a floor and a ball half sunk in it, under one decal box projecting straight down, so the
 * projection, its wrap over a curved surface and its Fade Angle show. Drawn with the Scene's own decal pass.
 */
function createDecalPreviewStage(scene: Scene): { meshes: Mesh[]; dispose(): void } {
  const floor = MeshBuilder.CreateGround(MATERIAL_PREVIEW_DECAL_RECEIVER, { width: 3, height: 3 }, scene);
  const ball = MeshBuilder.CreateSphere(`${MATERIAL_PREVIEW_DECAL_RECEIVER}:ball`, { diameter: 1.1, segments: 24 }, scene);
  ball.position.y = 0.15;
  const anchor = new TransformNode(`${MATERIAL_PREVIEW_DECAL_ACTOR}:anchor`, scene);
  anchor.position.y = 0.5;
  upsertDecals(scene, MATERIAL_PREVIEW_DECAL_ACTOR, anchor, [{
    id: "decal",
    properties: { ...DEFAULT_DECAL_PROPERTIES, materialGuid: "preview", size: [2.2, 2, 2.2], fadeAngle: 80 },
    transforms: [],
  }]);
  return {
    meshes: [floor, ball],
    dispose: () => {
      removeDecals(scene, MATERIAL_PREVIEW_DECAL_ACTOR);
      anchor.dispose();
      ball.dispose();
      floor.dispose();
    },
  };
}

/** Whether `material` is a Decal-domain Material (`compileMaterialPlan` stamps its domain). */
export function isDecalDomainMaterial(material: Material | null | undefined): boolean {
  return (material?.metadata as { materialDomain?: unknown } | null | undefined)?.materialDomain === "decal";
}

export const MATERIAL_PREVIEW_MESH_NAME = "materialPreviewMesh";
/** The quad a User Interface Material previews on, filling the view (`MaterialPreviewScene.flat`). */
export const MATERIAL_PREVIEW_USER_INTERFACE_NAME = "materialPreviewUserInterface";

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
interface MaterialPreviewPostProcess {
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
  /**
   * True while a User Interface Material previews: one quad that exactly fills the view under an orthographic,
   * front-on camera, so Element UV spans the view and Element Size is the preview buffer's size. Orbit and zoom do
   * nothing then (`attachMaterialPreviewGestures`), the mesh choice is not shown, and the presenter draws at the
   * canvas's device pixels. Applying another domain's Material restores the orbit camera as it was.
   */
  readonly flat: boolean;
  /** The Decal domain's stage meshes while a Decal Material is previewed, else none. */
  decalStageMeshes: () => readonly Mesh[];
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
  let decalStage: ReturnType<typeof createDecalPreviewStage> | null = null;
  let decalMaterial: Material | null = null;
  setDecalMaterialSource(scene, { resolve: () => decalMaterial });
  const disposeDecalStage = () => { decalStage?.dispose(); decalStage = null; decalMaterial = null; mesh.setEnabled(true); };
  const disposeParticles = () => { particlePlane?.dispose(); particlePlane = null; mesh.setEnabled(true); };
  // The User Interface state: its quad, and the orbit camera it replaced.
  let flatQuad: Mesh | null = null;
  let orbit: { alpha: number; beta: number; radius: number; target: Vector3 } | null = null;
  const showFlat = (material: Material) => {
    mesh.setEnabled(false);
    if (!flatQuad) {
      orbit = { alpha: camera.alpha, beta: camera.beta, radius: camera.radius, target: camera.target.clone() };
      // A unit quad under a unit orthographic window fills the view at any aspect: the projection stretches the
      // window to the buffer, so UV 0 to 1 spans its pixels exactly.
      flatQuad = MeshBuilder.CreatePlane(MATERIAL_PREVIEW_USER_INTERFACE_NAME, { size: 1 }, scene);
      camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
      camera.orthoLeft = -0.5;
      camera.orthoRight = 0.5;
      camera.orthoBottom = -0.5;
      camera.orthoTop = 0.5;
      // The target first: setting it recomputes the angles from the camera's position.
      camera.setTarget(Vector3.Zero());
      camera.alpha = -Math.PI / 2;
      camera.beta = Math.PI / 2;
      camera.radius = 4;
    }
    flatQuad.material = material;
  };
  const disposeFlat = () => {
    if (!flatQuad) return;
    flatQuad.dispose();
    flatQuad = null;
    camera.mode = Camera.PERSPECTIVE_CAMERA;
    camera.orthoLeft = camera.orthoRight = camera.orthoBottom = camera.orthoTop = null;
    if (orbit) {
      camera.setTarget(orbit.target);
      camera.alpha = orbit.alpha;
      camera.beta = orbit.beta;
      camera.radius = orbit.radius;
      orbit = null;
    }
    mesh.setEnabled(true);
  };
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
    get flat() {
      return flatQuad !== null;
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
          const container = await loadModelContainer(scene, customMeshBytes, "material-preview-custom.glb");
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
      applyMaterialToVisualMeshes(mesh, decalStage ? null : currentMaterial);
      if (particlePlane || textPreview || flatQuad || decalStage) mesh.setEnabled(false);
      else aimPreviewCameraAtMesh(camera, mesh);
      return mesh;
    },
    applyMaterial: (material) => {
      if (material) disposeParticles();
      disposeTextPreview();
      currentMaterial = material;
      if (material?.metadata?.materialDomain === "ui") {
        disposeDecalStage();
        showFlat(material);
        return;
      }
      disposeFlat();
      if (isDecalDomainMaterial(material)) {
        mesh.setEnabled(false);
        if (!decalStage) {
          decalStage = createDecalPreviewStage(scene);
          camera.alpha = -Math.PI / 3;
          camera.beta = 0.95;
          camera.radius = 4.2;
          camera.setTarget(new Vector3(0, 0.2, 0));
        }
        decalMaterial = material;
        refreshDecalMaterials(scene);
        return;
      }
      if (decalStage) disposeDecalStage();
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
      disposeDecalStage();
      disposeParticles();
      disposeFlat();
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
      disposeFlat();
      disposeDecalStage();
      mesh.setEnabled(false);
      particlePlane = MeshBuilder.CreatePlane("materialPreviewParticlePlane", { size: 1.6 }, scene);
      particlePlane.material = material;
      camera.alpha = -Math.PI / 2;
      camera.beta = Math.PI / 2;
      camera.setTarget(Vector3.Zero());
    },
    decalStageMeshes: () => decalStage?.meshes ?? [],
    dispose: () => {
      meshGeneration += 1;
      disposeTextPreview();
      disposeDecalStage();
      disposeParticles();
      disposeFlat();
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
 * before the shader warm deadline (not charged for time a frame held the
 * thread, up to `budget`, and renewed while `compiles` sees shaders finish, see
 * `waitUntilReady`) or `isCurrent` turned false.
 */
export async function renderPreviewFrame(
  host: MaterialPreviewScene,
  isCurrent: () => boolean = () => true,
  budget?: HeldThreadBudget,
  compiles?: DriverCompileWatch,
): Promise<boolean> {
  await host.renderer.prepare(() => {
    if (!isCurrent()) throw new Error("Preview frame was superseded.");
  });
  return waitUntilReady(() => {
    const frame = host.renderer.render();
    // A decal whose Material still compiles was left out of the frame.
    return frame.rendered && frame.readyForPresentation && !sceneDecalsPending(host.scene);
  }, isCurrent, budget, compiles ?? new DriverCompileWatch(host.scene.getEngine()));
}

/** A preview output target the FrameGraph can draw into: color plus depth. */
export function createPreviewRenderTarget(name: string, size: { width: number; height: number }, scene: Scene): RenderTargetTexture {
  return createDepthTextureTarget(name, size, scene);
}

const TAP_TOLERANCE_PX = 8;
const ORBIT_SCALE = 0.005;
const MATERIAL_PREVIEW_MAX_SIZE = 512;
/** A flat preview's longest side: it draws at the canvas's device pixels, since its nodes measure in pixels. */
const MATERIAL_PREVIEW_FLAT_MAX_SIZE = 2048;

interface PointerSample {
  x: number;
  y: number;
}

function pointerSpread(points: PointerSample[]): number {
  if (points.length < 2) return 0;
  return Math.hypot(points[0]!.x - points[1]!.x, points[0]!.y - points[1]!.y);
}

/** The closest radius preview zoom allows: the camera's own limit, else the editor camera's. */
function previewRadiusLower(camera: ArcRotateCamera): number {
  return camera.lowerRadiusLimit ?? MIN_CAMERA_RADIUS;
}

/** The farthest radius preview zoom allows: the camera's own limit, else the editor camera's. */
function previewRadiusUpper(camera: ArcRotateCamera): number {
  return camera.upperRadiusLimit ?? MAX_CAMERA_RADIUS;
}

function zoomPreviewCamera(camera: ArcRotateCamera, factor: number): void {
  camera.radius = Math.min(previewRadiusUpper(camera), Math.max(previewRadiusLower(camera), camera.radius / factor));
}

/**
 * Orbit / pinch / wheel on the preview canvas only.
 *
 * Do not use `camera.attachControl` — Babylon 8 binds that to the Engine
 * input element (the Scene / Play canvas).
 *
 * A finger whose up never reaches the canvas (its capture lost, or the up delivered elsewhere) would stay counted, so
 * every later one-finger drag would read as a pinch against it and only zoom. As in the viewport, such fingers are
 * dropped when their capture is lost or when a new gesture's primary pointer goes down.
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
    /** True makes a zoom button tap jump its whole step instead of gliding (Reduce Motion). */
    zoomInstant?: () => boolean;
    /** Held for the length of a zoom button press, so the preview keeps drawing. */
    scheduler?: Pick<RenderScheduler, "acquireContinuous">;
  },
): { dispose: () => void; zoomDrive: ViewportZoomDrive } {
  // A flat preview (a User Interface Material, `MaterialPreviewScene.flat`) is the only orthographic one: it neither
  // orbits nor zooms.
  const flat = () => camera.mode === Camera.ORTHOGRAPHIC_CAMERA;
  // Zoom buttons: the same clamped zoom as pinch and wheel, ending a press at the radius limit.
  const zoomDrive = createViewportZoomDrive(
    {
      zoom: (factor) => {
        zoomPreviewCamera(camera, factor);
        options?.onChange?.();
      },
    },
    {
      scheduler: options?.scheduler,
      isEnabled: () => !flat(),
      instantStep: () => options?.zoomInstant?.() === true,
      atLimit: (direction: ViewportZoomDirection) =>
        direction === 1 ? camera.radius <= previewRadiusLower(camera) : camera.radius >= previewRadiusUpper(camera),
    },
  );
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
    // A primary pointer starts a new gesture: any pointer still listed lifted without an up reaching the canvas.
    if (event.isPrimary === true && pointers.size > 0) {
      for (const [pointerId, stale] of pointers) options?.onPointer?.("up", stale.x, stale.y, pointerId);
      pointers.clear();
    }
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
    if (stealing || flat()) return;
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

  // A pointer whose capture is lost gets no up here; one that did end is already gone.
  const onLostCapture = (event: PointerEvent) => {
    if (pointers.has(event.pointerId)) cancelPointer(event);
  };

  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    if (flat()) return;
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
  canvas.addEventListener("lostpointercapture", onLostCapture);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("touchstart", onTouch, { passive: false });
  canvas.addEventListener("touchmove", onTouch, { passive: false });

  return {
    zoomDrive,
    dispose: () => {
      zoomDrive.dispose();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", endPointer);
      canvas.removeEventListener("pointercancel", cancelPointer);
      canvas.removeEventListener("lostpointercapture", onLostCapture);
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
  /**
   * Static content stops drawing once a complete frame has been read back and
   * draws again only after a forced present, a resize or a scene change.
   * Animated content (time-driven materials, playing animations, particles)
   * keeps drawing every interval.
   */
  setStaticContent: (isStatic: boolean) => void;
  dispose: () => void;
}

function previewBufferSize(
  canvas: HTMLCanvasElement,
  maxSize: number,
  pixelRatio = 1,
): { width: number; height: number } | null {
  const width = Math.floor((canvas.clientWidth || 0) * pixelRatio);
  const height = Math.floor((canvas.clientHeight || 0) * pixelRatio);
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
 *
 * A static preview (`staticContent`) keeps presenting until a frame was drawn
 * with the Scene fully ready and its pixels are on the canvas, then idles. A
 * forced present, a canvas resize, a Scene membership or material change
 * (the renderer's readiness-dirty signal, which covers models and textures
 * that finish loading), a running animation or `animating` content wakes it.
 */
/**
 * What a preview presenter draws: a Scene, its renderer and camera (whose output target it owns), and the mesh it
 * waits for before the first frame. Material previews pass their whole host; other previews (Camera Shake) build
 * their own Scene.
 */
export type PreviewPresenterHost = Pick<MaterialPreviewScene, "scene" | "renderer" | "mesh"> & Partial<Pick<MaterialPreviewScene, "flat">> & {
  camera: Camera & { radius?: number };
};

export function createMaterialPreviewPresenter(
  host: PreviewPresenterHost,
  canvas: HTMLCanvasElement,
  options: {
    maxSize?: number;
    maxFps?: number;
    now?: () => number;
    onError?: (message: string | null) => void;
    staticContent?: boolean;
    /** A static preview settles only while this holds, for overlay layers that compile their own shaders. */
    settleWhen?: () => boolean;
    /**
     * Content that advances only while the Scene renders but does not register as an
     * animatable (particles). While it returns true a settled static preview wakes and
     * keeps drawing; polled once per `present`, so it must be cheap.
     */
    animating?: () => boolean;
    /** Polled by `present`: while true nothing draws and a forced redraw waits for it to clear. */
    suspended?: () => boolean;
  } = {},
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
  let staticContent = options.staticContent === true;
  // True once a ready frame's pixels reached the canvas; only a static preview settles.
  let settled = false;
  let settledSize = { width: 0, height: 0 };
  // Global Parameter nodes read the defaults when they draw, so an edit redraws a settled preview.
  let settledGlobalParameters = globalParameterDefaults.revision;
  let renderError: string | null = null;
  let readbackError: string | null = null;
  const blitter = createRttCanvasBlitter();
  // A flat preview draws at the canvas's device pixels (up to MATERIAL_PREVIEW_FLAT_MAX_SIZE), any other at CSS pixels.
  const bufferSize = () => host.flat === true
    ? previewBufferSize(canvas, MATERIAL_PREVIEW_FLAT_MAX_SIZE, canvas.ownerDocument?.defaultView?.devicePixelRatio || 1)
    : previewBufferSize(canvas, maxSize);

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

  const settle = (size: { width: number; height: number }) => {
    if (!staticContent || pendingForce || options.settleWhen?.() === false) return;
    settledSize = size;
    settledGlobalParameters = globalParameterDefaults.revision;
    settled = true;
  };

  const changedSinceSettled = (): boolean => {
    if (pendingForce) return true;
    const size = bufferSize();
    // A hidden canvas keeps its last frame.
    if (size && (size.width !== settledSize.width || size.height !== settledSize.height)) return true;
    return (
      host.renderer.readinessDirty ||
      globalParameterDefaults.revision !== settledGlobalParameters ||
      host.scene.animatables.length > 0 ||
      options.animating?.() === true
    );
  };

  const blit = (texture: RenderTargetTexture, size: { width: number; height: number }) => {
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
          if (host.scene.getEngine() instanceof NullEngine) settle(size);
          else reportReadback("The material preview readback returned no pixels.");
          return;
        }
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
        blitter.put(ctx, buffer, width, height);
        if (readbackError) {
          readbackError = null;
          options.onError?.(null);
        }
        settle(size);
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
      if (frozen || blitInFlight || options.suspended?.()) return;
      if (settled) {
        if (!changedSinceSettled()) return;
        settled = false;
      }
      const at = now();
      if (!pendingForce && at - lastPresentMs < minIntervalMs) return;
      // e2e telemetry: refreshed per presentation attempt, not per requested frame.
      if (host.camera.radius !== undefined) canvas.dataset.cameraRadius = String(host.camera.radius);
      const size = bufferSize();
      if (!size) return;
      try {
        const scale = resolveSceneRenderingQuality(host.scene).resolution.scale;
        const texture = ensureRtt(Math.max(1, Math.round(size.width * scale)), Math.max(1, Math.round(size.height * scale)));
        // Shader warm-up must not consume a static preview's presentation interval.
        const preview = host.scene.getMeshByName("materialPreviewText") ?? host.scene.getMeshByName("materialPreviewParticlePlane") ??
          host.scene.getMeshByName(MATERIAL_PREVIEW_USER_INTERFACE_NAME) ?? host.scene.getMeshByName(MATERIAL_PREVIEW_DECAL_RECEIVER) ??
          host.mesh;
        if (!previewMeshesReady(preview)) return;
        const frame = host.renderer.render();
        // A decal whose Material still compiles was skipped: keep the last image until it draws.
        if (!frame.rendered || !frame.readyForPresentation || sceneDecalsPending(host.scene)) {
          // Surfaces a failed preparation; otherwise the frame stays pending.
          host.renderer.isReady();
          return;
        }
        pendingForce = false;
        lastPresentMs = at;
        blit(texture, size);
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
    setStaticContent: (value) => {
      staticContent = value;
      settled = false;
    },
    dispose: () => {
      disposed = true;
      releaseRtt();
    },
  };
}
