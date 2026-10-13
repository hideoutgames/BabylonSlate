import { isEditorCameraModel } from "./editor-camera-model";
import {
  Color3,
  CreateDashedLinesVertexData,
  FreeCamera,
  Matrix,
  MeshBuilder,
  Quaternion,
  RenderTargetTexture,
  TransformNode,
  Vector3,
  VertexBuffer,
  VertexData,
  type AbstractMesh,
  type Light,
  type LinesMesh,
  type Node,
  type Observer,
  type Scene,
} from "@babylonjs/core";
import {
  DEFAULT_CAMERA_FIELD_OF_VIEW,
  DEFAULT_CAMERA_ORTHOGRAPHIC_SIZE,
  normalizeRenderTargetCaptureProperties,
  normalizeRenderTargetPayload,
  parseAreaRectLightProperties,
  type RenderTargetCaptureProperties,
  type RenderTargetPayload,
  type SerializedActor,
  type SerializedComponent,
  type SerializedScene,
} from "@babylonslate/core";
import {
  composeActorComponentTransform,
  composeAuthoredComponentTransform,
  applyAuthoredCameraLens,
  type AuthoredCameraProperties,
} from "./scene-illumination";
import { actorIdFromMeshName, editorComponentMeshName, editorMeshName } from "./scene-loader";
import { actorMeshName } from "./picking";
import { authoredComponentActorTransform } from "./authored-transform-matrices";
import { createRttCanvasBlitter } from "./flip-read-pixels";
import { markEditorHelperMesh } from "./helper-mesh";
import { withSceneReadinessState } from "./scene-perf";
import { isRenderTargetCaptureCandidate } from "./render-target-capture";
import { admittedSceneMeshes } from "./scene-stream-admission";
import type { AudioLibrary } from "./audio-service";

export const CAMERA_PREVIEW_INTERVAL_MS = 1000;
export const CAMERA_PREVIEW_WIDTH = 320;
export const CAMERA_PREVIEW_HEIGHT = 180;
const CAMERA_PREVIEW_ASPECT = CAMERA_PREVIEW_WIDTH / CAMERA_PREVIEW_HEIGHT;

/** Largest preview bitmap with the lens aspect that fits the 320×180 PIP box. */
function lensPreviewSize(aspect: number): { width: number; height: number } {
  if (aspect >= CAMERA_PREVIEW_ASPECT) {
    return { width: CAMERA_PREVIEW_WIDTH, height: Math.max(1, Math.round(CAMERA_PREVIEW_WIDTH / aspect)) };
  }
  return { width: Math.max(1, Math.round(CAMERA_PREVIEW_HEIGHT * aspect)), height: CAMERA_PREVIEW_HEIGHT };
}

export type LightDebugKind = "point" | "spot" | "directional" | "area";

type OverlaySync = {
  sceneData: SerializedScene | null;
  selectedActorIds: readonly string[];
  selectedComponentIds?: readonly string[];
  audioLibrary?: Pick<AudioLibrary, "audio" | "attenuations">;
};

export type EditorDebugOverlayOptions = {
  /** Test clock; the overlay then ticks only when the caller asks. */
  now?: () => number;
  /** Installed Render Target assets; a selected capture takes its aspect from its target. */
  renderTargets?: () => ReadonlyMap<string, RenderTargetPayload> | undefined;
};

/** Lens drawn for the selected Camera or Render Target Capture. */
type LensDebug = {
  lens: AuthoredCameraProperties;
  /** Width / height of the image the lens produces. */
  aspect: number;
  /** Meshes the lens renders. */
  renderList: AbstractMesh[];
  /** Normalized settings of a capture lens; undefined for a camera. */
  capture?: RenderTargetCaptureProperties;
};

const DEBUG_FAR_MIN = 8;
const DEBUG_FAR_NEAR_SCALE = 40;

function debugFarDistance(nearClip: number, farClip: number): number {
  return Math.min(farClip, Math.max(DEBUG_FAR_MIN, nearClip * DEBUG_FAR_NEAR_SCALE));
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Every guide path gets 64 dashes, so the pattern scales with the path's length. */
const DASH_STYLE = { dashSize: 0.12, gapSize: 0.08, dashNb: 64 } as const;
const GUIDE_COLOR = { r: 0.85, g: 0.9, b: 0.4 } as const;

function dashedLines(
  name: string,
  points: Vector3[],
  scene: Scene,
  parent: TransformNode,
): LinesMesh {
  const mesh = MeshBuilder.CreateDashedLines(name, { points, ...DASH_STYLE }, scene);
  mesh.color = new Color3(GUIDE_COLOR.r, GUIDE_COLOR.g, GUIDE_COLOR.b);
  mesh.isPickable = false;
  mesh.parent = parent;
  return mesh;
}

/**
 * A persistent selection guide: a hidden root and one dashed LinesMesh holding
 * every path of the shape. It joins the Scene once, and showing, hiding,
 * moving or reshaping it afterwards never adds or removes a mesh or material.
 * Scene membership changes force the whole-scene strict readiness probe, which
 * is far costlier than a selection. The root is never parented to an actor
 * mesh, because disposing a parent also disposes its children.
 */
class DashedGuide {
  readonly root: TransformNode;
  private readonly lines: LinesMesh;
  private readonly namePrefix: string;
  private shape: string | null = null;

  constructor(scene: Scene, namePrefix: string) {
    this.namePrefix = namePrefix;
    this.root = new TransformNode(namePrefix, scene);
    this.root.rotationQuaternion = Quaternion.Identity();
    this.root.setEnabled(false);
    // Placeholder dashes: a real mesh lets the line shader compile with the
    // Scene's load instead of on the first selection. The first reshape replaces it.
    const lines = MeshBuilder.CreateDashedLines(
      `${namePrefix}lines`,
      { points: [Vector3.Zero(), Vector3.Forward()], ...DASH_STYLE, updatable: true },
      scene,
    );
    lines.color = new Color3(GUIDE_COLOR.r, GUIDE_COLOR.g, GUIDE_COLOR.b);
    lines.isPickable = false;
    lines.parent = this.root;
    markEditorHelperMesh(lines);
    this.lines = lines;
  }

  /** Name the guide after the actor it currently shows. */
  label(actorId: string): void {
    this.root.name = `${this.namePrefix}${actorId}`;
    this.lines.name = `${this.namePrefix}${actorId}:lines`;
  }

  /**
   * Replace the dashes in place unless `shape` is the one already drawn. The
   * vertex count follows the dash builder, so a changed count (floating-point
   * dash rounding, a different path set) replaces the buffers instead.
   */
  reshape(shape: string, paths: () => Vector3[][]): void {
    if (shape === this.shape) return;
    this.shape = shape;
    const positions: number[] = [];
    for (const points of paths()) {
      const dashes = CreateDashedLinesVertexData({ points, ...DASH_STYLE }).positions;
      if (dashes) for (let index = 0; index < dashes.length; index += 1) positions.push(dashes[index]!);
    }
    const vertices = positions.length / 3;
    if (this.lines.getTotalVertices() === vertices) {
      // Dashes are consecutive index pairs, so equal counts mean equal indices.
      this.lines.updateVerticesData(VertexBuffer.PositionKind, new Float32Array(positions), true);
      return;
    }
    const data = new VertexData();
    data.positions = positions;
    data.indices = Array.from({ length: vertices }, (_, index) => index);
    data.applyToMesh(this.lines, true);
  }

  setShown(shown: boolean): void {
    this.root.setEnabled(shown);
  }

  dispose(): void {
    this.root.dispose();
  }
}

function buildFrustumCornersLocal(lens: AuthoredCameraProperties, aspect: number): Vector3[] {
  const near = asNumber(lens.nearClip, 0.1);
  const far = debugFarDistance(near, asNumber(lens.farClip, 1000));
  let nearH: number;
  let nearW: number;
  let farH: number;
  let farW: number;
  if (lens.projectionMode === "orthographic") {
    const ortho = Math.max(
      0.01,
      asNumber(lens.orthographicSize, DEFAULT_CAMERA_ORTHOGRAPHIC_SIZE),
    );
    nearH = ortho;
    farH = ortho;
    nearW = ortho * aspect;
    farW = nearW;
  } else {
    const fov = (asNumber(lens.fieldOfView, DEFAULT_CAMERA_FIELD_OF_VIEW) * Math.PI) / 180;
    const t = Math.tan(fov / 2);
    nearH = t * near;
    farH = t * far;
    nearW = nearH * aspect;
    farW = farH * aspect;
  }
  return [
    new Vector3(-nearW, -nearH, near),
    new Vector3(nearW, -nearH, near),
    new Vector3(nearW, nearH, near),
    new Vector3(-nearW, nearH, near),
    new Vector3(-farW, -farH, far),
    new Vector3(farW, -farH, far),
    new Vector3(farW, farH, far),
    new Vector3(-farW, farH, far),
  ];
}

function ringPoints(center: Vector3, axis: Vector3, radius: number, segments = 32): Vector3[] {
  const normal = axis.normalize();
  const tangent = Vector3.Cross(normal, Vector3.Right());
  const bitangent = tangent.lengthSquared() < 1e-6
    ? Vector3.Cross(normal, Vector3.Up())
    : tangent;
  bitangent.normalize();
  const tan = Vector3.Cross(bitangent, normal).normalize();
  const points: Vector3[] = [];
  for (let i = 0; i <= segments; i++) {
    const theta = (i / segments) * Math.PI * 2;
    points.push(
      center.add(tan.scale(Math.cos(theta) * radius)).add(bitangent.scale(Math.sin(theta) * radius)),
    );
  }
  return points;
}

/** Rings of a point light's range sphere: three world-axis circles about the light. */
function pointLightPaths(range: number): Vector3[][] {
  return [
    ringPoints(Vector3.Zero(), Vector3.Up(), range),
    ringPoints(Vector3.Zero(), Vector3.Right(), range),
    ringPoints(Vector3.Zero(), Vector3.Forward(), range),
  ];
}

/** A spot light's axis, base ring and four rim edges, aimed down local +Z. */
function spotLightPaths(range: number, outerAngleDegrees: number): Vector3[][] {
  const forward = Vector3.Forward();
  const radius = Math.tan((outerAngleDegrees * Math.PI) / 360) * range;
  const base = forward.scale(range);
  const rim = ringPoints(base, forward, radius, 4);
  return [
    [Vector3.Zero(), base],
    ringPoints(base, forward, radius),
    ...[0, 1, 2, 3].map((index) => [Vector3.Zero(), rim[index]!]),
  ];
}

/** A directional light's shaft and arrow head along local +Z. */
function directionalLightPaths(): Vector3[][] {
  const forward = Vector3.Forward();
  const tip = forward.scale(2);
  const right = Vector3.Cross(forward, Vector3.Up());
  if (right.lengthSquared() < 1e-6) right.copyFrom(Vector3.Right());
  right.normalize();
  return [
    [Vector3.Zero(), tip],
    [tip.add(right.scale(-0.25)).add(forward.scale(-0.4)), tip, tip.add(right.scale(0.25)).add(forward.scale(-0.4))],
  ];
}

/**
 * An area light's rectangle, emission arrow and short parallel guides. The
 * guides indicate the emitting side (local -Z), never a cutoff or cone.
 */
function areaLightPaths(width: number, height: number): Vector3[][] {
  const w = width / 2, h = height / 2;
  const corners = [new Vector3(-w, -h, 0), new Vector3(w, -h, 0), new Vector3(w, h, 0), new Vector3(-w, h, 0)];
  const distance = Math.min(2, Math.max(0.4, Math.min(width, height)));
  const tip = new Vector3(0, 0, -distance);
  return [
    [...corners, corners[0]!],
    [Vector3.Zero(), tip],
    [new Vector3(-distance * 0.15, 0, -distance * 0.75), tip, new Vector3(distance * 0.15, 0, -distance * 0.75)],
    ...corners.map((corner) => [corner, corner.add(new Vector3(0, 0, -distance * 0.25))]),
  ];
}

/** Near quad, far quad and the four rails joining them. */
const FRUSTUM_EDGES: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 0],
  [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

function frustumPaths(lens: AuthoredCameraProperties, aspect: number): Vector3[][] {
  const corners = buildFrustumCornersLocal(lens, aspect);
  return FRUSTUM_EDGES.map(([a, b]) => [corners[a]!, corners[b]!]);
}

/**
 * Editor-only frustum, light/audio influence, and 1 Hz lens preview RTT for a
 * selected Camera or Render Target Capture. Does not replace the orbit camera
 * or the hemispheric fill light.
 *
 * The light and lens guides are created with the overlay, and the preview camera
 * and RTT by the first lens selection (outside the Scene's camera and texture
 * lists). They are only shown, hidden, moved and reshaped afterwards: selecting
 * an actor or editing the selected one never changes the Scene's mesh, material,
 * texture or camera membership, so it cannot force a whole-scene readiness
 * probe. One guide of each kind is enough, as only the first selected light and
 * the first selected lens are drawn. The preview RTT is at most 320×180 RGBA8
 * plus its depth buffer (about 0.5 MB); it renders only while a lens is selected
 * and is released with the overlay. Audio radii are still built per sync.
 */
export class EditorDebugOverlay {
  /** Root of the lens guide while a lens is selected. */
  frustumMesh: Node | null = null;
  /** Root of the light guide while a light is selected. */
  lightDebugMesh: Node | null = null;
  previewRenderCount = 0;
  lightDebugKind: LightDebugKind | null = null;

  /** The preview RTT while a lens is selected; null otherwise, though the RTT is retained. */
  get previewTexture(): RenderTargetTexture | null {
    return this.lensActive ? (this.preview?.rtt ?? null) : null;
  }

  private readonly scene: Scene;
  private readonly now: () => number;
  private readonly useExternalClock: boolean;
  private readonly lightGuide: DashedGuide;
  private readonly lensGuide: DashedGuide;
  /** The retained PIP camera and RTT, created by the first lens selection. */
  private preview: { camera: FreeCamera; rtt: RenderTargetTexture } | null = null;
  private lensActive = false;
  private lensActorId: string | null = null;
  private lensOrigin: AbstractMesh | null = null;
  /** The selected lens' pose relative to its actor's editor origin mesh. */
  private readonly lensLocal = Matrix.Identity();
  /** World pose used while the actor has no editor origin mesh. */
  private readonly lensFallbackPosition = Vector3.Zero();
  private readonly lensFallbackRotation = Quaternion.Identity();
  private readonly poseScratch = Matrix.Identity();
  /** The selected area light's authored native light, found by name and followed through its parent. */
  private areaLightName: string | null = null;
  private areaNative: Light | null = null;
  private previewLens: AuthoredCameraProperties | null = null;
  private previewAspect = CAMERA_PREVIEW_ASPECT;
  /** Settings of the previewed capture; null for a camera or no lens. */
  private previewCapture: RenderTargetCaptureProperties | null = null;
  private lastSync: OverlaySync | null = null;
  private readonly renderTargets: EditorDebugOverlayOptions["renderTargets"];
  private previewCanvas: HTMLCanvasElement | null = null;
  private lastPreviewMs = Number.NEGATIVE_INFINITY;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private disposed = false;
  private readonly poseObserver: Observer<Scene> | null;
  private readonly meshAddedObserver: Observer<AbstractMesh> | null;
  private readonly meshRemovedObserver: Observer<AbstractMesh> | null;
  /** Names `getMeshByName` missed since the scene's meshes last changed. */
  private readonly missedMeshNames = new Set<string>();
  private meshesChanged = false;
  private missedMeshCount = 0;
  private readonly previewBlitter = createRttCanvasBlitter();
  // The shared blitter reuses one buffer: draw each readback before the next.
  private previewBlitInFlight = false;
  private audioDebug: Array<{
    root: TransformNode;
    actor: SerializedActor;
    component: SerializedComponent;
    visual: AbstractMesh | null;
    origin: AbstractMesh | null;
  }> = [];

  constructor(scene: Scene, options?: EditorDebugOverlayOptions) {
    this.scene = scene;
    this.now = options?.now ?? (() => Date.now());
    this.useExternalClock = Boolean(options?.now);
    this.renderTargets = options?.renderTargets;
    // Built before any content loads, so these joins never force a probe of a loaded Scene.
    this.lightGuide = new DashedGuide(scene, "debugLight:");
    this.lensGuide = new DashedGuide(scene, "debugFrustum:");
    this.poseObserver = scene.onBeforeRenderObservable.add(() => this.updateHelperPoses());
    // Additions notify after a deferral and removals immediately; the mesh
    // count in `findMesh` covers an addition not yet notified.
    this.meshAddedObserver = scene.onNewMeshAddedObservable.add(() => { this.meshesChanged = true; });
    this.meshRemovedObserver = scene.onMeshRemovedObservable.add(() => { this.meshesChanged = true; });
  }

  setPreviewCanvas(canvas: HTMLCanvasElement | null): void {
    this.previewCanvas = canvas;
    this.updatePreviewCanvasVisibility();
  }

  sync(options: OverlaySync): void {
    if (this.disposed) return;
    this.disposeAudioDebug();
    this.lastSync = options;
    const sceneData = options.sceneData;
    if (!sceneData) {
      this.hideLens();
      this.hideLight();
      this.updatePreviewCanvasVisibility();
      return;
    }
    const selected = collectSelected(sceneData, options);
    // One lens at a time: the first selected Camera or Render Target Capture.
    const lens = selected.find((entry) =>
      entry.component.classId === "CameraComponent" ||
      entry.component.classId === "RenderTargetCaptureComponent");
    const light = selected.find((entry) => entry.component.classId === "LightComponent" || entry.component.classId === "AreaRectLightComponent");
    if (lens) {
      this.showLens(
        lens.actor,
        lens.component,
        lens.component.classId === "CameraComponent"
          ? this.cameraLens(lens.component)
          : this.captureLens(lens.component),
      );
    } else {
      this.hideLens();
    }
    if (light) this.showLight(light.actor, light.component, sceneData.actors);
    else this.hideLight();
    for (const { actor, component } of selected) {
      if (component.classId !== "AudioComponent") continue;
      const guid = component.properties.audioAssetGuid;
      if (typeof guid !== "string") continue;
      const attenuationGuid = options.audioLibrary?.audio.get(guid)?.soundAttenuationGuid;
      const attenuation = attenuationGuid
        ? options.audioLibrary?.attenuations.get(attenuationGuid)
        : undefined;
      if (attenuation) {
        this.buildAudioDebug(actor, component, attenuation.innerRadius, attenuation.maxRadius);
      }
    }
    this.followLivePose();
    this.updatePreviewCanvasVisibility();
    this.ensureTimer();
  }

  /**
   * After asset installation, re-lens a selected capture's frustum and preview
   * when its Render Target's aspect changed. Otherwise keep the RTT and only
   * re-filter its meshes, since installs can rebuild captured geometry.
   */
  refreshRenderTargets(): void {
    const capture = this.previewCapture;
    if (this.stopped || !this.lastSync || !capture) return;
    if (this.captureAspect(capture.renderTargetGuid) !== this.previewAspect) {
      this.sync(this.lastSync);
      return;
    }
    if (this.preview) this.preview.rtt.renderList = this.captureRenderList(capture);
  }

  /**
   * Move the guides onto their actors' live poses and copy the lens pose onto
   * the PIP camera, so the preview tracks a gizmo drag before the document commit.
   */
  followLivePose(): void {
    this.updateHelperPoses();
    if (!this.lensActive) return;
    this.copyLensPoseToPreviewCamera();
  }

  tick(nowMs?: number): void {
    const preview = this.preview;
    if (!this.lensActive || !preview) return;
    this.followLivePose();
    const now = nowMs ?? this.now();
    if (now - this.lastPreviewMs < CAMERA_PREVIEW_INTERVAL_MS) return;
    this.lastPreviewMs = now;
    if (this.previewLens) {
      applyAuthoredCameraLens(preview.camera, this.previewLens, this.previewAspect);
    }
    const engine = this.scene.getEngine();
    const target = engine._currentRenderTarget;
    withSceneReadinessState(this.scene, () => {
      // A timed RTT is a separate camera pass. The preceding gizmo draw can
      // leave Babylon's floating origin on its utility scene, and a 2D RTT
      // does not advance the render ID used to cache origin-relative lights.
      this.scene.incrementRenderId();
      this.scene.resetCachedMaterial();
      try {
        preview.rtt.render(false);
      } finally {
        // The caller must not reuse the preview camera's cached light data.
        this.scene.incrementRenderId();
        if (engine._currentRenderTarget !== target) {
          if (target) engine.bindFramebuffer(target);
          else engine.restoreDefaultFramebuffer(true);
        }
      }
    });
    this.previewRenderCount += 1;
    void this.blitPreview();
  }

  /**
   * Stop host-side work (the preview timer, pose follow and canvas writes)
   * while a shared Engine may still borrow the preview RTT and meshes.
   */
  stop(): void {
    this.stopped = true;
    this.scene.onBeforeRenderObservable.remove(this.poseObserver);
    this.scene.onNewMeshAddedObservable.remove(this.meshAddedObserver);
    this.scene.onMeshRemovedObservable.remove(this.meshRemovedObserver);
    this.clearTimer();
    this.previewCanvas = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
    this.disposeAudioDebug();
    this.lightGuide.dispose();
    this.lensGuide.dispose();
    this.preview?.rtt.dispose();
    this.preview?.camera.dispose();
    this.preview = null;
  }

  private ensureTimer(): void {
    if (this.stopped || this.useExternalClock || this.timer || !this.lensActive) return;
    this.timer = setInterval(() => this.tick(), CAMERA_PREVIEW_INTERVAL_MS);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private disposeAudioDebug(): void {
    for (const { root } of this.audioDebug) root.dispose();
    this.audioDebug = [];
  }

  /** Stop previewing: hide the guide and idle the retained camera and RTT. */
  private hideLens(): void {
    if (!this.lensActive) return;
    this.lensActive = false;
    this.lensGuide.setShown(false);
    this.frustumMesh = null;
    this.lensActorId = null;
    this.lensOrigin = null;
    this.previewLens = null;
    this.previewAspect = CAMERA_PREVIEW_ASPECT;
    this.previewCapture = null;
    if (this.preview) this.preview.rtt.renderList = [];
    this.previewRenderCount = 0;
    this.lastPreviewMs = Number.NEGATIVE_INFINITY;
    this.clearTimer();
  }

  private hideLight(): void {
    this.lightGuide.setShown(false);
    this.lightDebugMesh = null;
    this.lightDebugKind = null;
    this.areaLightName = null;
    this.areaNative = null;
  }

  /** Camera lenses keep the fixed 16:9 PIP aspect and their existing mesh list. */
  private cameraLens(component: SerializedComponent): LensDebug {
    const nearClip = Math.max(0.01, asNumber(component.properties.nearClip, 0.1));
    return {
      lens: {
        projectionMode:
          component.properties.projectionMode === "orthographic"
            ? "orthographic"
            : "perspective",
        fieldOfView: asNumber(component.properties.fieldOfView, DEFAULT_CAMERA_FIELD_OF_VIEW),
        orthographicSize: asNumber(
          component.properties.orthographicSize,
          DEFAULT_CAMERA_ORTHOGRAPHIC_SIZE,
        ),
        nearClip,
        farClip: Math.max(nearClip + 0.01, asNumber(component.properties.farClip, 1000)),
      },
      aspect: CAMERA_PREVIEW_ASPECT,
      renderList: this.scene.meshes.filter(
        (mesh) => !mesh.name.startsWith("debug") && !isEditorCameraModel(mesh),
      ),
    };
  }

  /**
   * A capture previews its own lens: normalized FOV and clips, the assigned
   * target's aspect (1:1 when unassigned) and the capture's mesh eligibility.
   * It shows the lens even while the capture is disabled or manual.
   */
  private captureLens(component: SerializedComponent): LensDebug {
    const settings = normalizeRenderTargetCaptureProperties(component.properties);
    return {
      lens: {
        projectionMode: "perspective",
        fieldOfView: settings.fieldOfView,
        nearClip: settings.nearClip,
        farClip: settings.farClip,
      },
      aspect: this.captureAspect(settings.renderTargetGuid),
      capture: settings,
      renderList: this.captureRenderList(settings),
    };
  }

  /**
   * Meshes the capture records: capture candidates, filtered by Capture Only
   * Actors. Materials may sample the target's last completed capture.
   */
  private captureRenderList(settings: RenderTargetCaptureProperties): AbstractMesh[] {
    const included = settings.captureOnlyActors ? new Set(settings.actorIds) : null;
    return (admittedSceneMeshes(this.scene) ?? this.scene.meshes).filter((mesh) => {
      if (!isRenderTargetCaptureCandidate(mesh)) return false;
      // Nearest actor owner, so an attached child actor needs its own entry.
      return !included || included.has(actorIdFromMeshName(actorMeshName(mesh)) ?? "");
    });
  }

  /** Installed Render Target asset, or the default (512² Scene Color) when unassigned or missing. */
  private captureTarget(renderTargetGuid: string | null): RenderTargetPayload {
    const definition = renderTargetGuid ? this.renderTargets?.()?.get(renderTargetGuid) : undefined;
    return normalizeRenderTargetPayload(definition);
  }

  private captureAspect(renderTargetGuid: string | null): number {
    const { width, height } = this.captureTarget(renderTargetGuid);
    return width / height;
  }

  /**
   * Point the retained frustum guide, preview camera and RTT at this lens and
   * render the preview once. Re-run on every sync, so an edit shows at once.
   */
  private showLens(actor: SerializedActor, component: SerializedComponent, debug: LensDebug): void {
    const { lens, aspect } = debug;
    this.lensGuide.reshape(
      [lens.projectionMode, lens.nearClip, lens.farClip, lens.fieldOfView, lens.orthographicSize, aspect].join("|"),
      () => frustumPaths(lens, aspect),
    );
    this.lensGuide.label(actor.id);
    const composed = composeActorComponentTransform(actor, component);
    const local = authoredComponentActorTransform(actor, component);
    Matrix.ComposeToRef(
      new Vector3(local.scale[0], local.scale[1], local.scale[2]),
      new Quaternion(local.rotation[0], local.rotation[1], local.rotation[2], local.rotation[3]),
      new Vector3(local.position[0], local.position[1], local.position[2]),
      this.lensLocal,
    );
    this.lensFallbackPosition.copyFrom(composed.position);
    this.lensFallbackRotation.copyFrom(composed.rotation);
    if (this.lensActorId !== actor.id) this.lensOrigin = null;
    this.lensActorId = actor.id;
    this.lensActive = true;
    this.updateLensPose();
    this.lensGuide.setShown(true);
    this.frustumMesh = this.lensGuide.root;

    const size = lensPreviewSize(aspect);
    const { camera, rtt } = this.ensurePreview(size);
    camera.name = `debugPreviewCam:${actor.id}`;
    this.copyLensPoseToPreviewCamera();
    this.previewLens = lens;
    this.previewAspect = aspect;
    this.previewCapture = debug.capture ?? null;
    applyAuthoredCameraLens(camera, lens, aspect);
    rtt.name = `debugCameraPreview:${actor.id}`;
    const current = rtt.getSize();
    if (current.width !== size.width || current.height !== size.height) rtt.resize(size);
    rtt.renderList = debug.renderList;
    this.previewRenderCount = 0;
    this.lastPreviewMs = Number.NEGATIVE_INFINITY;
    this.tick(this.now());
  }

  /** Follow the lens' actor origin mesh, or hold the document pose while it has none. */
  private updateLensPose(): void {
    if (!this.lensActive || this.lensActorId === null) return;
    const root = this.lensGuide.root;
    // The origin is looked up again whenever the actor's meshes are rebuilt.
    if (this.lensOrigin?.isDisposed()) this.lensOrigin = null;
    this.lensOrigin ??= this.findMesh(editorMeshName(this.lensActorId));
    const origin = this.lensOrigin;
    if (origin) {
      origin.computeWorldMatrix(true);
      this.lensLocal.multiplyToRef(origin.getWorldMatrix(), this.poseScratch);
      this.poseScratch.decompose(root.scaling, root.rotationQuaternion!, root.position);
    } else {
      root.position.copyFrom(this.lensFallbackPosition);
      root.rotationQuaternion!.copyFrom(this.lensFallbackRotation);
      root.scaling.setAll(1);
    }
    root.computeWorldMatrix(true);
  }

  /**
   * The PIP camera and RTT are created by the first lens selection. Neither
   * joins `scene.cameras` or `scene.textures`: a membership change would force
   * the whole-scene strict readiness probe, and a stray extra camera could
   * become the scene's active one when another camera is disposed. The water
   * planar reflection does the same. Only this overlay owns them, so `dispose`
   * releases them explicitly.
   */
  private ensurePreview(size: { width: number; height: number }): { camera: FreeCamera; rtt: RenderTargetTexture } {
    if (this.preview) return this.preview;
    const scene = this.scene;
    const blocked = scene._blockEntityCollection;
    scene._blockEntityCollection = true;
    try {
      const camera = new FreeCamera("debugPreviewCam:", Vector3.Zero(), scene, false);
      camera.rotationQuaternion = Quaternion.Identity();
      const rtt = new RenderTargetTexture("debugCameraPreview:", size, scene, false);
      rtt.activeCamera = camera;
      this.preview = { camera, rtt };
    } finally {
      scene._blockEntityCollection = blocked;
    }
    return this.preview;
  }

  private copyLensPoseToPreviewCamera(): void {
    const camera = this.preview?.camera;
    if (!camera) return;
    const root = this.lensGuide.root;
    camera.position.copyFrom(root.position);
    camera.rotationQuaternion!.copyFrom(root.rotationQuaternion!);
    camera.rotation.set(0, 0, 0);
  }

  private showLight(actor: SerializedActor, component: SerializedComponent, actors: readonly SerializedActor[]): void {
    const guide = this.lightGuide;
    const root = guide.root;
    if (component.classId === "AreaRectLightComponent") {
      const name = `authoredAreaLight:${actor.id}:${component.id}`;
      const native = this.scene.getLightByName(name);
      if (!(native?.parent instanceof TransformNode) || native.metadata?.areaLight?.error) {
        this.hideLight();
        return;
      }
      const { width, height } = parseAreaRectLightProperties(component.properties);
      guide.reshape(`area|${width}|${height}`, () => areaLightPaths(width, height));
      this.areaLightName = name;
      this.areaNative = native;
      this.lightDebugKind = "area";
      this.updateAreaPose();
      // The native light vanished while posing: nothing to show.
      if (this.areaLightName === null) return;
    } else {
      const kind = String(component.properties.lightKind ?? "point");
      const range = Math.max(0.1, asNumber(component.properties.range, 10));
      const lightKind: LightDebugKind = kind === "spot" || kind === "directional" ? kind : "point";
      // Match the authored light: parent-resolved actor pose × component transform.
      const composed = composeAuthoredComponentTransform(actor, component, actors);
      if (lightKind === "directional") {
        guide.reshape("directional", directionalLightPaths);
      } else if (lightKind === "spot") {
        const outerAngle = asNumber(component.properties.outerAngle, 45);
        guide.reshape(`spot|${range}|${outerAngle}`, () => spotLightPaths(range, outerAngle));
      } else {
        guide.reshape(`point|${range}`, () => pointLightPaths(range));
      }
      this.areaLightName = null;
      this.areaNative = null;
      this.lightDebugKind = lightKind;
      root.position.copyFrom(composed.position);
      // A point light's rings stay world-aligned, whatever the light's rotation.
      if (lightKind === "point") root.rotationQuaternion!.copyFromFloats(0, 0, 0, 1);
      else root.rotationQuaternion!.copyFrom(composed.rotation);
      root.scaling.setAll(1);
      root.computeWorldMatrix(true);
    }
    guide.label(actor.id);
    guide.setShown(true);
    this.lightDebugMesh = root;
  }

  /**
   * The area-light guide sits at its native light's parent, so it follows live
   * drags. It hides when the native light is gone or reports an error, until a
   * sync finds it again.
   */
  private updateAreaPose(): void {
    const name = this.areaLightName;
    if (name === null) return;
    // A rebuilt native light replaces the disposed one under the same name.
    let native = this.areaNative;
    if (!native || native.isDisposed()) native = this.scene.getLightByName(name);
    const parent = native?.parent;
    if (!native || !(parent instanceof TransformNode) || native.metadata?.areaLight?.error) {
      this.hideLight();
      return;
    }
    this.areaNative = native;
    const root = this.lightGuide.root;
    parent.computeWorldMatrix(true);
    parent.getWorldMatrix().decompose(root.scaling, root.rotationQuaternion!, root.position);
    root.computeWorldMatrix(true);
  }

  private updateHelperPoses(): void {
    this.updateAudioDebugPoses();
    this.updateLensPose();
    this.updateAreaPose();
  }

  /** `getMeshByName` that rescans a missing name only after the scene's meshes change. */
  private findMesh(name: string): AbstractMesh | null {
    const count = this.scene.meshes.length;
    if (this.meshesChanged || count !== this.missedMeshCount) {
      this.missedMeshNames.clear();
      this.meshesChanged = false;
      this.missedMeshCount = count;
    }
    if (this.missedMeshNames.has(name)) return null;
    const mesh = this.scene.getMeshByName(name);
    if (!mesh) this.missedMeshNames.add(name);
    return mesh;
  }

  private updateAudioDebugPoses(): void {
    for (const entry of this.audioDebug) {
      const { root, actor, component } = entry;
      // Runs every frame: keep resolved meshes until they are disposed, and
      // re-resolve unresolved ones as meshes arrive so an emitter realized
      // later is still followed.
      if (entry.visual?.isDisposed()) entry.visual = null;
      entry.visual ??= this.findMesh(editorComponentMeshName(actor.id, component.id));
      const visual = entry.visual;
      if (visual) {
        visual.computeWorldMatrix(true);
        root.position.copyFrom(visual.getAbsolutePosition());
        continue;
      }
      if (entry.origin?.isDisposed()) entry.origin = null;
      entry.origin ??= this.findMesh(editorMeshName(actor.id));
      const origin = entry.origin;
      if (origin) {
        origin.computeWorldMatrix(true);
        const local: readonly [number, number, number] = component.transform?.position ?? [0, 0, 0];
        Vector3.TransformCoordinatesFromFloatsToRef(local[0], local[1], local[2], origin.getWorldMatrix(), root.position);
      } else {
        root.position.copyFrom(composeActorComponentTransform(actor, component).position);
      }
    }
  }

  private buildAudioDebug(
    actor: SerializedActor,
    component: SerializedComponent,
    innerRadius: number,
    maxRadius: number,
  ): void {
    const name = `debugAudio:${actor.id}:${component.id}`;
    const root = new TransformNode(name, this.scene);
    for (const [label, radius, color] of [
      ["inner", innerRadius, Color3.Green()],
      ["max", maxRadius, Color3.Yellow()],
    ] as const) {
      if (radius <= 0) continue;
      for (const [axis, normal] of [Vector3.Up(), Vector3.Right(), Vector3.Forward()].entries()) {
        const mesh = dashedLines(
          `${name}:${label}:${axis}`,
          ringPoints(Vector3.Zero(), normal, radius),
          this.scene,
          root,
        );
        mesh.color = color;
      }
    }
    this.audioDebug.push({ root, actor, component, visual: null, origin: null });
  }

  private updatePreviewCanvasVisibility(): void {
    const canvas = this.previewCanvas;
    if (!canvas) return;
    const active = this.lensActive;
    canvas.hidden = !active;
    canvas.dataset.active = active ? "true" : "false";
  }

  private async blitPreview(): Promise<void> {
    const canvas = this.previewCanvas;
    const texture = this.previewTexture;
    if (!canvas || !texture || this.previewBlitInFlight) return;
    this.previewBlitInFlight = true;
    try {
      const buffer = await this.previewBlitter.read(texture);
      // A stopped overlay or replaced canvas must not receive a late readback.
      if (!buffer || !canvas.getContext || this.previewCanvas !== canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const { width, height } = texture.getSize();
      canvas.width = width;
      canvas.height = height;
      this.previewBlitter.put(ctx, buffer, width, height);
    } catch {
      // NullEngine / missing GPU readback is fine — tests assert the RTT itself.
    } finally {
      this.previewBlitInFlight = false;
    }
  }
}

function collectSelected(
  sceneData: SerializedScene,
  options: OverlaySync,
): Array<{ actor: SerializedActor; component: SerializedComponent }> {
  const actorIds = new Set(options.selectedActorIds);
  const componentIds = options.selectedComponentIds
    ? new Set(options.selectedComponentIds)
    : null;
  const out: Array<{ actor: SerializedActor; component: SerializedComponent }> = [];
  for (const actor of sceneData.actors) {
    if (!actorIds.has(actor.id)) continue;
    for (const component of actor.components) {
      if (componentIds && componentIds.size > 0 && !componentIds.has(component.id)) {
        continue;
      }
      out.push({ actor, component });
    }
  }
  return out;
}
