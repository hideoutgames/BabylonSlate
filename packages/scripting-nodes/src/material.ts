import {
  assetRef,
  EXEC,
  BOOL,
  COLOR,
  FLOAT,
  objectRef,
  pin,
  STRING,
  VEC2,
  VEC3,
  VEC4,
  type NodeDefinition,
  type PinType,
} from "@haptic/scripting";
import { subject } from "./self-pin";

type MaterialParameterKind = "Float" | "Vector2" | "Vector3" | "Vector4" | "Color" | "Texture";

/**
 * One node of each action per parameter type, each with the exact pin type: a vector node sets only a parameter of its
 * own width, and a Color node takes a Color, whose RGB the Material converts from sRGB to linear (a Vector4 is passed raw).
 */
const PARAMETER_KINDS: ReadonlyArray<readonly [MaterialParameterKind, PinType]> = [
  ["Float", FLOAT], ["Vector2", VEC2], ["Vector3", VEC3], ["Vector4", VEC4], ["Color", COLOR], ["Texture", assetRef("Texture")],
];

function setter(
  kind: MaterialParameterKind,
  valueType: PinType,
): NodeDefinition {
  return {
    id: `material.set${kind}Parameter`,
    title: `Set Material ${kind} Parameter`,
    category: "material",
    ...(kind === "Texture" ? { latent: true } : {}),
    pins: () => [
      pin("execIn", "Exec", "in", EXEC),
      pin("execOut", "Then", "out", EXEC),
      subject(pin("material", "Material", "in", objectRef("MaterialObject"))),
      { ...pin("name", "Name", "in", STRING), defaultValue: "" },
      pin("value", "Value", "in", valueType),
    ],
    codegen: (ctx) => {
      ctx.emit(
        `${kind === "Texture" ? "yield " : ""}ctx.setMaterial${kind}Parameter${kind === "Texture" ? "Async" : ""}(${ctx.input("Material")}, ${ctx.input("Name")}, ${ctx.input("Value")});`,
      );
    },
  };
}

function getter(
  kind: MaterialParameterKind,
  valueType: PinType,
): NodeDefinition {
  return {
    id: `material.get${kind}Parameter`,
    title: `Get Material ${kind} Parameter`,
    category: "material",
    pure: true,
    pins: () => [
      subject(pin("material", "Material", "in", objectRef("MaterialObject"))),
      { ...pin("name", "Name", "in", STRING), defaultValue: "" },
      pin("value", "Value", "out", valueType),
      pin("found", "Found", "out", BOOL),
    ],
    codegen: (ctx) => {
      const read = `ctx.getMaterial${kind}Parameter(${ctx.input("Material")}, ${ctx.input("Name")})`;
      return { Value: `${read}.value`, Found: `${read}.found` };
    },
  };
}
function resetter(kind: MaterialParameterKind): NodeDefinition {
  return {
    id: `material.reset${kind}Parameter`,
    title: `Reset Material ${kind} Parameter`,
    category: "material",
    pins: () => [
      pin("execIn", "Exec", "in", EXEC),
      pin("execOut", "Then", "out", EXEC),
      subject(pin("material", "Material", "in", objectRef("MaterialObject"))),
      { ...pin("name", "Name", "in", STRING), defaultValue: "" },
      pin("success", "Success", "out", BOOL),
    ],
    codegen: (ctx) =>
      ctx.emit(
        `${ctx.output("Success")} = ctx.resetMaterial${kind}Parameter(${ctx.input("Material")}, ${ctx.input("Name")});`,
      ),
  };
}

export const materialNodes: NodeDefinition[] = [
  {
    id: "material.setMaterialInstance",
    title: "Set Material Instance",
    description:
      "Prepares a Material Instance and assigns it to a mesh component. The existing material remains valid until the replacement is ready.",
    category: "material",
    latent: true,
    pins: () => [
      pin("execIn", "Exec", "in", EXEC),
      pin("execOut", "Then", "out", EXEC),
      subject(pin("target", "Target", "in", objectRef("ActorComponent"))),
      pin("instance", "Instance", "in", assetRef("MaterialInstance")),
      pin("material", "Material", "out", objectRef("MaterialObject")),
    ],
    codegen: (ctx) =>
      ctx.emit(
        `${ctx.output("Material")} = (yield ctx.setMeshMaterialAsync(${ctx.input("Target")}, ${ctx.input("Instance")}));`,
      ),
  },
  {
    id: "material.getMaterialAsset",
    title: "Get Material Asset",
    description: "The Material or Material Instance asset a Material Object renders.",
    category: "material",
    pure: true,
    pins: () => [
      subject(pin("material", "Material", "in", objectRef("MaterialObject"))),
      pin("asset", "Asset", "out", assetRef("Material")),
    ],
    codegen: (ctx) => ({
      Asset: `ctx.getMaterialAsset(${ctx.input("Material")})`,
    }),
  },
  {
    id: "material.getPostProcessEntry",
    title: "Get Post Process Entry",
    category: "material",
    pure: true,
    pins: () => [
      subject(pin("owner", "Owner", "in", objectRef("Object"))),
      { ...pin("entryId", "Entry ID", "in", STRING), defaultValue: "" },
      pin("material", "Material", "out", objectRef("MaterialObject")),
    ],
    codegen: (ctx) => ({
      Material: `ctx.getPostProcessEntry(${ctx.input("Owner")}, ${ctx.input("Entry ID")})`,
    }),
  },
  ...PARAMETER_KINDS.map(([kind, type]) => getter(kind, type)),
  ...PARAMETER_KINDS.map(([kind]) => resetter(kind)),
  ...PARAMETER_KINDS.map(([kind, type]) => setter(kind, type)),
];
