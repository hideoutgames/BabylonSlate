import {
  pin,
  type NodeDefinition,
  EXEC,
  FLOAT,
  BOOL,
  COLOR,
  actorRef,
  objectRef,
} from "@babylonslate/scripting";

const CAMERA = objectRef("CameraComponent");
const LIGHT = objectRef("LightComponent");
const ACTOR = actorRef("Actor");

export const illuminationNodes: NodeDefinition[] = [
  {
    id: "camera.possess",
    title: "Possess Camera",
    category: "camera",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("target", "target", "in", ACTOR),
    ],
    codegen: (ctx) => {
      ctx.emit(`ctx.possessCamera(${ctx.input("target")});`);
    },
  },
  {
    id: "camera.getFieldOfView",
    title: "Get Field Of View",
    category: "camera",
    pure: true,
    pins: () => [
      pin("target", "target", "in", CAMERA),
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
      pin("target", "target", "in", CAMERA),
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
      pin("target", "target", "in", CAMERA),
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
      pin("target", "target", "in", CAMERA),
      pin("size", "size", "in", FLOAT),
    ],
    codegen: (ctx) => {
      ctx.emit(
        `ctx.setCameraOrthographicSize(${ctx.input("target")}, ${ctx.input("size")});`,
      );
    },
  },
  {
    id: "light.setEnabled",
    title: "Set Light Enabled",
    category: "light",
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("target", "target", "in", LIGHT),
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
      pin("target", "target", "in", LIGHT),
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
      pin("target", "target", "in", LIGHT),
      pin("intensity", "intensity", "in", FLOAT),
    ],
    codegen: (ctx) => {
      ctx.emit(
        `ctx.setLightIntensity(${ctx.input("target")}, ${ctx.input("intensity")});`,
      );
    },
  },
];
