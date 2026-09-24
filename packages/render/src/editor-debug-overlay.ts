import {
  Color3,
  FreeCamera,
  MeshBuilder,
  Quaternion,
  RenderTargetTexture,
  TransformNode,
  Vector3,
  type LinesMesh,
  type Node,
  type Observer,
  type Scene,
} from "@babylonjs/core";
import {
  DEFAULT_CAMERA_FIELD_OF_VIEW,
  DEFAULT_CAMERA_ORTHOGRAPHIC_SIZE,
  identitySerializedTransform,
  parseAreaRectLightProperties,
  type SerializedActor,
  type SerializedComponent,
  type SerializedScene,
} from "@babylonslate/core";
import {
  composeActorComponentTransform,
  applyAuthoredCameraLens,
  type AuthoredCameraProperties,
} from "./scene-illumination";
import { editorComponentMeshName, editorMeshName } from "./scene-loader";
import { flipReadPixelsRgba } from "./flip-read-pixels";
import { withSceneReadinessState } from "./scene-perf";
import type { AudioLibrary } from "./audio-service";

export const CAMERA_PREVIEW_INTERVAL_MS = 1000;
export const CAMERA_PREVIEW_WIDTH = 320;
export const CAMERA_PREVIEW_HEIGHT = 180;
const CAMERA_PREVIEW_ASPECT = CAMERA_PREVIEW_WIDTH / CAMERA_PREVIEW_HEIGHT;

export type LightDebugKind = "point" | "spot" | "directional" | "area";

type OverlaySync = {
  sceneData: SerializedScene | null;
  selectedActorIds: readonly string[];
  selectedComponentIds?: readonly string[];
  audioLibrary?: Pick<AudioLibrary, "audio" | "attenuations">;
};

function actorPosition(actor: SerializedActor): Vector3 {
  const [x, y, z] = actor.transform.position;
  return new Vector3(x, y, z);
}

function actorRotation(actor: SerializedActor): Quaternion {
  const [x, y, z, w] = actor.transform.rotation;
  return new Quaternion(x, y, z, w);
}

function actorForward(actor: SerializedActor): Vector3 {
  return Vector3.Forward().applyRotationQuaternion(actorRotation(actor));
}

const DEBUG_FAR_MIN = 8;
const DEBUG_FAR_NEAR_SCALE = 40;

function debugFarDistance(nearClip: number, farClip: number): number {
  return Math.min(farClip, Math.max(DEBUG_FAR_MIN, nearClip * DEBUG_FAR_NEAR_SCALE));
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function dashedLines(
  name: string,
  points: Vector3[],
  scene: Scene,
  parent: TransformNode,
): LinesMesh {
  const mesh = MeshBuilder.CreateDashedLines(
    name,
    { points, dashSize: 0.12, gapSize: 0.08, dashNb: 64 },
    scene,
  );
  mesh.color = new Color3(0.85, 0.9, 0.4);
  mesh.isPickable = false;
  mesh.parent = parent;
  return mesh;
}

function buildFrustumCornersLocal(component: SerializedComponent): Vector3[] {
  const near = Math.max(0.01, asNumber(component.properties.nearClip, 0.1));
  const farClip = Math.max(near + 0.01, asNumber(component.properties.farClip, 1000));
  const far = debugFarDistance(near, farClip);
  let nearH: number;
  let nearW: number;
  let farH: number;
  let farW: number;
  if (component.properties.projectionMode === "orthographic") {
    const ortho = Math.max(
      0.01,
      asNumber(component.properties.orthographicSize, DEFAULT_CAMERA_ORTHOGRAPHIC_SIZE),
    );
    nearH = ortho;
    farH = ortho;
    nearW = ortho * CAMERA_PREVIEW_ASPECT;
    farW = nearW;
  } else {
    const fov =
      (asNumber(component.properties.fieldOfView, DEFAULT_CAMERA_FIELD_OF_VIEW) *
        Math.PI) /
      180;
    const t = Math.tan(fov / 2);
    nearH = t * near;
    farH = t * far;
    nearW = nearH * CAMERA_PREVIEW_ASPECT;
    farW = farH * CAMERA_PREVIEW_ASPECT;
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

/**
 * Editor-only frustum, light/audio influence, and 1 Hz camera preview RTT.
 * Does not replace the orbit camera or the hemispheric fill light.
 */
export class EditorDebugOverlay {
  frustumMesh: Node | null = null;
  lightDebugMesh: Node | null = null;
  previewTexture: RenderTargetTexture | null = null;
  previewRenderCount = 0;
  lightDebugKind: LightDebugKind | null = null;

  private readonly scene: Scene;
  private readonly now: () => number;
  private readonly useExternalClock: boolean;
  private previewCamera: FreeCamera | null = null;
  private previewLens: AuthoredCameraProperties | null = null;
  private previewCanvas: HTMLCanvasElement | null = null;
  private lastPreviewMs = Number.NEGATIVE_INFINITY;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly audioPoseObserver: Observer<Scene> | null;
  private audioDebug: Array<{
    root: TransformNode;
    actor: SerializedActor;
    component: SerializedComponent;
  }> = [];

  constructor(scene: Scene, options?: { now?: () => number }) {
    this.scene = scene;
    this.now = options?.now ?? (() => Date.now());
    this.useExternalClock = Boolean(options?.now);
    this.audioPoseObserver = scene.onBeforeRenderObservable.add(() => this.updateAudioDebugPoses());
  }

  setPreviewCanvas(canvas: HTMLCanvasElement | null): void {
    this.previewCanvas = canvas;
    this.updatePreviewCanvasVisibility();
  }

  sync(options: OverlaySync): void {
    this.disposeVisuals();
    const sceneData = options.sceneData;
    if (!sceneData) {
      this.updatePreviewCanvasVisibility();
      return;
    }
    const selected = collectSelected(sceneData, options);
    const camera = selected.find((entry) => entry.component.classId === "CameraComponent");
    const light = selected.find((entry) => entry.component.classId === "LightComponent" || entry.component.classId === "AreaRectLightComponent");
    if (camera) this.buildCameraDebug(camera.actor, camera.component);
    if (light) this.buildLightDebug(light.actor, light.component);
    for (const { actor, component } of selected) {
      if (component.classId !== "AudioComponent") continue;
      const guid = component.properties.audioAssetGuid ?? component.properties.assetGuid;
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
   * Copy the live frustum (origin-parented) world pose onto the PIP camera so
   * the preview tracks a gizmo drag before the document commit.
   */
  followLivePose(): void {
    this.updateAudioDebugPoses();
    const root = this.frustumMesh;
    const camera = this.previewCamera;
    if (!root || !camera) return;
    root.computeWorldMatrix(true);
    const position = Vector3.Zero();
    const rotation = Quaternion.Identity();
    const scaling = Vector3.Zero();
    root.getWorldMatrix().decompose(scaling, rotation, position);
    camera.position.copyFrom(position);
    if (!camera.rotationQuaternion) {
      camera.rotationQuaternion = Quaternion.Identity();
    }
    camera.rotationQuaternion.copyFrom(rotation);
    camera.rotation.set(0, 0, 0);
  }

  tick(nowMs?: number): void {
    if (!this.previewTexture || !this.previewCamera) return;
    this.followLivePose();
    const now = nowMs ?? this.now();
    if (now - this.lastPreviewMs < CAMERA_PREVIEW_INTERVAL_MS) return;
    this.lastPreviewMs = now;
    if (this.previewLens) {
      applyAuthoredCameraLens(
        this.previewCamera,
        this.previewLens,
        CAMERA_PREVIEW_ASPECT,
      );
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
        this.previewTexture!.render(false);
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

  dispose(): void {
    this.scene.onBeforeRenderObservable.remove(this.audioPoseObserver);
    this.clearTimer();
    this.disposeVisuals();
    this.previewCanvas = null;
  }

  private ensureTimer(): void {
    if (this.useExternalClock || this.timer || !this.previewTexture) return;
    this.timer = setInterval(() => this.tick(), CAMERA_PREVIEW_INTERVAL_MS);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private disposeVisuals(): void {
    this.frustumMesh?.dispose();
    this.frustumMesh = null;
    this.lightDebugMesh?.dispose();
    this.lightDebugMesh = null;
    this.lightDebugKind = null;
    for (const { root } of this.audioDebug) root.dispose();
    this.audioDebug = [];
    this.previewTexture?.dispose();
    this.previewTexture = null;
    this.previewCamera?.dispose();
    this.previewCamera = null;
    this.previewLens = null;
    this.previewRenderCount = 0;
    this.lastPreviewMs = Number.NEGATIVE_INFINITY;
    this.clearTimer();
  }

  private buildCameraDebug(actor: SerializedActor, component: SerializedComponent): void {
    const composed = composeActorComponentTransform(actor, component);
    const root = new TransformNode(`debugFrustum:${actor.id}`, this.scene);
    const origin = this.scene.getMeshByName(editorMeshName(actor.id));
    if (origin) {
      const local = component.transform ?? identitySerializedTransform();
      root.parent = origin;
      root.position.set(local.position[0], local.position[1], local.position[2]);
      root.rotationQuaternion = new Quaternion(
        local.rotation[0],
        local.rotation[1],
        local.rotation[2],
        local.rotation[3],
      );
      root.scaling.set(local.scale[0], local.scale[1], local.scale[2]);
    } else {
      root.position.copyFrom(composed.position);
      root.rotationQuaternion = composed.rotation.clone();
    }
    const corners = buildFrustumCornersLocal(component);
    const edges: Array<[number, number]> = [
      [0, 1], [1, 2], [2, 3], [3, 0],
      [4, 5], [5, 6], [6, 7], [7, 4],
      [0, 4], [1, 5], [2, 6], [3, 7],
    ];
    edges.forEach(([a, b], index) => {
      dashedLines(
        `debugFrustum:${actor.id}:${index}`,
        [corners[a]!, corners[b]!],
        this.scene,
        root,
      );
    });
    this.frustumMesh = root;

    const camera = new FreeCamera(
      `debugPreviewCam:${actor.id}`,
      composed.position.clone(),
      this.scene,
      false,
    );
    camera.minZ = Math.max(0.01, asNumber(component.properties.nearClip, 0.1));
    camera.maxZ = Math.max(camera.minZ + 0.01, asNumber(component.properties.farClip, 1000));
    camera.rotationQuaternion = composed.rotation.clone();
    camera.rotation.set(0, 0, 0);
    this.previewLens = {
      projectionMode:
        component.properties.projectionMode === "orthographic"
          ? "orthographic"
          : "perspective",
      fieldOfView: asNumber(
        component.properties.fieldOfView,
        DEFAULT_CAMERA_FIELD_OF_VIEW,
      ),
      orthographicSize: asNumber(
        component.properties.orthographicSize,
        DEFAULT_CAMERA_ORTHOGRAPHIC_SIZE,
      ),
      nearClip: camera.minZ,
      farClip: camera.maxZ,
    };
    applyAuthoredCameraLens(camera, this.previewLens, CAMERA_PREVIEW_ASPECT);
    this.previewCamera = camera;
    const rtt = new RenderTargetTexture(
      `debugCameraPreview:${actor.id}`,
      { width: CAMERA_PREVIEW_WIDTH, height: CAMERA_PREVIEW_HEIGHT },
      this.scene,
      false,
    );
    rtt.activeCamera = camera;
    rtt.renderList = this.scene.meshes.filter(
      (mesh) => !mesh.name.startsWith("debug"),
    );
    this.previewTexture = rtt;
    this.tick(this.now());
  }

  private buildLightDebug(actor: SerializedActor, component: SerializedComponent): void {
    if (component.classId === "AreaRectLightComponent") {
      const native = this.scene.getLightByName(`authoredAreaLight:${actor.id}:${component.id}`);
      if (!native?.parent || native.metadata?.areaLight?.error) return;
      const root = new TransformNode(`debugLight:${actor.id}`, this.scene);
      root.parent = native.parent;
      const { width, height } = parseAreaRectLightProperties(component.properties);
      const w = width / 2, h = height / 2;
      const corners = [new Vector3(-w, -h, 0), new Vector3(w, -h, 0), new Vector3(w, h, 0), new Vector3(-w, h, 0)];
      dashedLines(`debugLight:${actor.id}:rectangle`, [...corners, corners[0]!], this.scene, root);
      const distance = Math.min(2, Math.max(0.4, Math.min(width, height)));
      const tip = new Vector3(0, 0, -distance);
      dashedLines(`debugLight:${actor.id}:emission`, [Vector3.Zero(), tip], this.scene, root);
      dashedLines(`debugLight:${actor.id}:arrow`, [new Vector3(-distance * 0.15, 0, -distance * 0.75), tip, new Vector3(distance * 0.15, 0, -distance * 0.75)], this.scene, root);
      // Short parallel guides indicate the emitting side, never a cutoff/cone.
      corners.forEach((corner, index) => dashedLines(`debugLight:${actor.id}:side${index}`, [corner, corner.add(new Vector3(0, 0, -distance * 0.25))], this.scene, root));
      this.lightDebugKind = "area";
      this.lightDebugMesh = root;
      return;
    }
    const kind = String(component.properties.lightKind ?? "point") as LightDebugKind;
    const range = Math.max(0.1, asNumber(component.properties.range, 10));
    const origin = actorPosition(actor);
    const forward = actorForward(actor);
    const root = new TransformNode(`debugLight:${actor.id}`, this.scene);
    this.lightDebugKind = kind === "spot" || kind === "directional" ? kind : "point";
    if (this.lightDebugKind === "directional") {
      const tip = origin.add(forward.scale(2));
      dashedLines(`debugLight:${actor.id}:shaft`, [origin, tip], this.scene, root);
      const right = Vector3.Cross(forward, Vector3.Up());
      if (right.lengthSquared() < 1e-6) right.copyFrom(Vector3.Right());
      right.normalize();
      dashedLines(
        `debugLight:${actor.id}:head`,
        [tip.add(right.scale(-0.25)).add(forward.scale(-0.4)), tip, tip.add(right.scale(0.25)).add(forward.scale(-0.4))],
        this.scene,
        root,
      );
    } else if (this.lightDebugKind === "spot") {
      const angle = (asNumber(component.properties.outerAngle, 45) * Math.PI) / 180;
      const radius = Math.tan(angle / 2) * range;
      const base = origin.add(forward.scale(range));
      dashedLines(`debugLight:${actor.id}:axis`, [origin, base], this.scene, root);
      dashedLines(`debugLight:${actor.id}:ring`, ringPoints(base, forward, radius), this.scene, root);
      const rim = ringPoints(base, forward, radius, 4);
      for (let i = 0; i < 4; i++) {
        dashedLines(`debugLight:${actor.id}:edge${i}`, [origin, rim[i]!], this.scene, root);
      }
    } else {
      dashedLines(`debugLight:${actor.id}:eq`, ringPoints(origin, Vector3.Up(), range), this.scene, root);
      dashedLines(`debugLight:${actor.id}:mer`, ringPoints(origin, Vector3.Right(), range), this.scene, root);
      dashedLines(`debugLight:${actor.id}:mer2`, ringPoints(origin, Vector3.Forward(), range), this.scene, root);
    }
    this.lightDebugMesh = root;
  }

  private updateAudioDebugPoses(): void {
    for (const { root, actor, component } of this.audioDebug) {
      const visual = this.scene.getMeshByName(editorComponentMeshName(actor.id, component.id));
      const origin = this.scene.getMeshByName(editorMeshName(actor.id));
      if (visual) {
        visual.computeWorldMatrix(true);
        root.position.copyFrom(visual.getAbsolutePosition());
      } else if (origin) {
        origin.computeWorldMatrix(true);
        const local = component.transform?.position ?? [0, 0, 0];
        root.position.copyFrom(Vector3.TransformCoordinates(Vector3.FromArray(local), origin.getWorldMatrix()));
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
    this.audioDebug.push({ root, actor, component });
  }

  private updatePreviewCanvasVisibility(): void {
    const canvas = this.previewCanvas;
    if (!canvas) return;
    const active = this.previewTexture !== null;
    canvas.hidden = !active;
    canvas.dataset.active = active ? "true" : "false";
  }

  private async blitPreview(): Promise<void> {
    const canvas = this.previewCanvas;
    const texture = this.previewTexture;
    if (!canvas || !texture) return;
    try {
      const buffer = await texture.readPixels();
      if (!buffer || !canvas.getContext) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const { width, height } = texture.getSize();
      canvas.width = width;
      canvas.height = height;
      ctx.putImageData(
        new ImageData(flipReadPixelsRgba(buffer, width, height), width, height),
        0,
        0,
      );
    } catch {
      // NullEngine / missing GPU readback is fine — tests assert the RTT itself.
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
