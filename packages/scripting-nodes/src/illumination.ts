import {
  pin,
  type NodeDefinition,
  EXEC,
  FLOAT,
  BOOL,
  COLOR,
  objectRef,
  enumRef,
  ENGINE_EASING_CURVE_ENUM_ID,
} from "@haptic/scripting";
import { subject } from "./self-pin";

const CAMERA = objectRef("CameraComponent");
const LIGHT = objectRef("LightComponent");

export const illuminationNodes: NodeDefinition[] = [
  {
    id: "camera.possess",
    title: "Possess Camera",
    category: "camera",
    description: "Views the Scene through Target's first Camera component. None, or an actor without a Camera component, returns the view to the Scene's Layer Camera.",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      // Self while unwired; a wired None reaches the runtime instead of being skipped as a missing subject.
      { ...pin("target", "target", "in", objectRef("Actor"), "data", true), selfWhenUnwired: true },
    ],
    codegen: (ctx) => {
      ctx.emit(`ctx.possessCamera(${ctx.input("target")});`);
    },
  },
  {
    id: "camera.possessWithBlend",
    title: "Possess Camera With Blend",
    category: "camera",
    description: "Views the Scene through Target's first Camera component, easing the view from where it is over Blend Time seconds along Blend Function. Blend Time 0 cuts at once, as Possess Camera does.",
    searchAliases: ["blend camera", "camera transition", "view target", "set view target with blend", "possess camera"],
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      { ...pin("target", "target", "in", objectRef("Actor"), "data", true), selfWhenUnwired: true },
      pin("blendTime", "Blend Time", "in", FLOAT, "data", true, 1),
      pin("blendFunction", "Blend Function", "in", enumRef(ENGINE_EASING_CURVE_ENUM_ID), "data", true, "linear"),
    ],
    codegen: (ctx) => {
      ctx.emit(`ctx.possessCameraWithBlend(${ctx.input("target")}, ${ctx.input("blendTime")}, ${ctx.input("blendFunction")});`);
    },
  },
  {
    id: "camera.getSceneCameraManager",
    title: "Get Scene Camera Manager",
    category: "camera",
    pure: true,
    description: "The Scene's camera view: its Layer Camera, and the Camera Actor and Camera Component in view (None while the Layer Camera is in view).",
    pins: () => [pin("out", "Scene Camera Manager", "out", objectRef("SceneCameraManager"))],
    codegen: () => ({ out: "ctx.getSceneCameraManager()" }),
  },
  {
    id: "camera.getFieldOfView",
    title: "Get Field Of View",
    category: "camera",
    pure: true,
    pins: () => [
      subject(pin("target", "target", "in", CAMERA)),
      pin("out", "fov", "out", FLOAT),
    ],
    codegen: (ctx) => ({
      out: `ctx.getCameraFieldOfView(${ctx.input("target")})`,
    }),
  },
  {
    id: "camera.setFieldOfView",
    title: "Set Field Of View",
    category: "camera",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      subject(pin("target", "target", "in", CAMERA)),
      pin("fov", "fov", "in", FLOAT),
    ],
    codegen: (ctx) => {
      ctx.emit(
        `ctx.setCameraFieldOfView(${ctx.input("target")}, ${ctx.input("fov")});`,
      );
    },
  },
  {
    id: "camera.getOrthographicSize",
    title: "Get Orthographic Size",
    category: "camera",
    pure: true,
    pins: () => [
      subject(pin("target", "target", "in", CAMERA)),
      pin("out", "size", "out", FLOAT),
    ],
    codegen: (ctx) => ({
      out: `ctx.getCameraOrthographicSize(${ctx.input("target")})`,
    }),
  },
  {
    id: "camera.setOrthographicSize",
    title: "Set Orthographic Size",
    category: "camera",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      subject(pin("target", "target", "in", CAMERA)),
      pin("size", "size", "in", FLOAT),
    ],
    codegen: (ctx) => {
      ctx.emit(
        `ctx.setCameraOrthographicSize(${ctx.input("target")}, ${ctx.input("size")});`,
      );
    },
  },
  {
    id: "light.getEnabled",
    title: "Is Light Enabled",
    category: "light",
    pure: true,
    pins: () => [
      subject(pin("target", "Target", "in", LIGHT)),
      pin("out", "Enabled", "out", BOOL),
    ],
    codegen: (ctx) => ({ out: `ctx.isLightEnabled(${ctx.input("target")})` }),
  },
  {
    id: "light.getColor",
    title: "Get Light Color",
    category: "light",
    pure: true,
    pins: () => [
      subject(pin("target", "Target", "in", LIGHT)),
      pin("out", "Color", "out", COLOR),
    ],
    codegen: (ctx) => ({ out: `ctx.getLightColor(${ctx.input("target")})` }),
  },
  {
    id: "light.getIntensity",
    title: "Get Light Intensity",
    category: "light",
    pure: true,
    pins: () => [
      subject(pin("target", "Target", "in", LIGHT)),
      pin("out", "Intensity", "out", FLOAT),
    ],
    codegen: (ctx) => ({ out: `ctx.getLightIntensity(${ctx.input("target")})` }),
  },
  {
    id: "light.setEnabled",
    title: "Set Light Enabled",
    category: "light",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      subject(pin("target", "target", "in", LIGHT)),
      pin("enabled", "enabled", "in", BOOL),
    ],
    codegen: (ctx) => {
      ctx.emit(
        `ctx.setLightEnabled(${ctx.input("target")}, ${ctx.input("enabled")});`,
      );
    },
  },
  {
    id: "light.setColor",
    title: "Set Light Color",
    category: "light",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      subject(pin("target", "target", "in", LIGHT)),
      pin("color", "color", "in", COLOR),
    ],
    codegen: (ctx) => {
      ctx.emit(
        `ctx.setLightColor(${ctx.input("target")}, ${ctx.input("color")});`,
      );
    },
  },
  {
    id: "light.setIntensity",
    title: "Set Light Intensity",
    category: "light",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      subject(pin("target", "target", "in", LIGHT)),
      pin("intensity", "intensity", "in", FLOAT),
    ],
    codegen: (ctx) => {
      ctx.emit(
        `ctx.setLightIntensity(${ctx.input("target")}, ${ctx.input("intensity")});`,
      );
    },
  },
];
