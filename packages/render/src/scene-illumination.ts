import {
  Color3,
  DirectionalLight,
  FreeCamera,
  PointLight,
  Quaternion,
  SpotLight,
  Vector3,
  type Camera,
  type Light,
  type Scene,
} from "@babylonjs/core";
import type { SerializedActor, SerializedScene } from "@babylonslate/core";
import { DEFAULT_LIGHT_INTENSITY } from "./viewport";

export const AUTHORED_LIGHT_PREFIX = "authoredLight:";
export const AUTHORED_CAMERA_PREFIX = "authoredCamera:";

function asRgb(value: unknown): Color3 {
  if (Array.isArray(value) && value.length >= 3) {
    return new Color3(Number(value[0]) || 0, Number(value[1]) || 0, Number(value[2]) || 0);
  }
  return Color3.White();
}

function actorPosition(actor: SerializedActor): Vector3 {
  const [x, y, z] = actor.transform.position;
  return new Vector3(x, y, z);
}

function disposeAuthoredIllumination(scene: Scene): void {
  for (const light of [...scene.lights]) {
    if (light.name.startsWith(AUTHORED_LIGHT_PREFIX)) light.dispose();
  }
  for (const camera of [...scene.cameras]) {
    if (camera.name.startsWith(AUTHORED_CAMERA_PREFIX)) camera.dispose();
  }
}

function createAuthoredLight(
  scene: Scene,
  actor: SerializedActor,
  component: SerializedActor["components"][number],
): Light {
  const kind = String(component.properties.lightKind ?? "point");
  const name = `${AUTHORED_LIGHT_PREFIX}${actor.id}`;
  const position = actorPosition(actor);
  let light: Light;
  if (kind === "directional") {
    light = new DirectionalLight(name, new Vector3(0, -1, 0), scene);
  } else if (kind === "spot") {
    light = new SpotLight(
      name,
      position,
      new Vector3(0, -1, 0),
      Math.PI / 3,
      2,
      scene,
    );
  } else {
    light = new PointLight(name, position, scene);
  }
  light.intensity = Number(component.properties.intensity ?? 1);
  light.diffuse = asRgb(component.properties.color);
  if ("position" in light) {
    (light as PointLight).position.copyFrom(position);
  }
  const range = Number(component.properties.range ?? 10);
  if (light instanceof PointLight || light instanceof SpotLight) {
    light.range = Number.isFinite(range) && range > 0 ? range : 10;
  }
  if (light instanceof SpotLight) {
    const degrees = Number(component.properties.outerAngle ?? 45);
    light.angle = ((Number.isFinite(degrees) ? degrees : 45) * Math.PI) / 180;
  }
  return light;
}

function createAuthoredCamera(
  scene: Scene,
  actor: SerializedActor,
  component: SerializedActor["components"][number],
): Camera {
  const name = `${AUTHORED_CAMERA_PREFIX}${actor.id}`;
  const position = actorPosition(actor);
  const camera = new FreeCamera(name, position, scene);
  camera.minZ = 0.1;
  camera.maxZ = 1000;
  const [rx, ry, rz, rw] = actor.transform.rotation;
  camera.rotationQuaternion = new Quaternion(rx, ry, rz, rw);
  const fovDeg = Number(component.properties.fieldOfView ?? 60);
  camera.fov = ((Number.isFinite(fovDeg) ? fovDeg : 60) * Math.PI) / 180;
  const ortho = Number(component.properties.orthographicSize ?? 0);
  if (ortho > 0) {
    camera.mode = 1;
    camera.orthoTop = ortho;
    camera.orthoBottom = -ortho;
    camera.orthoLeft = -ortho * (16 / 9);
    camera.orthoRight = ortho * (16 / 9);
  }
  return camera;
}

/**
 * Rebuild authored lights/cameras from the scene document. When a camera is
 * present it becomes `activeCamera` (Play). Editor callers pass
 * `stealActiveCamera: false` so the orbit camera stays in control.
 */
export function syncAuthoredIllumination(
  scene: Scene,
  sceneData: SerializedScene,
  options: { stealActiveCamera?: boolean } = {},
): void {
  disposeAuthoredIllumination(scene);
  let authoredLight = false;
  let firstCamera: Camera | null = null;
  for (const actor of sceneData.actors) {
    const lightComponent = actor.components.find(
      (component) => component.classId === "LightComponent",
    );
    if (lightComponent) {
      createAuthoredLight(scene, actor, lightComponent);
      authoredLight = true;
    }
    const cameraComponent = actor.components.find(
      (component) => component.classId === "CameraComponent",
    );
    if (cameraComponent) {
      const camera = createAuthoredCamera(scene, actor, cameraComponent);
      firstCamera ??= camera;
    }
  }
  const defaultLight = scene.getLightByName("light");
  if (defaultLight) {
    defaultLight.intensity = authoredLight ? 0.15 : DEFAULT_LIGHT_INTENSITY;
  }
  if (options.stealActiveCamera !== false && firstCamera) {
    scene.activeCamera = firstCamera;
  }
}

export function updateAuthoredLightTransform(
  light: Light,
  position: { x: number; y: number; z: number },
): void {
  if ("position" in light) {
    (light as PointLight).position.set(position.x, position.y, position.z);
  }
}
