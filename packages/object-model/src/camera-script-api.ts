import type { EngineClassScriptApi, EngineScriptPin, EngineScriptVariable } from "./engine-script-api";

const EXEC_IN: EngineScriptPin = { name: "exec", typeId: "exec", direction: "in" };
const EXEC_OUT: EngineScriptPin = { name: "then", typeId: "exec", direction: "out" };

/** Get Layer Camera on a Scene Layer or a Scene Layer Actor: that layer's own camera, never the Scene's. */
export const LAYER_CAMERA_VARIABLE: EngineScriptVariable = {
  name: "Layer Camera",
  typeId: "object",
  typeClassId: "LayerCamera",
  propertyKey: "layerCamera",
  getOnly: true,
};

/** A Scene's or Scene Layer instance's 2D camera: where it looks, its roll in degrees and its zoom. */
export const LAYER_CAMERA_SCRIPT_API: EngineClassScriptApi = {
  classId: "LayerCamera",
  variables: [
    { name: "Camera Location", typeId: "vec2", propertyKey: "location" },
    { name: "Camera Rotation", typeId: "float", propertyKey: "rotation" },
    { name: "Camera Zoom", typeId: "float", propertyKey: "zoom" },
  ],
  functions: [
    {
      name: "Add Camera Offset",
      runtime: "addLayerCameraOffset",
      description: "Moves the camera by Delta from where it is now.",
      searchAliases: ["pan camera", "layer camera offset"],
      pins: [EXEC_IN, EXEC_OUT, { name: "delta", typeId: "vec2", direction: "in" }],
    },
  ],
};

/**
 * The main Scene's view. Layer Camera is the Scene's own; Camera Actor and
 * Camera Component are what Possess Camera put in view, or None while the
 * Layer Camera is in view.
 */
export const SCENE_CAMERA_MANAGER_SCRIPT_API: EngineClassScriptApi = {
  classId: "SceneCameraManager",
  variables: [
    { ...LAYER_CAMERA_VARIABLE },
    { name: "Camera Actor", typeId: "object", typeClassId: "Actor", propertyKey: "cameraActor", getOnly: true },
    { name: "Camera Component", typeId: "object", typeClassId: "CameraComponent", propertyKey: "cameraComponent", getOnly: true },
  ],
};
