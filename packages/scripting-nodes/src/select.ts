import {
  pin,
  type NodeDefinition,
  type PinType,
  BOOL,
  COLOR,
  FLOAT,
  INT,
  RESOLVING_WILDCARD,
  ROTATOR,
  STRING,
  TRANSFORM,
  VEC2,
  VEC3,
  VEC4,
  enumRef,
} from "@babylonslate/scripting";
import { enumGuidOf, enumMembersOf, titleCaseEnumMember } from "./enum";

export const SELECT_OPTION_PIN_PREFIX = "option:";

export function selectOptionPinId(memberName: string): string {
  return `${SELECT_OPTION_PIN_PREFIX}${encodeURIComponent(memberName)}`;
}

export function selectOptionMemberFromPinId(
  pinId: string,
): string | undefined {
  if (!pinId.startsWith(SELECT_OPTION_PIN_PREFIX)) return undefined;
  try {
    return decodeURIComponent(pinId.slice(SELECT_OPTION_PIN_PREFIX.length));
  } catch {
    return undefined;
  }
}

export function titleCaseSelectMember(name: string): string {
  return titleCaseEnumMember(name);
}

function typedSelect(
  id: string,
  title: string,
  type: PinType,
): NodeDefinition {
  return {
    id,
    title,
    category: "select",
    pure: true,
    pins: () => [
      pin("index", "Index", "in", BOOL),
      pin("false", "False", "in", type),
      pin("true", "True", "in", type),
      pin("out", "Out", "out", type),
    ],
    codegen: (ctx) => ({
      out: `((${ctx.input("index")}) ? (${ctx.input("true")}) : (${ctx.input("false")}))`,
    }),
  };
}

function enumSelectCodegen(ctx: {
  input: (pinName: string) => string;
  node: { properties: Record<string, unknown> };
}): Record<string, string> {
  const members = enumMembersOf(ctx.node.properties);
  if (members.length === 0) {
    return { out: "null" };
  }
  const index = ctx.input("index");
  let expr = ctx.input(selectOptionPinId(members[0]!.name));
  for (let i = members.length - 1; i >= 1; i -= 1) {
    const member = members[i]!;
    const option = ctx.input(selectOptionPinId(member.name));
    expr = `((${index}) === ${JSON.stringify(member.name)} ? (${option}) : (${expr}))`;
  }
  return { out: expr };
}

export const selectNodes: NodeDefinition[] = [
  {
    id: "select.bool",
    title: "Select Bool",
    category: "select",
    pure: true,
    pins: () => [
      pin("index", "Index", "in", BOOL),
      pin("false", "False", "in", BOOL),
      pin("true", "True", "in", BOOL),
      pin("out", "Out", "out", BOOL),
    ],
    codegen: (ctx) => ({
      out: `((${ctx.input("index")}) ? (${ctx.input("true")}) : (${ctx.input("false")}))`,
    }),
  },
  typedSelect("select.int", "Select Int", INT),
  typedSelect("select.float", "Select Float", FLOAT),
  typedSelect("select.string", "Select String", STRING),
  typedSelect("select.vec2", "Select Vector 2", VEC2),
  typedSelect("select.vec3", "Select Vector 3", VEC3),
  typedSelect("select.vec4", "Select Vector 4", VEC4),
  typedSelect("select.rotator", "Select Rotator", ROTATOR),
  typedSelect("select.transform", "Select Transform", TRANSFORM),
  typedSelect("select.color", "Select Color", COLOR),
  {
    id: "enum.select",
    title: "Select",
    category: "enum",
    pure: true,
    pins: (properties) => {
      const type = enumRef(enumGuidOf(properties));
      return [
        pin("index", "Index", "in", type),
        ...enumMembersOf(properties).map((member) =>
          pin(
            selectOptionPinId(member.name),
            titleCaseSelectMember(member.name),
            "in",
            RESOLVING_WILDCARD,
            "data",
            true,
          ),
        ),
        pin("out", "Out", "out", RESOLVING_WILDCARD),
      ];
    },
    codegen: (ctx) => enumSelectCodegen(ctx),
  },
];
