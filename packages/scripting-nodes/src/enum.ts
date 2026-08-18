import {
  pin,
  type EnumMember,
  type NodeDefinition,
  BOOL,
  EXEC,
  STRING,
  enumRef,
} from "@babylonslate/scripting";

export function enumGuidOf(properties: Record<string, unknown>): string {
  return typeof properties.enumGuid === "string" && properties.enumGuid.trim()
    ? properties.enumGuid.trim()
    : "";
}

export function enumMembersOf(
  properties: Record<string, unknown>,
): EnumMember[] {
  if (!Array.isArray(properties.members)) return [];
  return properties.members.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const member = row as { name?: unknown; value?: unknown };
    if (typeof member.name !== "string" || !member.name) return [];
    return [
      {
        name: member.name,
        value: typeof member.value === "number" ? member.value : 0,
      },
    ];
  });
}

export function enumValueOf(properties: Record<string, unknown>): string {
  if (typeof properties.value === "string" && properties.value) {
    return properties.value;
  }
  return enumMembersOf(properties)[0]?.name ?? "";
}

function typedEnum(properties: Record<string, unknown>) {
  return enumRef(enumGuidOf(properties));
}

export const ENUM_SWITCH_CASE_PREFIX = "case:";

export function enumSwitchCasePinId(memberName: string): string {
  return `${ENUM_SWITCH_CASE_PREFIX}${memberName}`;
}

export function enumSwitchMemberNameFromPinId(pinId: string): string | undefined {
  return pinId.startsWith(ENUM_SWITCH_CASE_PREFIX)
    ? pinId.slice(ENUM_SWITCH_CASE_PREFIX.length)
    : undefined;
}

/** Display name for a Switch exec pin. Runtime values stay the member name. */
export function titleCaseEnumMember(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return name;
  return trimmed
    .replace(/[._-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export const enumNodes: NodeDefinition[] = [
  {
    id: "enum.make",
    title: "Make Enum",
    category: "enum",
    pure: true,
    pins: (properties) => [
      pin("out", "out", "out", typedEnum(properties)),
    ],
    codegen: (ctx) => ({
      out: JSON.stringify(enumValueOf(ctx.node.properties)),
    }),
  },
  {
    id: "enum.equals",
    title: "Equal Enum",
    category: "enum",
    pure: true,
    pins: (properties) => {
      const type = typedEnum(properties);
      return [
        pin("a", "a", "in", type),
        pin("b", "b", "in", type),
        pin("out", "out", "out", BOOL),
      ];
    },
    codegen: (ctx) => ({
      out: `(${ctx.input("a")} === ${ctx.input("b")})`,
    }),
  },
  {
    id: "enum.notEquals",
    title: "Not Equal Enum",
    category: "enum",
    pure: true,
    pins: (properties) => {
      const type = typedEnum(properties);
      return [
        pin("a", "a", "in", type),
        pin("b", "b", "in", type),
        pin("out", "out", "out", BOOL),
      ];
    },
    codegen: (ctx) => ({
      out: `(${ctx.input("a")} !== ${ctx.input("b")})`,
    }),
  },
  {
    id: "enum.toString",
    title: "Enum to String",
    category: "enum",
    pure: true,
    pins: (properties) => [
      pin("in", "in", "in", typedEnum(properties)),
      pin("out", "out", "out", STRING),
    ],
    codegen: (ctx) => ({
      out: `String(${ctx.input("in")})`,
    }),
  },
  {
    id: "enum.switch",
    title: "Switch on Enum",
    category: "enum",
    pins: (properties) => [
      pin("execIn", "exec", "in", EXEC),
      pin("value", "value", "in", typedEnum(properties)),
      ...enumMembersOf(properties).map((member) =>
        pin(
          enumSwitchCasePinId(member.name),
          titleCaseEnumMember(member.name),
          "out",
          EXEC,
        ),
      ),
      pin("default", "Default", "out", EXEC),
    ],
    codegen: () => {
      /* handled specially by compiler */
    },
  },
];
