/**
 * Test-build-only editor-host proof for the WebGPU viewport/preview
 * investigation. Records presented viewport frames plus live Scene internals
 * on the shared Engine; the e2e spec drives the real editor documents.
 */
import {
  Matrix,
  Mesh,
  Vector3,
  type AbstractEngine,
  type AbstractMesh,
  type Scene,
} from "@babylonjs/core";
import {
  PREVIEW_SKYBOX_MESH_NAME,
  type EngineHandle,
} from "@babylonslate/render";

export interface ViewportProofSamplePoint {
  /** Normalized canvas coordinate, 0..1 left→right / top→bottom. */
  x: number;
  y: number;
}

export interface ViewportProofOptions {
  /** Presented frames to record. Default 60. */
  frames?: number;
  /** Maximum wait for the requested frames. Default 20 s. */
  timeoutMs?: number;
  /** Background-only sample points; defaults to the two upper corners. */
  skyboxPoints?: ViewportProofSamplePoint[];
  /** Actor ids whose visual meshes are tracked for realization. */
  trackedActorIds?: string[];
}

interface TrackedMeshSnapshot {
  name: string;
  enabled: boolean;
  visible: boolean;
  visibility: number;
  materialName: string | null;
  materialClass: string | null;
  materialReady: boolean;
  cullingStrategy: number;
  inFrustum: boolean;
}

interface FrameSample {
  frame: number;
  atMs: number;
  /** RGBA at each requested skybox point. */
  skybox: number[][];
  /** Cheap hash over a coarse grid; changes expose flicker off the points. */
  gridHash: number;
  subjects: {
    actorId: string;
    /** Projected bounding-center pixel on the canvas, if computable. */
    screen: { x: number; y: number } | null;
    /** RGBA at the projected point, if inside the canvas. */
    pixel: number[] | null;
    meshes: TrackedMeshSnapshot[];
  }[];
}

export interface ViewportProofSubjectResult {
  actorId: string;
  /** First recorded frame with at least one realized visual mesh. */
  realizedAtFrame: number | null;
  /** First recorded frame where every tracked material reports ready. */
  materialsReadyAtFrame: number | null;
  /** Frames after realization where the visual disappeared again. */
  droppedAfterRealization: number;
  /** Frames after realization where the projected point looked like background. */
  backgroundPixelFrames: number;
  last: { screen: { x: number; y: number } | null; pixel: number[] | null; meshes: TrackedMeshSnapshot[] } | null;
}

export interface ViewportProofResult {
  backend: string;
  requestedFrames: number;
  presentedFrames: number;
  elapsedMs: number;
  timedOut: boolean;
  canvas: { width: number; height: number };
  skybox: {
    point: ViewportProofSamplePoint;
    /** Per-frame RGBA, aligned with `frames`. */
    pixels: number[][];
    /** Frames whose pixel differed from the previous frame beyond tolerance. */
    changes: number;
  }[];
  /** Frames whose coarse-grid hash differed from the previous frame. */
  gridChanges: number;
  subjects: ViewportProofSubjectResult[];
  /** Per-frame record for attachment-level inspection. */
  frames: FrameSample[];
  engineErrors: string[];
}

const PIXEL_TOLERANCE = 6;

function pixelsDiffer(a: number[] | null, b: number[] | null): boolean {
  if (!a || !b) return a !== b;
  return a.some((value, index) => Math.abs(value - b[index]!) > PIXEL_TOLERANCE);
}

function meshSnapshot(mesh: AbstractMesh, scene: Scene): TrackedMeshSnapshot {
  const material = mesh.material;
  let inFrustum = false;
  try {
    inFrustum =
      scene.frustumPlanes.length > 0 &&
      mesh.isInFrustum(scene.frustumPlanes);
  } catch {
    inFrustum = false;
  }
  let materialReady = false;
  try {
    materialReady = material ? material.isReady(mesh) : true;
  } catch {
    materialReady = false;
  }
  return {
    name: mesh.name,
    enabled: mesh.isEnabled(),
    visible: mesh.isVisible,
    visibility: mesh.visibility,
    materialName: material?.name ?? null,
    materialClass: material?.getClassName() ?? null,
    materialReady,
    cullingStrategy: mesh.cullingStrategy,
    inFrustum,
  };
}

function projectedCenter(
  mesh: AbstractMesh,
  scene: Scene,
  canvas: HTMLCanvasElement,
): { x: number; y: number } | null {
  const camera = scene.activeCamera;
  if (!camera) return null;
  mesh.computeWorldMatrix(true);
  const center = mesh.getBoundingInfo().boundingBox.centerWorld;
  const projected = Vector3.Project(
    center,
    // centerWorld is already world-space; Project applies world→view→screen.
    Matrix.Identity(),
    scene.getTransformMatrix(),
    camera.viewport.toGlobal(canvas.width, canvas.height),
  );
  if (!Number.isFinite(projected.x) || !Number.isFinite(projected.y))
    return null;
  return { x: projected.x, y: projected.y };
}

/**
 * Record presented frames on the viewport handle. Only frames that advance
 * the handle's own scheduler count — sibling scenes on the shared Engine also
 * fire `onEndFrameObservable`.
 */
export function recordViewportProof(
  handle: EngineHandle,
  canvas: HTMLCanvasElement,
  options: ViewportProofOptions = {},
): Promise<ViewportProofResult> {
  const requested = Math.min(600, Math.max(1, options.frames ?? 60));
  const timeoutMs = Math.min(60_000, Math.max(1_000, options.timeoutMs ?? 20_000));
  const skyboxPoints = options.skyboxPoints ?? [
    { x: 0.06, y: 0.06 },
    { x: 0.94, y: 0.06 },
  ];
  const trackedActorIds = options.trackedActorIds ?? [];
  const engine = handle.engine;
  const scene = handle.scene;
  const scratch = document.createElement("canvas");
  const started = performance.now();
  const frames: FrameSample[] = [];
  const engineErrors: string[] = [];

  return new Promise<ViewportProofResult>((resolve) => {
    let lastFrame = handle.scheduler.stats().renderedFrames;
    let finished = false;
    const finish = (timedOut: boolean) => {
      if (finished) return;
      finished = true;
      engine.onEndFrameObservable.remove(frameObserver);
      resolve(summarize(timedOut));
    };
    const summarize = (timedOut: boolean): ViewportProofResult => {
      const skybox = skyboxPoints.map((point, index) => {
        const pixels = frames.map((frame) => frame.skybox[index]!);
        let changes = 0;
        for (let i = 1; i < pixels.length; i++)
          if (pixelsDiffer(pixels[i]!, pixels[i - 1]!)) changes++;
        return { point, pixels, changes };
      });
      let gridChanges = 0;
      for (let i = 1; i < frames.length; i++)
        if (frames[i]!.gridHash !== frames[i - 1]!.gridHash) gridChanges++;
      const subjects = trackedActorIds.map((actorId) => {
        const series = frames.map(
          (frame) =>
            frame.subjects.find((subject) => subject.actorId === actorId)!,
        );
        const skyRef = frames.map((frame) => frame.skybox[0] ?? null);
        let realizedAtFrame: number | null = null;
        let materialsReadyAtFrame: number | null = null;
        let droppedAfterRealization = 0;
        let backgroundPixelFrames = 0;
        series.forEach((subject, index) => {
          const realized = subject.meshes.length > 0;
          if (realized && realizedAtFrame === null)
            realizedAtFrame = frames[index]!.frame;
          if (
            realized &&
            materialsReadyAtFrame === null &&
            subject.meshes.every((mesh) => mesh.materialReady)
          )
            materialsReadyAtFrame = frames[index]!.frame;
          if (realizedAtFrame !== null && !realized) droppedAfterRealization++;
          if (
            realized &&
            subject.pixel &&
            skyRef[index] &&
            !pixelsDiffer(subject.pixel, skyRef[index])
          )
            backgroundPixelFrames++;
        });
        return {
          actorId,
          realizedAtFrame,
          materialsReadyAtFrame,
          droppedAfterRealization,
          backgroundPixelFrames,
          last: series[series.length - 1] ?? null,
        };
      });
      return {
        backend: engine.isWebGPU ? "webgpu" : "webgl2",
        requestedFrames: requested,
        presentedFrames: frames.length,
        elapsedMs: performance.now() - started,
        timedOut,
        canvas: { width: canvas.width, height: canvas.height },
        skybox,
        gridChanges,
        subjects,
        frames,
        engineErrors,
      };
    };
    const sample = (frameNumber: number) => {
      if (
        canvas.width <= 0 ||
        canvas.height <= 0 ||
        !scratch.getContext("2d")
      )
        return;
      scratch.width = canvas.width;
      scratch.height = canvas.height;
      const ctx = scratch.getContext("2d")!;
      ctx.drawImage(canvas, 0, 0);
      const read = (point: ViewportProofSamplePoint) => {
        const x = Math.min(
          canvas.width - 1,
          Math.max(0, Math.round(point.x * (canvas.width - 1))),
        );
        const y = Math.min(
          canvas.height - 1,
          Math.max(0, Math.round(point.y * (canvas.height - 1))),
        );
        return [...ctx.getImageData(x, y, 1, 1).data];
      };
      const readPx = (x: number, y: number) => {
        const px = Math.min(canvas.width - 1, Math.max(0, Math.round(x)));
        const py = Math.min(canvas.height - 1, Math.max(0, Math.round(y)));
        return [...ctx.getImageData(px, py, 1, 1).data];
      };
      // Coarse 8×8 grid hash: catches flicker between the fixed points.
      let gridHash = 0;
      for (let gy = 0; gy < 8; gy++)
        for (let gx = 0; gx < 8; gx++) {
          const p = readPx(
            ((gx + 0.5) / 8) * (canvas.width - 1),
            ((gy + 0.5) / 8) * (canvas.height - 1),
          );
          gridHash = (gridHash * 31 + p[0]! + p[1]! * 3 + p[2]! * 7) >>> 0;
        }
      const sync = handle.editor?.sync;
      const subjects = trackedActorIds.map((actorId) => {
        const meshes = (sync?.visualMeshesForActor(actorId) ?? []).map(
          (mesh) => ({ mesh, snapshot: meshSnapshot(mesh, scene) }),
        );
        const screen =
          meshes.length > 0
            ? projectedCenter(meshes[0]!.mesh, scene, canvas)
            : null;
        return {
          actorId,
          screen,
          pixel:
            screen &&
            screen.x >= 0 &&
            screen.x < canvas.width &&
            screen.y >= 0 &&
            screen.y < canvas.height
              ? readPx(screen.x, screen.y)
              : null,
          meshes: meshes.map((entry) => entry.snapshot),
        };
      });
      frames.push({
        frame: frameNumber,
        atMs: performance.now() - started,
        skybox: skyboxPoints.map(read),
        gridHash,
        subjects,
      });
    };
    const frameObserver = engine.onEndFrameObservable.add(() => {
      if (finished) return;
      const frame = handle.scheduler.stats().renderedFrames;
      if (frame === lastFrame) return;
      lastFrame = frame;
      try {
        sample(frame);
      } catch (error) {
        if (engineErrors.length < 32)
          engineErrors.push(
            error instanceof Error ? error.message : String(error),
          );
      }
      if (frames.length >= requested) finish(false);
    });
    setTimeout(() => finish(true), timeoutMs);
  });
}

export interface EngineSceneDiagnostics {
  backend: string;
  scenes: {
    kind: "world" | "preview" | "other";
    cameras: string[];
    clearColor: number[];
    lightsEnabled: boolean;
    skyboxMesh: boolean;
    environmentTexture: boolean;
    meshCount: number;
    lights: {
      name: string;
      className: string;
      intensity: number;
      enabled: boolean;
      shadowGenerator: boolean;
    }[];
    shadowGeneratorCount: number;
    materials: {
      mesh: string;
      name: string;
      className: string;
      ready: boolean;
    }[];
  }[];
}

/**
 * Snapshot every Scene on the shared Engine: preview scenes (identified by
 * the shared `materialPreviewCamera`), the world scene, and other loaded
 * scenes such as the Prefab preview.
 */
export function collectEngineSceneDiagnostics(
  engine: AbstractEngine,
  worldScene: Scene | null,
): EngineSceneDiagnostics {
  return {
    backend: engine.isWebGPU ? "webgpu" : "webgl2",
    scenes: engine.scenes.map((scene) => {
      const cameras = scene.cameras.map((camera) => camera.name);
      const preview = cameras.includes("materialPreviewCamera");
      const lights = scene.lights.map((light) => {
        const shadowCapable = light as {
          getShadowGenerator?: () => unknown;
        };
        let shadowGenerator = false;
        try {
          shadowGenerator = shadowCapable.getShadowGenerator?.() != null;
        } catch {
          shadowGenerator = false;
        }
        return {
          name: light.name,
          className: light.getClassName(),
          intensity: light.intensity,
          enabled: light.isEnabled(),
          shadowGenerator,
        };
      });
      return {
        kind: preview ? "preview" : scene === worldScene ? "world" : "other",
        cameras,
        clearColor: [
          scene.clearColor.r,
          scene.clearColor.g,
          scene.clearColor.b,
          scene.clearColor.a,
        ],
        lightsEnabled: scene.lightsEnabled,
        skyboxMesh: scene.getMeshByName(PREVIEW_SKYBOX_MESH_NAME) !== null,
        environmentTexture: scene.environmentTexture !== null,
        meshCount: scene.meshes.length,
        lights,
        shadowGeneratorCount: lights.filter((light) => light.shadowGenerator)
          .length,
        materials: scene.meshes
          .filter((mesh): mesh is Mesh => mesh instanceof Mesh)
          .map((mesh) => {
            let ready = false;
            try {
              ready = mesh.material ? mesh.material.isReady(mesh) : true;
            } catch {
              ready = false;
            }
            return {
              mesh: mesh.name,
              name: mesh.material?.name ?? "",
              className: mesh.material?.getClassName() ?? "none",
              ready,
            };
          }),
      };
    }),
  };
}
