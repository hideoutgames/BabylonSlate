import {
  assetRef,
  EXEC,
  BOOL,
  FLOAT,
  objectRef,
  pin,
  STRING,
  VEC4,
  type NodeDefinition,
  type PinType,
} from "@babylonslate/scripting";

function setter(
  kind: "Float" | "Color" | "Texture",
  valueType: PinType,
): NodeDefinition {
  return {
    id: `material.set${kind}Parameter`,
    title: `Set Material ${kind} Parameter`,
    category: "material",
    pins: () => [
      pin("execIn", "Exec", "in", EXEC),
      pin("execOut", "Then", "out", EXEC),
      pin("material", "Material", "in", objectRef("MaterialObject")),
      { ...pin("name", "Name", "in", STRING), defaultValue: "" },
      pin("value", "Value", "in", valueType),
    ],
    codegen: (ctx) => {
      ctx.emit(
        `ctx.setMaterial${kind}Parameter(${ctx.input("Material")}, ${ctx.input("Name")}, ${ctx.input("Value")});`,
      );
    },
  };
}

function getter(
  kind: "Float" | "Color" | "Texture",
  valueType: PinType,
): NodeDefinition {
  return {
    id: `material.get${kind}Parameter`,
    title: `Get Material ${kind} Parameter`,
    category: "material",
    pure: true,
    pins: () => [
      pin("material", "Material", "in", objectRef("MaterialObject")),
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
function resetter(kind: "Float" | "Color" | "Texture"): NodeDefinition {
  return {
    id: `material.reset${kind}Parameter`,
    title: `Reset Material ${kind} Parameter`,
    category: "material",
    pins: () => [
      pin("execIn", "Exec", "in", EXEC),
      pin("execOut", "Then", "out", EXEC),
      pin("material", "Material", "in", objectRef("MaterialObject")),
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
      "Assigns a Material Instance to a mesh component and returns its Material Object. Instances share their root Material's shader, so switching never compiles.",
    category: "material",
    pins: () => [
      pin("execIn", "Exec", "in", EXEC),
      pin("execOut", "Then", "out", EXEC),
      pin("target", "Target", "in", objectRef("ActorComponent")),
      pin("instance", "Instance", "in", assetRef("MaterialInstance")),
      pin("material", "Material", "out", objectRef("MaterialObject")),
    ],
    codegen: (ctx) =>
      ctx.emit(
        `${ctx.output("Material")} = ctx.setMeshMaterial(${ctx.input("Target")}, ${ctx.input("Instance")});`,
      ),
  },
  {
    id: "material.getMaterialAsset",
    title: "Get Material Asset",
    description: "The Material or Material Instance asset a Material Object renders.",
    category: "material",
    pure: true,
    pins: () => [
      pin("material", "Material", "in", objectRef("MaterialObject")),
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
      pin("owner", "Owner", "in", objectRef("BObject")),
      { ...pin("entryId", "Entry ID", "in", STRING), defaultValue: "" },
      pin("material", "Material", "out", objectRef("MaterialObject")),
    ],
    codegen: (ctx) => ({
      Material: `ctx.getPostProcessEntry(${ctx.input("Owner")}, ${ctx.input("Entry ID")})`,
    }),
  },
  getter("Float", FLOAT),
  getter("Color", VEC4),
  getter("Texture", assetRef("Texture")),
  resetter("Float"),
  resetter("Color"),
  resetter("Texture"),
  setter("Float", FLOAT),
  setter("Color", VEC4),
  setter("Texture", assetRef("Texture")),
];
