import {
  pin,
  type NodeDefinition,
  FLOAT,
  QUAT,
  ROTATOR,
  VEC3,
} from "@babylonslate/scripting";

export const quatNodes: NodeDefinition[] = [
  {
    id: "quat.make",
    title: "Make Quaternion",
    category: "quaternion",
    pure: true,
    pins: () => [
      pin("x", "X", "in", FLOAT),
      pin("y", "Y", "in", FLOAT),
      pin("z", "Z", "in", FLOAT),
      pin("w", "W", "in", FLOAT),
      pin("out", "Out", "out", QUAT),
    ],
    codegen: (ctx) => ({
      out: `{ x: ${ctx.input("x")}, y: ${ctx.input("y")}, z: ${ctx.input("z")}, w: ${ctx.input("w")} }`,
    }),
  },
  {
    id: "quat.break",
    title: "Break Quaternion",
    category: "quaternion",
    pure: true,
    pins: () => [
      pin("in", "In", "in", QUAT),
      pin("x", "X", "out", FLOAT),
      pin("y", "Y", "out", FLOAT),
      pin("z", "Z", "out", FLOAT),
      pin("w", "W", "out", FLOAT),
    ],
    codegen: (ctx) => {
      const value = ctx.input("in");
      return {
        x: `(${value}).x`,
        y: `(${value}).y`,
        z: `(${value}).z`,
        w: `(${value}).w`,
      };
    },
  },
  {
    id: "quat.fromRotator",
    title: "Rotator To Quaternion",
    category: "quaternion",
    pure: true,
    pins: () => [
      pin("in", "In", "in", ROTATOR),
      pin("out", "Out", "out", QUAT),
    ],
    codegen: (ctx) => ({
      out: `ctx.rotatorToQuat(${ctx.input("in")})`,
    }),
  },
  {
    id: "quat.toRotator",
    title: "Quaternion To Rotator",
    category: "quaternion",
    pure: true,
    pins: () => [
      pin("in", "In", "in", QUAT),
      pin("out", "Out", "out", ROTATOR),
    ],
    codegen: (ctx) => ({
      out: `ctx.quatToRotator(${ctx.input("in")})`,
    }),
  },
  {
    id: "quat.multiply",
    title: "Multiply Quaternion",
    category: "quaternion",
    pure: true,
    pins: () => [
      pin("a", "A", "in", QUAT),
      pin("b", "B", "in", QUAT),
      pin("out", "Out", "out", QUAT),
    ],
    codegen: (ctx) => ({
      out: `ctx.multiplyQuats(${ctx.input("a")}, ${ctx.input("b")})`,
    }),
  },
  {
    id: "quat.inverse",
    title: "Inverse Quaternion",
    category: "quaternion",
    pure: true,
    pins: () => [
      pin("in", "In", "in", QUAT),
      pin("out", "Out", "out", QUAT),
    ],
    codegen: (ctx) => ({
      out: `ctx.inverseQuat(${ctx.input("in")})`,
    }),
  },
  {
    id: "quat.slerp",
    title: "Slerp Quaternion",
    category: "quaternion",
    pure: true,
    pins: () => [
      pin("a", "A", "in", QUAT),
      pin("b", "B", "in", QUAT),
      pin("alpha", "Alpha", "in", FLOAT),
      pin("out", "Out", "out", QUAT),
    ],
    codegen: (ctx) => ({
      out: `ctx.slerpQuats(${ctx.input("a")}, ${ctx.input("b")}, ${ctx.input("alpha")})`,
    }),
  },
  {
    id: "quat.rotateVector",
    title: "Rotate Vector",
    category: "quaternion",
    pure: true,
    pins: () => [
      pin("quat", "Quaternion", "in", QUAT),
      pin("vector", "Vector", "in", VEC3),
      pin("out", "Out", "out", VEC3),
    ],
    codegen: (ctx) => ({
      out: `ctx.quatRotateVector(${ctx.input("quat")}, ${ctx.input("vector")})`,
    }),
  },
  {
    id: "quat.normalize",
    title: "Normalize Quaternion",
    category: "quaternion",
    pure: true,
    pins: () => [
      pin("in", "In", "in", QUAT),
      pin("out", "Out", "out", QUAT),
    ],
    codegen: (ctx) => ({
      out: `ctx.normalizeQuat(${ctx.input("in")})`,
    }),
  },
];
