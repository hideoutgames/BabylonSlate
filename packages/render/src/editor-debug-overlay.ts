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
  type Scene,
} from "@babylonjs/core";
import {
  DEFAULT_CAMERA_FIELD_OF_VIEW,
  DEFAULT_CAMERA_ORTHOGRAPHIC_SIZE,
  identitySerializedTransform,
  type SerializedActor,
  type SerializedComponent,
  type SerializedScene,
} from "@babylonslate/core";
import {
  composeActorComponentTransform,
  applyAuthoredCameraLens,
  type AuthoredCameraProperties,
} from "./scene-illumination";
import { editorMeshName } from "./scene-loader";

export const CAMERA_PREVIEW_INTERVAL_MS = 1000;
export const CAMERA_PREVIEW_WIDTH = 320;
export const CAMERA_PREVIEW_HEIGHT = 180;
const CAMERA_PREVIEW_ASPECT = CAMERA_PREVIEW_WIDTH / CAMERA_PREVIEW_HEIGHT;

export type LightDebugKind = "point" | "spot" | "directional";

type OverlaySync = {
  sceneData: SerializedScene | null;
  selectedActorIds: readonly string[];
  selectedComponentIds?: readonly string[];
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
 * Editor-only frustum, light influence, and 1 Hz camera preview RTT.
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

  constructor(scene: Scene, options?: { now?: () => number }) {
    this.scene = scene;
    this.now = options?.now ?? (() => Date.now());
    this.useExternalClock = Boolean(options?.now);
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
    const light = selected.find((entry) => entry.component.classId === "LightComponent");
    if (camera) this.buildCameraDebug(camera.actor, camera.component);
    if (light) this.buildLightDebug(light.actor, light.component);
    this.updatePreviewCanvasVisibility();
    this.ensureTimer();
  }

  tick(nowMs?: number): void {
    if (!this.previewTexture || !this.previewCamera) return;
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
    this.previewTexture.render(false);
    this.previewRenderCount += 1;
    void this.blitPreview();
  }

  dispose(): void {
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
      const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer.buffer);
      const row = width * 4;
      const flipped = new Uint8ClampedArray(width * height * 4);
      for (let y = 0; y < height; y++) {
        const src = y * row;
        flipped.set(bytes.subarray(src, src + row), (height - 1 - y) * row);
      }
      ctx.putImageData(new ImageData(flipped, width, height), 0, 0);
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
