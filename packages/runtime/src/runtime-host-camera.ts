import type { CommandMessage } from "@haptic/bridge";
import { sameLayerCameraState, updateLayerCameraState } from "@haptic/core";
import { SceneLayer, type World } from "@haptic/object-model";
import type { RuntimeCamera } from "./runtime-camera";
import type { SceneLayers } from "./scene-layers";
import type { ScriptHostServices } from "./script-host-services";

interface CameraHostDeps {
  world(): World;
  layers: Pick<SceneLayers, "setCamera">;
  camera: Pick<RuntimeCamera, "cameraActor" | "cameraComponent">;
  /** The main Scene's Layer Camera Width × Height. */
  sceneCameraBounds(): { width: number; height: number };
  emit(command: CommandMessage): void;
}

/**
 * Script camera calls: the Scene Camera Manager and what it reports (the
 * camera actor and component in view), and Layer Camera writes for a Scene
 * Layer instance's camera or the main Scene's.
 */
export function createCameraHostBindings(deps: CameraHostDeps): Pick<ScriptHostServices,
  "setLayerCamera" | "getSceneCameraManager" | "getMainSceneCamera" | "getCameraActor" | "getCameraComponent"> {
  return {
    setLayerCamera: (camera, changes) => {
      if (camera.destroyed) return;
      if (camera.owner instanceof SceneLayer) {
        deps.layers.setCamera(camera.owner.guid, changes);
        return;
      }
      // A streamed or replaced Scene's camera draws nothing: only the main Scene's moves the view.
      if (camera.owner !== deps.world().currentScene) return;
      const next = updateLayerCameraState(camera.state, changes);
      if (sameLayerCameraState(next, camera.state)) return;
      camera.state = next;
      deps.emit({ type: "sceneCamera", camera: { ...next }, bounds: { ...deps.sceneCameraBounds() } });
    },
    getSceneCameraManager: () => deps.world().sceneCameraManager,
    getMainSceneCamera: () => deps.world().currentScene?.camera ?? null,
    getCameraActor: () => deps.camera.cameraActor(),
    getCameraComponent: () => deps.camera.cameraComponent(),
  };
}
