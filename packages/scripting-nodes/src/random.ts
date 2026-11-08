import {
  arrayOf,
  defaultValueLiteral,
  pin,
  structRef,
  type CodegenContext,
  type GraphPin,
  type NodeDefinition,
  BOOL,
  EXEC,
  FLOAT,
  INT,
  RESOLVING_WILDCARD,
  VEC3,
  ENGINE_SEED_STRUCT_ID,
} from "@haptic/scripting";
import { RANDOM_RANGE_NODES, rangePin } from "./curves-ranges";

/**
 * The Random group's nodes beyond Random Float, Int, Bool and … In Range (in `math.ts` and
 * `curves-ranges.ts`): the global seed, Get Step Count, the other draws, and a Seeded Random version of
 * every draw. A Seeded Random node takes its Seed by reference and advances the wired variable's Step by
 * the values it drew (`seededRandomDraw`).
 */

const SEED = structRef(ENGINE_SEED_STRUCT_ID);
const T = RESOLVING_WILDCARD;

/** One draw: its id and title after "Random", its inputs, its outputs and the `RandomDraw` it names. */
type DrawSpec = {
  id: string;
  title: string;
  description: string;
  inputs: GraphPin[];
  outputs: GraphPin[];
  /** Codegen of the draw's arguments after the draw name. */
  args: (ctx: CodegenContext) => string[];
  draw: string;
  /** Outputs read from the drawn value; one output takes the value itself. */
  read?: (value: string, ctx: CodegenContext) => Record<string, string>;
};

function outFallback(ctx: CodegenContext, pinId: string): string {
  const outPin = ctx.node.pins.find((entry) => entry.id === pinId);
  return defaultValueLiteral(outPin?.type ?? T);
}

const ARRAY_ITEM_READ = (value: string, ctx: CodegenContext) => ({
  item: `((d) => d.index < 0 ? ${outFallback(ctx, "item")} : d.item)(${value})`,
  index: `(${value}).index`,
});

const DRAWS: readonly DrawSpec[] = [
  {
    id: "Float", title: "Float", draw: "float",
    description: "Returns a random number from 0 up to, but not including, 1.",
    inputs: [], outputs: [pin("out", "Out", "out", FLOAT)], args: () => [],
  },
  {
    id: "Int", title: "Int", draw: "int",
    description: "Returns a random whole number between Min and Max, both included.",
    inputs: [pin("min", "Min", "in", INT), pin("max", "Max", "in", INT)],
    outputs: [pin("out", "Out", "out", INT)],
    args: (ctx) => [ctx.input("min"), ctx.input("max")],
  },
  {
    id: "Bool", title: "Bool", draw: "bool",
    description: "Returns true or false with equal chance.",
    inputs: [], outputs: [pin("out", "Out", "out", BOOL)], args: () => [],
  },
  {
    id: "BoolWithWeight", title: "Bool With Weight", draw: "boolWithWeight",
    description: "Returns true with the chance Weight, from 0 (never) to 1 (always).",
    inputs: [pin("weight", "Weight", "in", FLOAT, "data", false, 0.5)],
    outputs: [pin("out", "Out", "out", BOOL)],
    args: (ctx) => [ctx.input("weight")],
  },
  {
    id: "UnitVector", title: "Unit Vector", draw: "unitVector",
    description: "Returns a random direction of length 1.",
    inputs: [], outputs: [pin("out", "Out", "out", VEC3)], args: () => [],
  },
  ...RANDOM_RANGE_NODES.map((entry): DrawSpec => ({
    id: `${entry.id}InRange`, title: `${entry.title} In Range`, draw: `range:${entry.spec.kind}`,
    description: entry.spec.kind === "int"
      ? "Returns a random whole number from the range's Min to its Max."
      : "Returns a random value inside the range, with each axis drawn on its own.",
    inputs: [rangePin("range", "Range", entry.spec)],
    outputs: [pin("value", "Value", "out", entry.spec.type)],
    args: (ctx) => [ctx.input("range")],
  })),
  {
    id: "ArrayItem", title: "Array Item", draw: "arrayItem",
    description: "Returns a random item of the Array and its index; an empty Array returns no item at Index -1.",
    inputs: [pin("array", "Array", "in", arrayOf(T))],
    outputs: [pin("item", "Item", "out", T), pin("index", "Index", "out", INT)],
    args: (ctx) => [ctx.input("array")],
    read: ARRAY_ITEM_READ,
  },
];

/** Draws only the Seeded group had before: the plain ones that join Random Float, Int and Bool. */
const NEW_PLAIN_DRAWS = new Set(["BoolWithWeight", "UnitVector", "ArrayItem"]);

function drawOutputs(spec: DrawSpec, ctx: CodegenContext, call: string): Record<string, string> {
  // Item and Index of one Random Array Item share one draw.
  if (spec.read) return spec.read(ctx.shared?.(call) ?? call, ctx);
  return { [spec.outputs[0]!.id]: call };
}

function plainDrawNode(spec: DrawSpec): NodeDefinition {
  return {
    id: `random.${spec.id.charAt(0).toLowerCase()}${spec.id.slice(1)}`,
    title: `Random ${spec.title}`,
    category: "random",
    pure: true,
    description: spec.description,
    pins: () => [...spec.inputs, ...spec.outputs],
    codegen: (ctx) => drawOutputs(spec, ctx, `ctx.randomDraw(${[JSON.stringify(spec.draw), ...spec.args(ctx)].join(", ")})`),
  };
}

/** The Seed pin: by reference, so the node can move the wired variable on. */
function seedPin(): GraphPin {
  return { ...pin("seed", "Seed", "in", SEED), reference: "required" };
}

function seededCall(ctx: CodegenContext, draw: string, args: readonly string[]): string {
  const reference = ctx.reference ? ctx.reference("seed") : "null";
  return `ctx.seededRandomDraw(${[reference, ctx.input("seed"), JSON.stringify(draw), ...args].join(", ")})`;
}

function seededDrawNode(spec: DrawSpec): NodeDefinition {
  return {
    id: `random.seeded${spec.id}`,
    title: `Seeded Random ${spec.title}`,
    category: "random",
    pure: true,
    description: `${spec.description} Draws from Seed and moves its Step on.`,
    pins: () => [seedPin(), ...spec.inputs, ...spec.outputs],
    codegen: (ctx) => drawOutputs(spec, ctx, seededCall(ctx, spec.draw, spec.args(ctx))),
  };
}

const SHUFFLE_INPUT = (): GraphPin => pin("array", "Array", "in", arrayOf(T));
const SHUFFLE_OUTPUT = (): GraphPin => pin("out", "Out", "out", arrayOf(T));

export const randomNodes: NodeDefinition[] = [
  ...DRAWS.filter((spec) => NEW_PLAIN_DRAWS.has(spec.id)).map(plainDrawNode),
  {
    id: "random.shuffleArray",
    title: "Shuffle Array",
    category: "random",
    pure: true,
    description: "Returns the Array's items in a random order; the Array itself is unchanged.",
    pins: () => [SHUFFLE_INPUT(), SHUFFLE_OUTPUT()],
    codegen: (ctx) => ({ out: `ctx.randomDraw("shuffle", ${ctx.input("array")})` }),
  },
  ...DRAWS.map(seededDrawNode),
  {
    id: "random.seededShuffleArray",
    title: "Seeded Shuffle Array",
    category: "random",
    pure: true,
    description: "Returns the Array's items in a random order drawn from Seed, and moves its Step on.",
    pins: () => [seedPin(), SHUFFLE_INPUT(), SHUFFLE_OUTPUT()],
    codegen: (ctx) => ({ out: seededCall(ctx, "shuffle", [ctx.input("array")]) }),
  },
  {
    id: "random.setGlobalSeed",
    title: "Set Global Randomization Seed",
    category: "random",
    description: "The normal Random nodes continue from this Seed and its Step.",
    searchAliases: ["random seed", "seed", "randomize"],
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("seed", "Seed", "in", SEED),
    ],
    codegen: (ctx) => {
      ctx.emit(`ctx.setGlobalRandomSeed(${ctx.input("seed")});`);
    },
  },
  {
    id: "random.getGlobalSeed",
    title: "Get Global Randomization Seed",
    category: "random",
    pure: true,
    description: "Returns the global seed and, as its Step, how many values the normal Random nodes have drawn.",
    searchAliases: ["random seed", "seed"],
    pins: () => [pin("seed", "Seed", "out", SEED)],
    codegen: () => ({ seed: "ctx.getGlobalRandomSeed()" }),
  },
  {
    id: "random.getStepCount",
    title: "Get Step Count",
    category: "random",
    pure: true,
    description: "Returns how many values have been drawn from Seed.",
    pins: () => [pin("seed", "Seed", "in", SEED), pin("step", "Step Count", "out", INT)],
    codegen: (ctx) => ({ step: `ctx.randomSeedStep(${ctx.input("seed")})` }),
  },
];
