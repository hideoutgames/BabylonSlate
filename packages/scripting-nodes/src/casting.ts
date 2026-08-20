import {
  pin,
  type NodeDefinition,
  EXEC,
  FLOAT,
  INT,
  BOOL,
  objectRef,
  actorRef,
  classRef,
  type PinType,
  createWildcardNodes,
} from "@babylonslate/scripting";

function stringProp(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function castDefaultClassId(
  properties: Record<string, unknown>,
): string {
  const keyed = properties["default:class"];
  if (typeof keyed === "string" && keyed.trim()) return keyed.trim();
  return stringProp(properties.defaultClassId, "BObject");
}

export function castResultPinType(
  properties: Record<string, unknown>,
): PinType {
  const classId = stringProp(properties.defaultClassId, castDefaultClassId(properties));
  if (properties.resultKind === "actorRef") return actorRef(classId);
  if (properties.resultKind === "objectRef") return objectRef(classId);
  return classId === "Actor" ? actorRef(classId) : objectRef(classId);
}

function castPins(properties: Record<string, unknown>) {
  return [
    pin("execIn", "exec", "in", EXEC),
    pin("execOut", "then", "out", EXEC),
    pin("object", "object", "in", objectRef("BObject")),
    pin("class", "class", "in", classRef("BObject")),
    pin("success", "success", "out", BOOL),
    pin("result", "result", "out", castResultPinType(properties)),
  ];
}

function castCodegen(
  ctx: Parameters<NodeDefinition["codegen"]>[0],
): void {
  const input = ctx.input("object");
  const classId = ctx.input("class");
  const success = ctx.output("success");
  const result = ctx.output("result");
  ctx.emit(`${success} = ctx.isA(${input}, ${classId});`);
  ctx.emit(`${result} = (${success} ? ${input} : null);`);
}

export const castingNodes: NodeDefinition[] = [
  {
    id: "casting.intToFloat",
    title: "Int To Float",
    category: "casting",
    pure: true,
    pins: () => [
      pin("in", "in", "in", INT),
      pin("out", "out", "out", FLOAT),
    ],
    codegen: (ctx) => ({ out: `(${ctx.input("in")})` }),
  },
  {
    id: "casting.floatToInt",
    title: "Float To Int",
    category: "casting",
    pure: true,
    pins: () => [
      pin("in", "in", "in", FLOAT),
      pin("out", "out", "out", INT),
    ],
    codegen: (ctx) => ({ out: `(${ctx.input("in")} | 0)` }),
  },
  {
    id: "casting.cast",
    title: "Cast to BObject",
    category: "casting",
    pins: castPins,
    codegen: castCodegen,
  },
  {
    id: "casting.castActor",
    title: "Cast To Actor",
    category: "casting",
    pure: true,
    pins: () => [
      pin("in", "in", "in", objectRef("BObject")),
      pin("success", "success", "out", BOOL),
      pin("asActor", "asActor", "out", actorRef("Actor")),
    ],
    codegen: (ctx) => {
      const input = ctx.input("in");
      const ok = `ctx.isA(${input}, "Actor")`;
      return {
        success: ok,
        asActor: `(${ok} ? ${input} : null)`,
      };
    },
  },
  ...createWildcardNodes(),
];
