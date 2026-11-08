import {
  pin,
  type GraphPin,
  type NodeDefinition,
  BOOL,
  EXEC,
  FLOAT,
  VEC3,
  assetRef,
  objectRef,
  structRef,
  ENGINE_CAMERA_SHAKE_HANDLE_STRUCT_ID,
} from "@haptic/scripting";

const HANDLE = structRef(ENGINE_CAMERA_SHAKE_HANDLE_STRUCT_ID);
type Codegen = Parameters<NodeDefinition["codegen"]>[0];
const execPins = (): GraphPin[] => [pin("execIn", "exec", "in", EXEC), pin("execOut", "then", "out", EXEC)];
const shakePin = (): GraphPin => pin("shake", "Shake", "in", assetRef("CameraShake"));
const scalePin = (): GraphPin => pin("scale", "Scale", "in", FLOAT, "data", true, 1);
const handleIn = (): GraphPin => pin("handle", "Handle", "in", HANDLE);
const handleOut = (): GraphPin => pin("handle", "Handle", "out", HANDLE);

/** A Play node: `call` starts the shake and its result is the Handle. */
function playNode(id: string, title: string, description: string, inputs: () => GraphPin[], call: (ctx: Codegen) => string): NodeDefinition {
  return {
    id, title, category: "camera", description,
    searchAliases: ["camera shake", "shake", "screen shake"],
    pins: () => [...execPins(), ...inputs(), handleOut()],
    codegen: (ctx) => {
      ctx.emit(`${ctx.output("handle")} = ${call(ctx)};`);
    },
  };
}

/** An exec node on a playing shake. */
function handleAction(id: string, title: string, description: string, inputs: () => GraphPin[], call: (ctx: Codegen) => string): NodeDefinition {
  return {
    id, title, category: "camera", description,
    pins: () => [...execPins(), ...inputs()],
    codegen: (ctx) => {
      ctx.emit(`${call(ctx)};`);
    },
  };
}

/** A pure read of a shake by its handle. */
function handleRead(id: string, title: string, description: string, outId: string, outName: string, member: string): NodeDefinition {
  return {
    id, title, category: "camera", pure: true, description,
    pins: () => [handleIn(), pin(outId, outName, "out", BOOL)],
    codegen: (ctx) => ({ [outId]: `ctx.${member}(${ctx.input("handle")})` }),
  };
}

/** Camera Shake assets played on the main view, a Scene Layer's view, or from a point in the world. */
export const cameraShakeNodes: NodeDefinition[] = [
  playNode("camera.playShake", "Play Camera Shake",
    "Shakes the view with a Camera Shake asset, whichever camera is in view, times Scale. Returns a Handle for the other Camera Shake nodes.",
    () => [shakePin(), scalePin()],
    (ctx) => `ctx.playCameraShake(${ctx.input("shake")}, ${ctx.input("scale")})`),
  playNode("camera.playShakeOnSceneLayer", "Play Camera Shake On Scene Layer",
    "Shakes a Scene Layer's own view with a Camera Shake asset, times Scale. The shake ends when the Scene Layer is removed.",
    () => [pin("sceneLayer", "Scene Layer", "in", objectRef("SceneLayer")), shakePin(), scalePin()],
    (ctx) => `ctx.playCameraShakeOnSceneLayer(${ctx.input("sceneLayer")}, ${ctx.input("shake")}, ${ctx.input("scale")})`),
  playNode("camera.playWorldShake", "Play World Camera Shake",
    "Shakes the view with a Camera Shake asset at full strength within Inner Radius of Epicenter, fading to none at Outer Radius as the view moves.",
    () => [
      shakePin(),
      pin("epicenter", "Epicenter", "in", VEC3),
      pin("innerRadius", "Inner Radius", "in", FLOAT, "data", true, 0),
      pin("outerRadius", "Outer Radius", "in", FLOAT, "data", true, 10),
      pin("falloff", "Falloff", "in", FLOAT, "data", true, 1),
    ],
    (ctx) => `ctx.playWorldCameraShake(${ctx.input("shake")}, ${ctx.input("epicenter")}, ${ctx.input("innerRadius")}, ${ctx.input("outerRadius")}, ${ctx.input("falloff")})`),
  handleAction("camera.stopShake", "Stop Camera Shake",
    "Blends the shake out over its Blend Out Time, or stops it at once with Immediately.",
    () => [handleIn(), pin("immediately", "Immediately", "in", BOOL, "data", true, false)],
    (ctx) => `ctx.stopCameraShake(${ctx.input("handle")}, ${ctx.input("immediately")})`),
  handleAction("camera.stopAllShakes", "Stop All Camera Shakes",
    "Blends every playing camera shake out, or stops them at once with Immediately.",
    () => [pin("immediately", "Immediately", "in", BOOL, "data", true, false)],
    (ctx) => `ctx.stopAllCameraShakes(${ctx.input("immediately")})`),
  handleAction("camera.pauseShake", "Pause Camera Shake",
    "Holds the shake where it is, view included, until Resume Camera Shake.",
    () => [handleIn()],
    (ctx) => `ctx.setCameraShakePaused(${ctx.input("handle")}, true)`),
  handleAction("camera.resumeShake", "Resume Camera Shake",
    "Lets a paused shake play on from where it stopped.",
    () => [handleIn()],
    (ctx) => `ctx.setCameraShakePaused(${ctx.input("handle")}, false)`),
  handleAction("camera.setShakeScale", "Set Camera Shake Scale",
    "Changes how strongly the playing shake moves the view: 0 holds it still, 2 doubles it.",
    () => [handleIn(), scalePin()],
    (ctx) => `ctx.setCameraShakeScale(${ctx.input("handle")}, ${ctx.input("scale")})`),
  handleRead("camera.isShakePlaying", "Is Camera Shake Playing",
    "True from Play until the shake ends or is stopped, including while it is paused or blending out.", "playing", "Playing", "isCameraShakePlaying"),
  handleRead("camera.isShakePaused", "Is Camera Shake Paused",
    "True while the shake is paused.", "paused", "Paused", "isCameraShakePaused"),
];
