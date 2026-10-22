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
} from "@haptic/scripting";

/**
 * The Class pin's literal default (`default:class`), or BObject. Editor
 * hydrate passes a wired Class pin's constraint through the same key when it
 * builds pins, so Result typing and the default class never disagree.
 */
export function castDefaultClassId(
  properties: Record<string, unknown>,
): string {
  const keyed = properties["default:class"];
  return typeof keyed === "string" && keyed.trim() ? keyed.trim() : "BObject";
}

export function castResultPinType(
  properties: Record<string, unknown>,
): PinType {
  const classId = castDefaultClassId(properties);
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
  const success = ctx.output("success");
  const result = ctx.output("result");
  // Read the object once so the class test and Result see the same instance.
  ctx.emit(
    `{ const __o = ${ctx.input("object")}; ${success} = ctx.isA(__o, ${ctx.input("class")}); ${result} = ${success} ? __o : null; }`,
  );
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
    // Truncate toward zero without int32 wrapping; non-finite input is 0.
    codegen: (ctx) => ({
      out: `((v) => (Number.isFinite(v) ? Math.trunc(v) : 0))(${ctx.input("in")})`,
    }),
  },
  {
    id: "casting.cast",
    title: "Cast to BObject",
    category: "casting",
    pins: castPins,
    codegen: castCodegen,
  },
  ...createWildcardNodes(),
];
