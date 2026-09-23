import {
  CascadedShadowGenerator,
  DirectionalLight,
  NullEngine,
  PointLight,
  ShadowGenerator,
  SpotLight,
  Vector3,
  type AbstractMesh,
  type Matrix,
  type Scene,
} from "@babylonjs/core";
import type { GpuBackend } from "@babylonslate/core";
import { engineAdapterInfo } from "./render-diagnostics";
import { sceneRenderingSettings } from "./render-settings";
import { sceneRenderPathStatus } from "./scene-render-path";
import { findSceneShadowController } from "./shadow-controller";

/** Caller-supplied provenance is deliberately not inferred from an adapter name. */
export interface ShadowDiagnosticOptions {
  buildSha?: string;
  host?: string;
  os?: string;
  requestedBackend?: GpuBackend;
  backendFallbackReason?: string;
  /** Project convention, when known; an unspecified world unit is not a meter. */
  sceneUnits?: string;
  /** Explicit model selection; the capture never scans the entire scene geometry. */
  meshes?: readonly AbstractMesh[];
  /** May lower, but never raise, the 32-light / 256-mesh capture limits. */
  maxLights?: number;
  maxMeshes?: number;
}

const finite = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const vector = (value: Vector3 | null | undefined) =>
  value ? [finite(value.x), finite(value.y), finite(value.z)] : null;
const matrix = (value: Matrix | null | undefined) =>
  value ? Array.from(value.asArray(), finite) : null;
const text = (value: string | undefined) => value?.slice(0, 512) ?? null;
const limit = (value: number | undefined, maximum: number) =>
  value !== undefined && Number.isFinite(value)
    ? Math.min(maximum, Math.max(0, Math.floor(value)))
    : maximum;

/** Reads an already-produced matrix without asking Babylon to update projection. */
function orthographicExtents(projection: Matrix | null, halfZ: boolean) {
  if (!projection) return null;
  const m = projection.m;
  if (m[15] !== 1 || m[3] !== 0 || m[7] !== 0 || m[11] !== 0) return null;
  if (!m[0] || !m[5] || !m[10]) return null;
  const x0 = (-1 - m[12]) / m[0];
  const x1 = (1 - m[12]) / m[0];
  const y0 = (-1 - m[13]) / m[5];
  const y1 = (1 - m[13]) / m[5];
  const z0 = ((halfZ ? 0 : -1) - m[14]) / m[10];
  const z1 = (1 - m[14]) / m[10];
  return {
    min: [
      finite(Math.min(x0, x1)),
      finite(Math.min(y0, y1)),
      finite(Math.min(z0, z1)),
    ],
    max: [
      finite(Math.max(x0, x1)),
      finite(Math.max(y0, y1)),
      finite(Math.max(z0, z1)),
    ],
    width: finite(Math.abs(x1 - x0)),
    height: finite(Math.abs(y1 - y0)),
    depth: finite(Math.abs(z1 - z0)),
  };
}

function filterName(generator: ShadowGenerator) {
  if (generator.usePercentageCloserFiltering) return "pcf";
  if (generator.useContactHardeningShadow) return "pcss";
  if (generator.usePoissonSampling) return "poisson";
  if (generator.filter === ShadowGenerator.FILTER_NONE) return "none";
  return `native-${generator.filter}`;
}

/**
 * Opt-in, bounded CPU snapshot. Call after the relevant view's shadow draw.
 * Never logs, reads pixels, installs observers, creates an owner or recalculates
 * shadow matrices. Missing provenance/projection is null, not qualification proof.
 */
export function captureShadowDiagnostics(
  scene: Scene,
  options: ShadowDiagnosticOptions = {},
) {
  const engine = scene.getEngine();
  const controller = findSceneShadowController(scene);
  const state = sceneRenderingSettings(scene);
  const pipeline = sceneRenderPathStatus(scene);
  const camera = scene.activeCamera;
  const canvas = engine.getRenderingCanvas();
  const renderSize = camera?.outputRenderTarget?.getSize();
  const lights = scene.lights.slice(0, limit(options.maxLights, 32));
  const statuses = controller?.diagnostics(lights) ?? [];
  const selectedMeshes = options.meshes ?? [];
  const meshes = selectedMeshes.slice(0, limit(options.maxMeshes, 256));
  return {
    version: 1,
    provenance: {
      buildSha: text(options.buildSha),
      host: text(options.host),
      os: text(options.os),
      sceneUnits: text(options.sceneUnits),
      renderId: scene.getRenderId(),
      capturedAfterViewDraw: "caller-responsibility",
    },
    backend: {
      requested: options.requestedBackend ?? pipeline.requested.gpuBackend,
      actual:
        engine instanceof NullEngine
          ? "null"
          : engine.isWebGPU
            ? "webgpu"
            : (engine as { webGLVersion?: number }).webGLVersion === 1
              ? "webgl1"
              : "webgl2",
      fallbackReason: text(options.backendFallbackReason),
      adapter: engineAdapterInfo(engine),
      ndcHalfZRange: engine.isNDCHalfZRange,
      reverseDepthBuffer: engine.useReverseDepthBuffer,
    },
    surfaceMode: state.mode,
    pipeline: {
      requested: { ...pipeline.requested },
      effective: { ...pipeline.effective },
      limits: pipeline.limits.slice(0, 32).map((value) => value.slice(0, 512)),
    },
    viewport: {
      cssWidth: finite(canvas?.clientWidth),
      cssHeight: finite(canvas?.clientHeight),
      devicePixelRatio:
        typeof devicePixelRatio === "number" ? finite(devicePixelRatio) : null,
      renderWidth: renderSize?.width ?? engine.getRenderWidth(),
      renderHeight: renderSize?.height ?? engine.getRenderHeight(),
      scalingLevel: engine.getHardwareScalingLevel(),
      cameraViewport: camera
        ? {
            x: camera.viewport.x,
            y: camera.viewport.y,
            width: camera.viewport.width,
            height: camera.viewport.height,
          }
        : null,
    },
    camera: camera
      ? {
          id: text(camera.id),
          name: text(camera.name),
          mode: camera.mode === 1 ? "orthographic" : "perspective",
          position: vector(camera.globalPosition),
          near: finite(camera.minZ),
          far: finite(camera.maxZ),
          fov: finite(camera.fov),
          ortho: {
            left: finite(camera.orthoLeft),
            right: finite(camera.orthoRight),
            top: finite(camera.orthoTop),
            bottom: finite(camera.orthoBottom),
          },
          worldMatrix: matrix(camera.getWorldMatrix()),
          view: matrix(scene.getViewMatrix()),
          projection: matrix(scene.getProjectionMatrix()),
          viewProjection: matrix(scene.getTransformMatrix()),
        }
      : null,
    requestedShadows: { ...state.shadows },
    lights: lights.map((light, index) => {
      const generator = controller?.generator(light);
      const map = generator?.getShadowMap();
      const dimensions = map?.getSize();
      const shadowLight =
        light instanceof DirectionalLight ||
        light instanceof PointLight ||
        light instanceof SpotLight
          ? light
          : null;
      const parentMatrix = light.parent?.getWorldMatrix();
      const direction =
        shadowLight && !(shadowLight instanceof PointLight)
          ? shadowLight.direction
          : null;
      const position = shadowLight?.position;
      const requestedMapSize =
        light instanceof DirectionalLight
          ? state.shadows.mapSize
          : state.shadows.localMapSize;
      const cascades =
        generator instanceof CascadedShadowGenerator
          ? generator.numCascades
          : 1;
      return {
        id: text(light.id),
        name: text(light.name),
        type: light.getClassName(),
        requested: controller?.requestsShadow(light) ?? false,
        status: statuses[index] ? { ...statuses[index] } : null,
        worldPosition: vector(
          position && parentMatrix
            ? Vector3.TransformCoordinates(position, parentMatrix)
            : position,
        ),
        worldDirection: vector(
          direction && parentMatrix
            ? Vector3.TransformNormal(direction, parentMatrix).normalize()
            : direction?.normalizeToNew(),
        ),
        parentWorldMatrix: matrix(parentMatrix),
        requestedMapSize,
        allocationDownsized: dimensions
          ? dimensions.width < requestedMapSize
          : null,
        generator: generator
          ? {
              type: generator.getClassName(),
              cameraId: text((generator.camera ?? camera)?.id),
              map: dimensions
                ? {
                    id: map!.uniqueId,
                    width: dimensions.width,
                    height: dimensions.height,
                    cube: map!.isCube,
                    anisotropy: map!.anisotropicFilteringLevel,
                  }
                : null,
              cascades,
              filter: filterName(generator),
              filteringQuality: generator.filteringQuality,
              autoBias: state.shadows.autoBias,
              // For CSM these scalars may be restored after drawing; never label
              // them as the value that was used by every cascade.
              currentBias: {
                depth: finite(generator.bias),
                normalWorld: finite(generator.normalBias),
              },
              lastDrawBias:
                controller
                  ?.effectiveBias(light)
                  .map((entry) => ({ ...entry })) ?? [],
              depthTexture:
                generator.usePercentageCloserFiltering ||
                generator.useContactHardeningShadow,
              cubeDistanceDepth: shadowLight?.needCube() ?? false,
              nativeDepthMin:
                camera && shadowLight
                  ? finite(shadowLight.getDepthMinZ(camera))
                  : null,
              nativeDepthMax:
                camera && shadowLight
                  ? finite(shadowLight.getDepthMaxZ(camera))
                  : null,
              projections: Array.from(
                { length: Math.min(cascades, 4) },
                (_, layer) => {
                  const projection =
                    generator instanceof CascadedShadowGenerator
                      ? generator.getCascadeProjectionMatrix(layer)
                      : generator.projectionMatrix;
                  return {
                    layer,
                    scope: map?.isCube ? "last-rendered-cube-face" : "layer",
                    matrix: matrix(projection),
                    view: matrix(
                      generator instanceof CascadedShadowGenerator
                        ? generator.getCascadeViewMatrix(layer)
                        : generator.viewMatrix,
                    ),
                    orthographicExtents: orthographicExtents(
                      projection,
                      engine.isNDCHalfZRange,
                    ),
                  };
                },
              ),
            }
          : null,
      };
    }),
    models: meshes.map((mesh) => {
      const bounds = mesh.getBoundingInfo().boundingBox;
      return {
        id: text(mesh.id),
        name: text(mesh.name),
        worldBounds: {
          min: vector(bounds.minimumWorld),
          max: vector(bounds.maximumWorld),
        },
        worldMatrix: matrix(mesh.getWorldMatrix()),
        receiveShadows: mesh.receiveShadows,
      };
    }),
    truncated: {
      lights: Math.max(0, scene.lights.length - lights.length),
      meshes: Math.max(0, selectedMeshes.length - meshes.length),
    },
  };
}

export type ShadowDiagnostics = ReturnType<typeof captureShadowDiagnostics>;
