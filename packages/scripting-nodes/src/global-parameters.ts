import {
  BOOL,
  COLOR,
  EXEC,
  FLOAT,
  STRING,
  VEC3,
  assetRef,
  pin,
  type NodeDefinition,
  type PinType,
} from "@haptic/scripting";

/** Global Parameter Collection asset type, as the Collection pin picks it. */
const COLLECTION = assetRef("GlobalParameterCollection");

type GlobalParameterKind = "Float" | "Vector" | "Color";

const VALUES: Record<GlobalParameterKind, { type: PinType; defaultValue: unknown; reads: string }> = {
  Float: { type: FLOAT, defaultValue: 0, reads: "a Float parameter" },
  Vector: { type: VEC3, defaultValue: { x: 0, y: 0, z: 0 }, reads: "a Vector2 or Vector3 parameter; a Vector2 keeps X and Y" },
  Color: { type: COLOR, defaultValue: { x: 1, y: 1, z: 1, w: 1 }, reads: "a Color parameter" },
};

/** Collection, then Parameter: the name of one of its parameters (a dropdown once Collection is set). */
const targetPins = () => [
  pin("collection", "Collection", "in", COLLECTION),
  { ...pin("parameter", "Parameter", "in", STRING), defaultValue: "" },
];

function setter(kind: GlobalParameterKind): NodeDefinition {
  const value = VALUES[kind];
  return {
    id: `globalParameters.set${kind}Parameter`,
    title: `Set Global ${kind} Parameter`,
    category: "globalParameters",
    description: `Sets ${value.reads} of a Global Parameter Collection for the rest of Play. Every Material and Particle Graph that reads it follows at once. Not saved.`,
    searchAliases: ["global parameter", "parameter collection", `set global ${kind.toLowerCase()}`],
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      ...targetPins(),
      pin("value", "Value", "in", value.type, "data", true, value.defaultValue),
    ],
    codegen: (ctx) => {
      ctx.emit(`ctx.setGlobal${kind}Parameter(${ctx.input("collection")}, ${ctx.input("parameter")}, ${ctx.input("value")});`);
    },
  };
}

function getter(kind: GlobalParameterKind): NodeDefinition {
  return {
    id: `globalParameters.get${kind}Parameter`,
    title: `Get Global ${kind} Parameter`,
    category: "globalParameters",
    pure: true,
    description: `Returns ${VALUES[kind].reads} of a Global Parameter Collection: the value set this Play session, else its default.`,
    searchAliases: ["global parameter", "parameter collection", `get global ${kind.toLowerCase()}`],
    pins: () => [
      ...targetPins(),
      pin("value", "Value", "out", VALUES[kind].type),
      pin("found", "Found", "out", BOOL),
    ],
    codegen: (ctx) => {
      const read = `ctx.getGlobal${kind}Parameter(${ctx.input("collection")}, ${ctx.input("parameter")})`;
      return { value: `${read}.value`, found: `${read}.found` };
    },
  };
}

export const globalParameterNodes: NodeDefinition[] = [
  setter("Float"),
  setter("Vector"),
  setter("Color"),
  getter("Float"),
  getter("Vector"),
  getter("Color"),
];
