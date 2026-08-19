import {
  pin,
  type NodeDefinition,
  BOOL,
  COLOR,
  FLOAT,
  INT,
  ROTATOR,
  STRING,
  VEC2,
  VEC3,
  VEC4,
  classRef,
  type PinType,
} from "@babylonslate/scripting";

function makeLiteral(
  id: string,
  title: string,
  type: PinType,
): NodeDefinition {
  return {
    id,
    title,
    category: "literal",
    pure: true,
    pins: () => [
      pin("in", "In", "in", type),
      pin("out", "Out", "out", type),
    ],
    codegen: (ctx) => ({ out: ctx.input("in") }),
  };
}

function toStringNode(
  id: string,
  title: string,
  type: PinType,
): NodeDefinition {
  return {
    id,
    title,
    category: "literal",
    pure: true,
    pins: () => [
      pin("in", "In", "in", type),
      pin("out", "Out", "out", STRING),
    ],
    codegen: (ctx) => ({
      out: `ctx.formatValue(${ctx.input("in")})`,
    }),
  };
}

export const literalNodes: NodeDefinition[] = [
  makeLiteral("literal.makeBool", "Make Bool", BOOL),
  makeLiteral("literal.makeInt", "Make Int", INT),
  makeLiteral("literal.makeFloat", "Make Float", FLOAT),
  makeLiteral("literal.makeString", "Make String", STRING),
  makeLiteral("literal.makeClass", "Make Class", classRef("BObject")),
  toStringNode("literal.toStringBool", "To String (Bool)", BOOL),
  toStringNode("literal.toStringInt", "To String (Int)", INT),
  toStringNode("literal.toStringFloat", "To String (Float)", FLOAT),
  toStringNode("literal.toStringVec2", "To String (Vector 2)", VEC2),
  toStringNode("literal.toStringVec3", "To String (Vector 3)", VEC3),
  toStringNode("literal.toStringVec4", "To String (Vector 4)", VEC4),
  toStringNode("literal.toStringRotator", "To String (Rotator)", ROTATOR),
  toStringNode("literal.toStringColor", "To String (Color)", COLOR),
];
