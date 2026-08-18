import {
  pin,
  pinTypeForMember,
  structRef,
  type NodeDefinition,
  type StructField,
  COLOR,
  FLOAT,
  ROTATOR,
  TRANSFORM,
  VEC3,
} from "@babylonslate/scripting";
import { objectLiteralKey } from "./member-pins";

export function structGuidOf(properties: Record<string, unknown>): string {
  return typeof properties.structGuid === "string" && properties.structGuid.trim()
    ? properties.structGuid.trim()
    : "";
}

export function structFieldsOf(
  properties: Record<string, unknown>,
): StructField[] {
  if (!Array.isArray(properties.fields)) return [];
  return properties.fields.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const field = row as StructField;
    if (typeof field.name !== "string" || !field.name) return [];
    return [
      {
        name: field.name,
        typeId: typeof field.typeId === "string" ? field.typeId : "float",
        ...(typeof field.typeClassId === "string" && field.typeClassId.trim()
          ? { typeClassId: field.typeClassId.trim() }
          : {}),
        ...(field.defaultValue !== undefined
          ? { defaultValue: field.defaultValue }
          : {}),
      },
    ];
  });
}

function fieldPins(
  fields: readonly StructField[],
  direction: "in" | "out",
) {
  return fields.map((field) =>
    pin(
      field.name,
      field.name,
      direction,
      pinTypeForMember(field.typeId, field.typeClassId),
    ),
  );
}

function makeStructLiteral(
  fields: readonly StructField[],
  input: (name: string) => string,
): string {
  if (fields.length === 0) return "{}";
  const parts = fields.map(
    (field) => `${objectLiteralKey(field.name)}: ${input(field.name)}`,
  );
  return `{ ${parts.join(", ")} }`;
}

function rotatorToQuatExpr(rotatorExpr: string): string {
  return `((r) => { const p = ((r)?.pitch ?? 0) * Math.PI / 180, y = ((r)?.yaw ?? 0) * Math.PI / 180, z = ((r)?.roll ?? 0) * Math.PI / 180; const c1 = Math.cos(p / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2), s1 = Math.sin(p / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2); return { x: s1 * c2 * c3 + c1 * s2 * s3, y: c1 * s2 * c3 - s1 * c2 * s3, z: c1 * c2 * s3 - s1 * s2 * c3, w: c1 * c2 * c3 + s1 * s2 * s3 }; })(${rotatorExpr})`;
}

function quatToRotatorExpr(quatExpr: string): string {
  return `((q) => { const qx = (q)?.x ?? 0, qy = (q)?.y ?? 0, qz = (q)?.z ?? 0, qw = (q)?.w ?? 1; const sinp = 2 * (qw * qx - qy * qz); const RAD = 180 / Math.PI; let x, y, z; if (Math.abs(sinp) < 0.9999999) { x = Math.asin(Math.min(1, Math.max(-1, sinp))); y = Math.atan2(2 * (qw * qy + qz * qx), 1 - 2 * (qx * qx + qy * qy)); z = Math.atan2(2 * (qw * qz + qx * qy), 1 - 2 * (qx * qx + qz * qz)); } else { x = Math.asin(Math.min(1, Math.max(-1, sinp))); y = Math.atan2(2 * (qy * qw - qz * qx), 1 - 2 * (qy * qy + qz * qz)); z = 0; } return { pitch: x * RAD, yaw: y * RAD, roll: z * RAD }; })(${quatExpr})`;
}

export const structNodes: NodeDefinition[] = [
  {
    id: "struct.make",
    title: "Make Structure",
    category: "struct",
    pure: true,
    pins: (properties) => [
      ...fieldPins(structFieldsOf(properties), "in"),
      pin("out", "out", "out", structRef(structGuidOf(properties))),
    ],
    codegen: (ctx) => ({
      out: makeStructLiteral(structFieldsOf(ctx.node.properties), (name) =>
        ctx.input(name),
      ),
    }),
  },
  {
    id: "struct.break",
    title: "Break Structure",
    category: "struct",
    pure: true,
    pins: (properties) => [
      pin("in", "in", "in", structRef(structGuidOf(properties))),
      ...fieldPins(structFieldsOf(properties), "out"),
    ],
    codegen: (ctx) => {
      const value = ctx.input("in");
      const out: Record<string, string> = {};
      for (const field of structFieldsOf(ctx.node.properties)) {
        out[field.name] = `(${value})[${JSON.stringify(field.name)}]`;
      }
      return out;
    },
  },
  {
    id: "struct.makeRotator",
    title: "Make Rotator",
    category: "struct",
    pure: true,
    pins: () => [
      pin("pitch", "pitch", "in", FLOAT),
      pin("yaw", "yaw", "in", FLOAT),
      pin("roll", "roll", "in", FLOAT),
      pin("out", "out", "out", ROTATOR),
    ],
    codegen: (ctx) => ({
      out: `{ pitch: ${ctx.input("pitch")}, yaw: ${ctx.input("yaw")}, roll: ${ctx.input("roll")} }`,
    }),
  },
  {
    id: "struct.breakRotator",
    title: "Break Rotator",
    category: "struct",
    pure: true,
    pins: () => [
      pin("in", "in", "in", ROTATOR),
      pin("pitch", "pitch", "out", FLOAT),
      pin("yaw", "yaw", "out", FLOAT),
      pin("roll", "roll", "out", FLOAT),
    ],
    codegen: (ctx) => {
      const v = ctx.input("in");
      return {
        pitch: `(${v}).pitch`,
        yaw: `(${v}).yaw`,
        roll: `(${v}).roll`,
      };
    },
  },
  {
    id: "struct.makeColor",
    title: "Make Color",
    category: "struct",
    pure: true,
    pins: () => [
      pin("r", "r", "in", FLOAT),
      pin("g", "g", "in", FLOAT),
      pin("b", "b", "in", FLOAT),
      pin("a", "a", "in", FLOAT),
      pin("out", "out", "out", COLOR),
    ],
    codegen: (ctx) => ({
      out: `{ x: ${ctx.input("r")}, y: ${ctx.input("g")}, z: ${ctx.input("b")}, w: ${ctx.input("a")} }`,
    }),
  },
  {
    id: "struct.breakColor",
    title: "Break Color",
    category: "struct",
    pure: true,
    pins: () => [
      pin("in", "in", "in", COLOR),
      pin("r", "r", "out", FLOAT),
      pin("g", "g", "out", FLOAT),
      pin("b", "b", "out", FLOAT),
      pin("a", "a", "out", FLOAT),
    ],
    codegen: (ctx) => {
      const v = ctx.input("in");
      return {
        r: `(${v}).x`,
        g: `(${v}).y`,
        b: `(${v}).z`,
        a: `(${v}).w`,
      };
    },
  },
  {
    id: "struct.makeTransform",
    title: "Make Transform",
    category: "struct",
    pure: true,
    pins: () => [
      pin("location", "location", "in", VEC3),
      pin("rotation", "rotation", "in", ROTATOR),
      pin("scale", "scale", "in", VEC3),
      pin("out", "out", "out", TRANSFORM),
    ],
    codegen: (ctx) => ({
      out: `{ position: ${ctx.input("location")}, rotation: ${rotatorToQuatExpr(ctx.input("rotation"))}, scale: ${ctx.input("scale")} }`,
    }),
  },
  {
    id: "struct.breakTransform",
    title: "Break Transform",
    category: "struct",
    pure: true,
    pins: () => [
      pin("in", "in", "in", TRANSFORM),
      pin("location", "location", "out", VEC3),
      pin("rotation", "rotation", "out", ROTATOR),
      pin("scale", "scale", "out", VEC3),
    ],
    codegen: (ctx) => {
      const t = ctx.input("in");
      return {
        location: `((${t})?.position ?? { x: 0, y: 0, z: 0 })`,
        rotation: quatToRotatorExpr(`((${t})?.rotation)`),
        scale: `((${t})?.scale ?? { x: 1, y: 1, z: 1 })`,
      };
    },
  },
];
