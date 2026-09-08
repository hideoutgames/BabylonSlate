import {
  assetRef,
  EXEC,
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

export const materialNodes: NodeDefinition[] = [
  setter("Float", FLOAT),
  setter("Color", VEC4),
  setter("Texture", assetRef("Texture")),
];
