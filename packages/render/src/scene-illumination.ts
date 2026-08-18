import {
  Camera,
  Color3,
  Color4,
  DirectionalLight,
  Matrix,
  PointLight,
  Quaternion,
  Scene,
  ShadowGenerator,
  SpotLight,
  UniversalCamera,
  Vector3,
  type Light,
} from "@babylonjs/core";
import "@babylonjs/core/Lights/Shadows/shadowGeneratorSceneComponent";
import type { SerializedActor, SerializedComponent, SerializedScene } from "@babylonslate/core";
import {
  DEFAULT_CAMERA_FIELD_OF_VIEW,
  DEFAULT_CAMERA_ORTHOGRAPHIC_SIZE,
  identitySerializedTransform,
} from "@babylonslate/core";
import { DEFAULT_LIGHT_INTENSITY } from "./viewport";
import type { MeshAssetContext } from "./mesh-assets";
import { isSkyboxMesh } from "./skybox";

export const AUTHORED_LIGHT_PREFIX = "authoredLight:";
export const AUTHORED_CAMERA_PREFIX = "authoredCamera:";
/** Unnamed hemispheric `"light"` intensity while any authored light exists. */
export const AUTHORED_FILL_LIGHT_INTENSITY = 0.15;

const EXTRA_CASTER_DIAGNOSTIC =
  "Only the first castShadows light owns a shadow map; extra casters are ignored.";
const SHADOW_2048_WARN =
  "shadowquality 2048 is expensive on the baseline device";

export type ShadowQualityLevel = "off" | "512" | "1024" | "2048";

export function shadowMapSizeFromQuality(level: string): number | null {
  if (level === "off") return null;
  if (level === "512") return 512;
  if (level === "2048") return 2048;
  return 1024;
}

export type AuthoredLightProperties = {
  color?: [number, number, number] | number[];
  intensity?: number;
  enabled?: boolean;
  range?: number;
  innerAngle?: number;
  outerAngle?: number;
  castShadows?: boolean;
};

export type AuthoredCameraProperties = {
  projectionMode?: "perspective" | "orthographic" | string;
  fieldOfView?: number;
  orthographicSize?: number;
  nearClip?: number;
  farClip?: number;
  isDefault?: boolean;
};

export type SyncIlluminationOptions = {
  stealActiveCamera?: boolean;
  restoreCamera?: Camera | null;
  applyClearColor?: boolean;
  shadowQuality?: string;
  assets?: MeshAssetContext;
  onDiagnostic?: (message: string) => void;
};

type AuthoredState = {
  lights: Map<string, Light>;
  cameras: Map<string, Camera>;
  lightKinds: Map<string, string>;
  shadow: ShadowGenerator | null;
  shadowOwnerId: string | null;
};

const stateByScene = new WeakMap<Scene, AuthoredState>();

function stateOf(scene: Scene): AuthoredState {
  let state = stateByScene.get(scene);
  if (!state) {
    state = {
      lights: new Map(),
      cameras: new Map(),
      lightKinds: new Map(),
      shadow: null,
      shadowOwnerId: null,
    };
    stateByScene.set(scene, state);
  }
  return state;
}

function asRgb(value: unknown): Color3 {
  if (Array.isArray(value) && value.length >= 3) {
    return new Color3(Number(value[0]) || 0, Number(value[1]) || 0, Number(value[2]) || 0);
  }
  return Color3.White();
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function degreesToRadians(degrees: unknown, fallback: number): number {
  return (asNumber(degrees, fallback) * Math.PI) / 180;
}

function actorPosition(actor: SerializedActor): Vector3 {
  const [x, y, z] = actor.transform.position;
  return new Vector3(x, y, z);
}

function actorRotation(actor: SerializedActor): Quaternion {
  const [x, y, z, w] = actor.transform.rotation;
  return new Quaternion(x, y, z, w);
}

export function composeActorComponentTransform(
  actor: SerializedActor,
  component: SerializedComponent | undefined,
): { position: Vector3; rotation: Quaternion } {
  const local = component?.transform ?? identitySerializedTransform();
  const parentPos = actorPosition(actor);
  const parentRot = actorRotation(actor);
  const [sx, sy, sz] = actor.transform.scale;
  const localPos = new Vector3(
    local.position[0] * sx,
    local.position[1] * sy,
    local.position[2] * sz,
  );
  const rotated = localPos.applyRotationQuaternion(parentRot);
  const [lx, ly, lz, lw] = local.rotation;
  return {
    position: parentPos.add(rotated),
    rotation: parentRot.multiply(new Quaternion(lx, ly, lz, lw)),
  };
}

export function actorForwardFromRotation(rotation: {
  x: number;
  y: number;
  z: number;
  w: number;
}): Vector3 {
  return Vector3.Forward().applyRotationQuaternion(
    new Quaternion(rotation.x, rotation.y, rotation.z, rotation.w),
  );
}

function lightKindOf(component: { properties: Record<string, unknown> }): string {
  const kind = String(component.properties.lightKind ?? "point");
  return kind === "directional" || kind === "spot" ? kind : "point";
}

export function applyAuthoredLightProperties(
  light: Light,
  properties: AuthoredLightProperties,
): void {
  light.intensity = asNumber(properties.intensity, 1);
  light.diffuse = asRgb(properties.color);
  light.setEnabled(properties.enabled !== false);
  const range = asNumber(properties.range, 10);
  if (light instanceof PointLight || light instanceof SpotLight) {
    light.range = range > 0 ? range : 10;
  }
  if (light instanceof SpotLight) {
    light.angle = degreesToRadians(properties.outerAngle, 45);
    light.innerAngle = degreesToRadians(properties.innerAngle, 30);
  }
}

export const CAMERA_LENS_FALLBACK_ASPECT = 16 / 9;

export function cameraRenderAspect(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return CAMERA_LENS_FALLBACK_ASPECT;
  }
  return width / height;
}

function lensPropertiesFromCamera(camera: Camera): AuthoredCameraProperties {
  return {
    projectionMode:
      camera.mode === Camera.ORTHOGRAPHIC_CAMERA ? "orthographic" : "perspective",
    fieldOfView: (camera.fov * 180) / Math.PI,
    orthographicSize: Math.abs(camera.orthoTop ?? DEFAULT_CAMERA_ORTHOGRAPHIC_SIZE),
    nearClip: camera.minZ,
    farClip: camera.maxZ,
  };
}

export function applyAuthoredCameraLens(
  camera: Camera,
  properties: AuthoredCameraProperties,
  aspect: number,
): void {
  camera.unfreezeProjectionMatrix();
  camera.minZ = asNumber(properties.nearClip, 0.1);
  camera.maxZ = Math.max(camera.minZ + 0.01, asNumber(properties.farClip, 1000));
  const fovDeg = asNumber(properties.fieldOfView, DEFAULT_CAMERA_FIELD_OF_VIEW);
  camera.fov = (fovDeg * Math.PI) / 180;
  const safeAspect =
    Number.isFinite(aspect) && aspect > 0 ? aspect : CAMERA_LENS_FALLBACK_ASPECT;
  const ortho = Math.max(
    asNumber(properties.orthographicSize, DEFAULT_CAMERA_ORTHOGRAPHIC_SIZE) ||
      DEFAULT_CAMERA_ORTHOGRAPHIC_SIZE,
    0.01,
  );
  if (properties.projectionMode === "orthographic") {
    camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
    camera.orthoTop = ortho;
    camera.orthoBottom = -ortho;
    camera.orthoLeft = -ortho * safeAspect;
    camera.orthoRight = ortho * safeAspect;
    return;
  }
  camera.mode = Camera.PERSPECTIVE_CAMERA;
  const projection = Matrix.Identity();
  Matrix.PerspectiveFovLHToRef(
    camera.fov,
    safeAspect,
    camera.minZ,
    camera.maxZ,
    projection,
  );
  camera.freezeProjectionMatrix(projection);
}

export function applyAuthoredCameraProperties(
  camera: Camera,
  properties: AuthoredCameraProperties,
): void {
  const engine = camera.getEngine();
  applyAuthoredCameraLens(
    camera,
    properties,
    cameraRenderAspect(engine.getRenderWidth(), engine.getRenderHeight()),
  );
}

export function refreshAuthoredCameraLenses(scene: Scene): void {
  const engine = scene.getEngine();
  const aspect = cameraRenderAspect(engine.getRenderWidth(), engine.getRenderHeight());
  const seen = new Set<Camera>();
  const state = stateByScene.get(scene);
  if (state) {
    for (const camera of state.cameras.values()) {
      seen.add(camera);
      applyAuthoredCameraLens(camera, lensPropertiesFromCamera(camera), aspect);
    }
  }
  for (const camera of scene.cameras) {
    if (seen.has(camera) || !camera.name.startsWith(AUTHORED_CAMERA_PREFIX)) {
      continue;
    }
    applyAuthoredCameraLens(camera, lensPropertiesFromCamera(camera), aspect);
  }
}

function detachCameraInputs(camera: UniversalCamera): void {
  camera.detachControl();
  camera.inputs.clear();
}

function createLight(
  scene: Scene,
  actor: SerializedActor,
  component: SerializedComponent,
  kind: string,
): Light {
  const name = `${AUTHORED_LIGHT_PREFIX}${actor.id}`;
  const composed = composeActorComponentTransform(actor, component);
  const direction = actorForwardFromRotation(composed.rotation);
  if (kind === "directional") {
    const light = new DirectionalLight(name, direction, scene);
    light.position.copyFrom(composed.position);
    return light;
  }
  if (kind === "spot") {
    return new SpotLight(
      name,
      composed.position,
      direction,
      Math.PI / 3,
      2,
      scene,
    );
  }
  return new PointLight(name, composed.position, scene);
}

function createCamera(
  scene: Scene,
  actor: SerializedActor,
  component: SerializedComponent,
): UniversalCamera {
  const composed = composeActorComponentTransform(actor, component);
  const camera = new UniversalCamera(
    `${AUTHORED_CAMERA_PREFIX}${actor.id}`,
    composed.position,
    scene,
  );
  camera.rotationQuaternion = composed.rotation;
  camera.rotation.set(0, 0, 0);
  detachCameraInputs(camera);
  return camera;
}

export function updateAuthoredLightTransform(
  light: Light,
  position: { x: number; y: number; z: number },
  rotation?: { x: number; y: number; z: number; w: number },
): void {
  if ("position" in light) {
    (light as PointLight).position.set(position.x, position.y, position.z);
  }
  if (rotation && (light instanceof DirectionalLight || light instanceof SpotLight)) {
    const direction = actorForwardFromRotation(rotation);
    light.direction.copyFrom(direction);
  }
}

export function updateAuthoredCameraTransform(
  camera: Camera,
  position: { x: number; y: number; z: number },
  rotation: { x: number; y: number; z: number; w: number },
): void {
  const gameCamera = camera as UniversalCamera;
  gameCamera.position.set(position.x, position.y, position.z);
  if (!gameCamera.rotationQuaternion) {
    gameCamera.rotationQuaternion = Quaternion.Identity();
  }
  gameCamera.rotationQuaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
  gameCamera.rotation.set(0, 0, 0);
}

function refreshShadowCasters(scene: Scene, generator: ShadowGenerator): void {
  for (const mesh of scene.meshes) {
    if (mesh.name.startsWith("__")) continue;
    if (isSkyboxMesh(mesh)) continue;
    generator.addShadowCaster(mesh, false);
    mesh.receiveShadows = true;
  }
}

export function attachSingleShadowGenerator(
  scene: Scene,
  light: Light,
  mapSize: number | null,
  existing: ShadowGenerator | null,
): ShadowGenerator | null {
  existing?.dispose();
  if (mapSize === null) return null;
  if (
    !(
      light instanceof DirectionalLight ||
      light instanceof PointLight ||
      light instanceof SpotLight
    )
  ) {
    return null;
  }
  const generator = new ShadowGenerator(mapSize, light);
  refreshShadowCasters(scene, generator);
  return generator;
}

export function syncDefaultFillLight(
  scene: Scene,
  hasAuthoredLights: boolean,
): void {
  const defaultLight = scene.getLightByName("light");
  if (!defaultLight) return;
  defaultLight.intensity = hasAuthoredLights
    ? AUTHORED_FILL_LIGHT_INTENSITY
    : DEFAULT_LIGHT_INTENSITY;
}

export function applySceneEnvironment(
  scene: Scene,
  sceneData: SerializedScene,
  options: { applyClearColor?: boolean; assets?: MeshAssetContext } = {},
): void {
  const settings = sceneData.settings;
  if (options.applyClearColor) {
    const [r, g, b] = settings.environmentColor;
    scene.clearColor = new Color4(r, g, b, 1);
  }
  if (settings.fogEnabled) {
    scene.fogMode = Scene.FOGMODE_LINEAR;
    scene.fogEnabled = true;
    scene.fogColor = asRgb(settings.fogColor);
    scene.fogStart = settings.fogStart;
    scene.fogEnd = settings.fogEnd;
  } else {
    scene.fogMode = Scene.FOGMODE_NONE;
    scene.fogEnabled = false;
  }
  const guid = settings.environmentTextureGuid;
  const bytes = guid ? options.assets?.textureBytes?.get(guid) : undefined;
  if (guid && bytes && options.assets?.resourceCache) {
    scene.environmentTexture = options.assets.resourceCache.getTexture(
      guid,
      scene.getEngine(),
      bytes,
      { isCube: true },
    );
  } else {
    scene.environmentTexture = null;
  }
}

function resolveDefaultCameraActorId(sceneData: SerializedScene): string | null {
  const actorId = sceneData.settings.mainCameraActorId;
  const componentId = sceneData.settings.mainCameraComponentId;
  if (!actorId || !componentId) return null;
  const actor = sceneData.actors.find((entry) => entry.id === actorId);
  const component = actor?.components.find(
    (entry) => entry.id === componentId && entry.classId === "CameraComponent",
  );
  return component ? actorId : null;
}

/**
 * Incrementally sync authored lights/cameras from the scene document.
 * Play callers pass `stealActiveCamera: true` so the named Default Camera
 * becomes `activeCamera` when it exists. Editor callers pass false (or the
 * Game Camera preview toggle) so the orbit camera stays in control.
 */
export function syncAuthoredIllumination(
  scene: Scene,
  sceneData: SerializedScene,
  options: SyncIlluminationOptions = {},
): void {
  const state = stateOf(scene);
  const previousActive = scene.activeCamera;
  applySceneEnvironment(scene, sceneData, {
    applyClearColor: options.applyClearColor,
    assets: options.assets,
  });

  const liveLights = new Set<string>();
  const liveCameras = new Set<string>();
  let authoredLight = false;
  const shadowCandidates: string[] = [];

  for (const actor of sceneData.actors) {
    const lightComponent = actor.components.find(
      (component) => component.classId === "LightComponent",
    );
    if (lightComponent) {
      authoredLight = true;
      liveLights.add(actor.id);
      const kind = lightKindOf(lightComponent);
      let light = state.lights.get(actor.id);
      if (light && state.lightKinds.get(actor.id) !== kind) {
        if (state.shadowOwnerId === actor.id) {
          state.shadow?.dispose();
          state.shadow = null;
          state.shadowOwnerId = null;
        }
        light.dispose();
        light = undefined;
      }
      if (!light) {
        light = createLight(scene, actor, lightComponent, kind);
        state.lights.set(actor.id, light);
        state.lightKinds.set(actor.id, kind);
      }
      applyAuthoredLightProperties(light, lightComponent.properties);
      {
        const composed = composeActorComponentTransform(actor, lightComponent);
        updateAuthoredLightTransform(
          light,
          {
            x: composed.position.x,
            y: composed.position.y,
            z: composed.position.z,
          },
          {
            x: composed.rotation.x,
            y: composed.rotation.y,
            z: composed.rotation.z,
            w: composed.rotation.w,
          },
        );
      }
      if (lightComponent.properties.castShadows === true) {
        shadowCandidates.push(actor.id);
      }
    }
    const cameraComponent = actor.components.find(
      (component) => component.classId === "CameraComponent",
    );
    if (cameraComponent) {
      liveCameras.add(actor.id);
      let camera = state.cameras.get(actor.id);
      if (!camera) {
        camera = createCamera(scene, actor, cameraComponent);
        state.cameras.set(actor.id, camera);
      }
      applyAuthoredCameraProperties(camera, cameraComponent.properties);
      {
        const composed = composeActorComponentTransform(actor, cameraComponent);
        updateAuthoredCameraTransform(
          camera,
          {
            x: composed.position.x,
            y: composed.position.y,
            z: composed.position.z,
          },
          {
            x: composed.rotation.x,
            y: composed.rotation.y,
            z: composed.rotation.z,
            w: composed.rotation.w,
          },
        );
      }
    }
  }

  for (const [actorId, light] of state.lights) {
    if (!liveLights.has(actorId)) {
      if (state.shadowOwnerId === actorId) {
        state.shadow?.dispose();
        state.shadow = null;
        state.shadowOwnerId = null;
      }
      light.dispose();
      state.lights.delete(actorId);
      state.lightKinds.delete(actorId);
    }
  }
  for (const [actorId, camera] of state.cameras) {
    if (!liveCameras.has(actorId)) {
      camera.dispose();
      state.cameras.delete(actorId);
    }
  }

  syncDefaultFillLight(scene, authoredLight);

  const mapSize = shadowMapSizeFromQuality(options.shadowQuality ?? "1024");
  const ownerId = shadowCandidates[0] ?? null;
  if (ownerId && mapSize !== null) {
    const owner = state.lights.get(ownerId);
    if (owner && (state.shadowOwnerId !== ownerId || !state.shadow)) {
      state.shadow = attachSingleShadowGenerator(scene, owner, mapSize, state.shadow);
      state.shadowOwnerId = ownerId;
    } else if (owner && state.shadow) {
      const current = state.shadow.getShadowMap()?.getSize().width;
      if (current !== mapSize) {
        state.shadow = attachSingleShadowGenerator(scene, owner, mapSize, state.shadow);
      } else {
        refreshShadowCasters(scene, state.shadow);
      }
    }
  } else if (state.shadow) {
    state.shadow.dispose();
    state.shadow = null;
    state.shadowOwnerId = null;
  }
  if (shadowCandidates.length > 1) {
    options.onDiagnostic?.(EXTRA_CASTER_DIAGNOSTIC);
  }
  if (options.shadowQuality === "2048") {
    options.onDiagnostic?.(SHADOW_2048_WARN);
  }

  const namedId = resolveDefaultCameraActorId(sceneData);
  const named = namedId ? state.cameras.get(namedId) : undefined;
  if (options.stealActiveCamera && named) {
    scene.activeCamera = named;
  } else if (options.restoreCamera) {
    scene.activeCamera = options.restoreCamera;
  } else if (previousActive) {
    scene.activeCamera = previousActive;
  }
}
