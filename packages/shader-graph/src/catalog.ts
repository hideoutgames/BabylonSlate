import type { MaterialValueType } from "./types";

/** Surface shades a mesh; post-process shades a camera pass; particle shades GPUParticleSystem quads. */
export type MaterialDomain = "surface" | "postProcess" | "particle";

export function parseMaterialDomain(value: unknown): MaterialDomain {
  if (value === "postProcess" || value === "particle") {
    return value;
  }
  return "surface";
}

export type MaterialStage = "vertex" | "fragment";

/**
 * Device features a node needs. The render backend maps these onto engine caps
 * so an unsupported node reports a diagnostic instead of emitting bad source.
 */
export type MaterialCapability =
  | "derivatives"
  | "textureLod"
  | "sceneDepth"
  | "sceneNormal"
  | "vertexTexture"
  | "customGlsl";

export type MaterialPinType =
  | { kind: MaterialValueType }
  | { kind: "generic"; group?: string };

export interface MaterialPinDefinition {
  id: string;
  /** Title Case display name (`.cursor/rules/display-names.mdc`). */
  name: string;
  type: MaterialPinType;
  /** Literal used when nothing is wired in. Length matches the resolved type. */
  defaultValue?: number[];
  /** Required inputs raise `material.missingInput` when unwired and undefaulted. */
  required?: boolean;
  /** Renders the pin with a color swatch and color picker in Details. */
  colorHint?: boolean;
}

export interface MaterialNodeDefinition {
  type: string;
  title: string;
  category: string;
  /** Legal domains. Undefined means the node works in every domain. */
  domains?: readonly MaterialDomain[];
  /** Legal stages. Undefined means the node works in both. */
  stages?: readonly MaterialStage[];
  requires?: readonly MaterialCapability[];
  inputs: readonly MaterialPinDefinition[];
  outputs: readonly MaterialPinDefinition[];
  /** Relative ALU weight used by cost classification, not a time estimate. */
  cost: number;
  /** Texture fetches contributed by one instance of this node. */
  samples?: number;
  /** Terminal node for its domain. */
  terminal?: MaterialDomain;
}

const GENERIC: MaterialPinType = { kind: "generic" };
const FLOAT: MaterialPinType = { kind: "float" };
const VEC2: MaterialPinType = { kind: "vec2" };
const VEC3: MaterialPinType = { kind: "vec3" };
const VEC4: MaterialPinType = { kind: "vec4" };
const TEXTURE: MaterialPinType = { kind: "texture" };

function generic(
  type: string,
  title: string,
  category: string,
  inputs: readonly string[],
  cost = 1,
): MaterialNodeDefinition {
  return {
    type,
    title,
    category,
    cost,
    inputs: inputs.map((id, index) => ({
      id,
      name: titleCasePin(id),
      type: GENERIC,
      defaultValue: index === 0 ? [0] : [0],
    })),
    outputs: [{ id: "out", name: "Out", type: GENERIC }],
  };
}

function unaryGeneric(
  type: string,
  title: string,
  category = "Math",
  cost = 1,
): MaterialNodeDefinition {
  return generic(type, title, category, ["value"], cost);
}

function titleCasePin(id: string): string {
  const spaced = id.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const CONSTANT_NODES: MaterialNodeDefinition[] = [
  {
    type: "const.float",
    title: "Float",
    category: "Constants",
    cost: 0,
    inputs: [],
    outputs: [{ id: "out", name: "Out", type: FLOAT }],
  },
  {
    type: "const.vec2",
    title: "Vector 2",
    category: "Constants",
    cost: 0,
    inputs: [],
    outputs: [{ id: "out", name: "Out", type: VEC2 }],
  },
  {
    type: "const.vec3",
    title: "Vector 3",
    category: "Constants",
    cost: 0,
    inputs: [],
    outputs: [{ id: "out", name: "Out", type: VEC3 }],
  },
  {
    type: "const.vec4",
    title: "Vector 4",
    category: "Constants",
    cost: 0,
    inputs: [],
    outputs: [{ id: "out", name: "Out", type: VEC4 }],
  },
  {
    type: "const.color",
    title: "Color",
    category: "Constants",
    cost: 0,
    inputs: [],
    outputs: [{ id: "out", name: "Out", type: VEC3, colorHint: true }],
  },
  {
    type: "param.float",
    title: "Float Parameter",
    category: "Parameters",
    cost: 0,
    inputs: [],
    outputs: [{ id: "out", name: "Out", type: FLOAT }],
  },
  {
    type: "param.color",
    title: "Color Parameter",
    category: "Parameters",
    cost: 0,
    inputs: [],
    outputs: [{ id: "out", name: "Out", type: VEC3, colorHint: true }],
  },
  {
    type: "param.texture",
    title: "Texture Parameter",
    category: "Parameters",
    cost: 0,
    inputs: [],
    outputs: [{ id: "out", name: "Out", type: TEXTURE }],
  },
];

const INPUT_NODES: MaterialNodeDefinition[] = [
  {
    type: "input.uv",
    title: "UV",
    category: "Input",
    cost: 0,
    inputs: [],
    outputs: [{ id: "uv", name: "UV", type: VEC2 }],
  },
  {
    type: "input.time",
    title: "Time",
    category: "Input",
    cost: 0,
    inputs: [],
    outputs: [{ id: "time", name: "Time", type: FLOAT }],
  },
  {
    type: "input.vertexColor",
    title: "Vertex Color",
    category: "Input",
    domains: ["surface"],
    cost: 0,
    inputs: [],
    outputs: [{ id: "color", name: "Color", type: VEC4, colorHint: true }],
  },
  {
    type: "input.worldPosition",
    title: "World Position",
    category: "Input",
    domains: ["surface"],
    cost: 0,
    inputs: [],
    outputs: [{ id: "position", name: "Position", type: VEC3 }],
  },
  {
    type: "input.worldNormal",
    title: "World Normal",
    category: "Input",
    domains: ["surface"],
    cost: 0,
    inputs: [],
    outputs: [{ id: "normal", name: "Normal", type: VEC3 }],
  },
  {
    type: "input.worldTangent",
    title: "World Tangent",
    category: "Input",
    domains: ["surface"],
    cost: 0,
    inputs: [],
    outputs: [{ id: "tangent", name: "Tangent", type: VEC3 }],
  },
  {
    type: "input.viewDirection",
    title: "View Direction",
    category: "Input",
    domains: ["surface"],
    cost: 0,
    inputs: [],
    outputs: [{ id: "direction", name: "Direction", type: VEC3 }],
  },
  {
    type: "input.cameraPosition",
    title: "Camera Position",
    category: "Input",
    domains: ["surface"],
    cost: 0,
    inputs: [],
    outputs: [{ id: "position", name: "Position", type: VEC3 }],
  },
  {
    type: "input.screenUv",
    title: "Screen UV",
    category: "Input",
    domains: ["postProcess"],
    stages: ["fragment"],
    cost: 0,
    inputs: [],
    outputs: [{ id: "uv", name: "UV", type: VEC2 }],
  },
  {
    type: "input.sceneColor",
    title: "Scene Color",
    category: "Input",
    domains: ["postProcess"],
    stages: ["fragment"],
    cost: 2,
    samples: 1,
    inputs: [{ id: "uv", name: "UV", type: VEC2 }],
    outputs: [{ id: "color", name: "Color", type: VEC4, colorHint: true }],
  },
  {
    type: "input.sceneDepth",
    title: "Scene Depth",
    category: "Input",
    domains: ["postProcess"],
    stages: ["fragment"],
    requires: ["sceneDepth"],
    cost: 2,
    samples: 1,
    inputs: [{ id: "uv", name: "UV", type: VEC2 }],
    outputs: [{ id: "depth", name: "Depth", type: FLOAT }],
  },
  {
    type: "input.sceneNormal",
    title: "Scene Normal",
    category: "Input",
    domains: ["postProcess"],
    stages: ["fragment"],
    requires: ["sceneNormal"],
    cost: 2,
    samples: 1,
    inputs: [{ id: "uv", name: "UV", type: VEC2 }],
    outputs: [{ id: "normal", name: "Normal", type: VEC3 }],
  },
  {
    type: "input.screenSize",
    title: "Screen Size",
    category: "Input",
    cost: 0,
    inputs: [],
    outputs: [{ id: "size", name: "Size", type: VEC2 }],
  },
  {
    type: "input.particleColor",
    title: "Particle Color",
    category: "Input",
    domains: ["particle"],
    stages: ["fragment"],
    cost: 0,
    inputs: [],
    outputs: [{ id: "color", name: "Color", type: VEC4, colorHint: true }],
  },
  {
    type: "input.particleTexture",
    title: "Particle Texture",
    category: "Input",
    domains: ["particle"],
    stages: ["fragment"],
    cost: 2,
    samples: 1,
    inputs: [{ id: "uv", name: "UV", type: VEC2 }],
    outputs: [
      { id: "rgba", name: "RGBA", type: VEC4, colorHint: true },
      { id: "rgb", name: "RGB", type: VEC3, colorHint: true },
      { id: "a", name: "A", type: FLOAT },
    ],
  },
];

const MATH_NODES: MaterialNodeDefinition[] = [
  generic("math.add", "Add", "Math", ["a", "b"]),
  generic("math.subtract", "Subtract", "Math", ["a", "b"]),
  generic("math.multiply", "Multiply", "Math", ["a", "b"]),
  generic("math.divide", "Divide", "Math", ["a", "b"]),
  unaryGeneric("math.negate", "Negate"),
  unaryGeneric("math.reciprocal", "Reciprocal"),
  unaryGeneric("math.radians", "Radians"),
  unaryGeneric("math.degrees", "Degrees"),
  unaryGeneric("math.sin", "Sine", "Math", 2),
  unaryGeneric("math.cos", "Cosine", "Math", 2),
  unaryGeneric("math.tan", "Tangent", "Math", 3),
  unaryGeneric("math.asin", "Arcsine", "Math", 3),
  unaryGeneric("math.acos", "Arccosine", "Math", 3),
  unaryGeneric("math.atan", "Arctangent", "Math", 3),
  generic("math.atan2", "Arctangent 2", "Math", ["y", "x"], 4),
  generic("math.pow", "Power", "Math", ["base", "exponent"], 3),
  unaryGeneric("math.exp", "Exponential", "Math", 2),
  unaryGeneric("math.exp2", "Exponential 2", "Math", 2),
  unaryGeneric("math.log", "Logarithm", "Math", 2),
  unaryGeneric("math.log2", "Logarithm 2", "Math", 2),
  unaryGeneric("math.sqrt", "Square Root", "Math", 2),
  unaryGeneric("math.inverseSqrt", "Inverse Square Root", "Math", 2),
  unaryGeneric("math.abs", "Absolute"),
  unaryGeneric("math.sign", "Sign"),
  unaryGeneric("math.floor", "Floor"),
  unaryGeneric("math.ceil", "Ceiling"),
  unaryGeneric("math.round", "Round"),
  unaryGeneric("math.fract", "Fraction"),
  generic("math.mod", "Modulo", "Math", ["a", "b"], 2),
  generic("math.min", "Minimum", "Math", ["a", "b"]),
  generic("math.max", "Maximum", "Math", ["a", "b"]),
  generic("math.clamp", "Clamp", "Math", ["value", "min", "max"], 2),
  unaryGeneric("math.saturate", "Saturate"),
  generic("math.mix", "Mix", "Math", ["a", "b", "alpha"], 2),
  generic("math.step", "Step", "Math", ["edge", "value"]),
  generic(
    "math.smoothstep",
    "Smooth Step",
    "Math",
    ["edgeA", "edgeB", "value"],
    3,
  ),
  generic("math.remap", "Remap", "Math", ["value", "fromMin", "fromMax", "toMin", "toMax"], 3),
];

const VECTOR_NODES: MaterialNodeDefinition[] = [
  {
    type: "vector.dot",
    title: "Dot Product",
    category: "Vector",
    cost: 1,
    inputs: [
      { id: "a", name: "A", type: GENERIC, defaultValue: [0] },
      { id: "b", name: "B", type: GENERIC, defaultValue: [0] },
    ],
    outputs: [{ id: "out", name: "Out", type: FLOAT }],
  },
  {
    type: "vector.cross",
    title: "Cross Product",
    category: "Vector",
    cost: 2,
    inputs: [
      { id: "a", name: "A", type: VEC3, defaultValue: [0, 0, 0] },
      { id: "b", name: "B", type: VEC3, defaultValue: [0, 0, 0] },
    ],
    outputs: [{ id: "out", name: "Out", type: VEC3 }],
  },
  {
    type: "vector.length",
    title: "Length",
    category: "Vector",
    cost: 2,
    inputs: [{ id: "value", name: "Value", type: GENERIC, defaultValue: [0] }],
    outputs: [{ id: "out", name: "Out", type: FLOAT }],
  },
  {
    type: "vector.distance",
    title: "Distance",
    category: "Vector",
    cost: 2,
    inputs: [
      { id: "a", name: "A", type: GENERIC, defaultValue: [0] },
      { id: "b", name: "B", type: GENERIC, defaultValue: [0] },
    ],
    outputs: [{ id: "out", name: "Out", type: FLOAT }],
  },
  unaryGeneric("vector.normalize", "Normalize", "Vector", 3),
  generic("vector.reflect", "Reflect", "Vector", ["incident", "normal"], 3),
  generic(
    "vector.refract",
    "Refract",
    "Vector",
    ["incident", "normal", "eta"],
    4,
  ),
  {
    type: "vector.combine",
    title: "Combine",
    category: "Vector",
    cost: 0,
    inputs: [
      { id: "x", name: "X", type: FLOAT, defaultValue: [0] },
      { id: "y", name: "Y", type: FLOAT, defaultValue: [0] },
      { id: "z", name: "Z", type: FLOAT, defaultValue: [0] },
      { id: "w", name: "W", type: FLOAT, defaultValue: [1] },
    ],
    outputs: [
      { id: "xy", name: "XY", type: VEC2 },
      { id: "xyz", name: "XYZ", type: VEC3 },
      { id: "xyzw", name: "XYZW", type: VEC4 },
    ],
  },
  {
    type: "vector.split",
    title: "Split",
    category: "Vector",
    cost: 0,
    inputs: [{ id: "value", name: "Value", type: GENERIC, defaultValue: [0] }],
    outputs: [
      { id: "x", name: "X", type: FLOAT },
      { id: "y", name: "Y", type: FLOAT },
      { id: "z", name: "Z", type: FLOAT },
      { id: "w", name: "W", type: FLOAT },
    ],
  },
];

const LOGIC_NODES: MaterialNodeDefinition[] = [
  generic("logic.equal", "Equal", "Logic", ["a", "b"]),
  generic("logic.notEqual", "Not Equal", "Logic", ["a", "b"]),
  generic("logic.lessThan", "Less Than", "Logic", ["a", "b"]),
  generic("logic.greaterThan", "Greater Than", "Logic", ["a", "b"]),
  {
    type: "logic.select",
    title: "Select",
    category: "Logic",
    cost: 1,
    inputs: [
      { id: "condition", name: "Condition", type: FLOAT, defaultValue: [0] },
      { id: "whenTrue", name: "When True", type: GENERIC, defaultValue: [0] },
      { id: "whenFalse", name: "When False", type: GENERIC, defaultValue: [0] },
    ],
    outputs: [{ id: "out", name: "Out", type: GENERIC }],
  },
];

const DERIVATIVE_NODES: MaterialNodeDefinition[] = [
  {
    type: "derivative.ddx",
    title: "DDX",
    category: "Derivative",
    stages: ["fragment"],
    requires: ["derivatives"],
    cost: 2,
    inputs: [{ id: "value", name: "Value", type: GENERIC, defaultValue: [0] }],
    outputs: [{ id: "out", name: "Out", type: GENERIC }],
  },
  {
    type: "derivative.ddy",
    title: "DDY",
    category: "Derivative",
    stages: ["fragment"],
    requires: ["derivatives"],
    cost: 2,
    inputs: [{ id: "value", name: "Value", type: GENERIC, defaultValue: [0] }],
    outputs: [{ id: "out", name: "Out", type: GENERIC }],
  },
  {
    type: "derivative.fwidth",
    title: "Fwidth",
    category: "Derivative",
    stages: ["fragment"],
    requires: ["derivatives"],
    cost: 3,
    inputs: [{ id: "value", name: "Value", type: GENERIC, defaultValue: [0] }],
    outputs: [{ id: "out", name: "Out", type: GENERIC }],
  },
];

const TEXTURE_NODES: MaterialNodeDefinition[] = [
  {
    type: "texture.sample",
    title: "Texture Sample",
    category: "Texture",
    cost: 8,
    samples: 1,
    inputs: [
      { id: "texture", name: "Texture", type: TEXTURE },
      { id: "uv", name: "UV", type: VEC2 },
    ],
    outputs: [
      { id: "rgba", name: "RGBA", type: VEC4, colorHint: true },
      { id: "rgb", name: "RGB", type: VEC3, colorHint: true },
      { id: "r", name: "R", type: FLOAT },
      { id: "g", name: "G", type: FLOAT },
      { id: "b", name: "B", type: FLOAT },
      { id: "a", name: "A", type: FLOAT },
    ],
  },
  {
    type: "texture.sampleLod",
    title: "Texture Sample LOD",
    category: "Texture",
    stages: ["fragment"],
    requires: ["textureLod"],
    cost: 8,
    samples: 1,
    inputs: [
      { id: "texture", name: "Texture", type: TEXTURE },
      { id: "uv", name: "UV", type: VEC2 },
      { id: "lod", name: "LOD", type: FLOAT, defaultValue: [0] },
    ],
    outputs: [
      { id: "rgba", name: "RGBA", type: VEC4, colorHint: true },
      { id: "rgb", name: "RGB", type: VEC3, colorHint: true },
      { id: "a", name: "A", type: FLOAT },
    ],
  },
  {
    type: "texture.transformUv",
    title: "Transform UV",
    category: "Texture",
    cost: 2,
    inputs: [
      { id: "uv", name: "UV", type: VEC2 },
      { id: "tiling", name: "Tiling", type: VEC2, defaultValue: [1, 1] },
      { id: "offset", name: "Offset", type: VEC2, defaultValue: [0, 0] },
    ],
    outputs: [{ id: "out", name: "Out", type: VEC2 }],
  },
];

const SHADING_NODES: MaterialNodeDefinition[] = [
  {
    type: "shading.fresnel",
    title: "Fresnel",
    category: "Shading",
    domains: ["surface"],
    cost: 6,
    inputs: [
      { id: "bias", name: "Bias", type: FLOAT, defaultValue: [0] },
      { id: "power", name: "Power", type: FLOAT, defaultValue: [1] },
    ],
    outputs: [{ id: "out", name: "Out", type: FLOAT }],
  },
  {
    type: "shading.normalMap",
    title: "Normal Map",
    category: "Shading",
    domains: ["surface"],
    stages: ["fragment"],
    cost: 5,
    inputs: [{ id: "packed", name: "Packed", type: VEC3 }],
    outputs: [{ id: "normal", name: "Normal", type: VEC3 }],
  },
  {
    type: "color.desaturate",
    title: "Desaturate",
    category: "Color",
    cost: 3,
    inputs: [
      { id: "color", name: "Color", type: VEC3, colorHint: true },
      { id: "level", name: "Level", type: FLOAT, defaultValue: [1] },
    ],
    outputs: [{ id: "out", name: "Out", type: VEC3, colorHint: true }],
  },
  {
    type: "color.gradient",
    title: "Gradient",
    category: "Color",
    cost: 3,
    inputs: [{ id: "value", name: "Value", type: FLOAT, defaultValue: [0] }],
    outputs: [{ id: "out", name: "Out", type: VEC3, colorHint: true }],
  },
];

/**
 * Restricted escape hatch. The body is a GLSL expression over the declared
 * inputs only: the compiler generates the function name and signature, so a
 * snippet cannot declare globals, uniforms, samplers or stage outputs. Custom
 * nodes are GLSL-only and always compile behind the manual Render button.
 */
const CUSTOM_NODES: MaterialNodeDefinition[] = [
  {
    type: "custom.glsl",
    title: "Custom GLSL",
    category: "Custom",
    cost: 16,
    inputs: [
      { id: "a", name: "A", type: GENERIC, defaultValue: [0] },
      { id: "b", name: "B", type: GENERIC, defaultValue: [0] },
    ],
    outputs: [{ id: "out", name: "Out", type: GENERIC }],
    requires: ["customGlsl"],
  },
];

const FUNCTION_NODES: MaterialNodeDefinition[] = [
  {
    type: "function.call",
    title: "Material Function",
    category: "Functions",
    cost: 0,
    inputs: [],
    outputs: [],
  },
  {
    type: "function.input",
    title: "Function Inputs",
    category: "Functions",
    cost: 0,
    inputs: [],
    outputs: [],
  },
  {
    type: "function.output",
    title: "Function Outputs",
    category: "Functions",
    cost: 0,
    inputs: [],
    outputs: [],
  },
];

const OUTPUT_NODES: MaterialNodeDefinition[] = [
  {
    type: "output.surface",
    title: "Material Output",
    category: "Output",
    domains: ["surface"],
    terminal: "surface",
    cost: 0,
    inputs: [
      {
        id: "baseColor",
        name: "Base Color",
        type: VEC3,
        colorHint: true,
        defaultValue: [0.8, 0.8, 0.8],
      },
      { id: "metallic", name: "Metallic", type: FLOAT, defaultValue: [0] },
      { id: "roughness", name: "Roughness", type: FLOAT, defaultValue: [0.5] },
      { id: "normal", name: "Normal", type: VEC3 },
      {
        id: "emissive",
        name: "Emissive",
        type: VEC3,
        colorHint: true,
        defaultValue: [0, 0, 0],
      },
      { id: "opacity", name: "Opacity", type: FLOAT, defaultValue: [1] },
      { id: "alphaClip", name: "Alpha Clip", type: FLOAT },
      {
        id: "worldPositionOffset",
        name: "World Position Offset",
        type: VEC3,
        defaultValue: [0, 0, 0],
      },
    ],
    outputs: [],
  },
  {
    type: "output.postProcess",
    title: "Post Process Output",
    category: "Output",
    domains: ["postProcess"],
    terminal: "postProcess",
    cost: 0,
    inputs: [
      {
        id: "color",
        name: "Color",
        type: VEC4,
        colorHint: true,
        defaultValue: [0, 0, 0, 1],
      },
    ],
    outputs: [],
  },
  {
    type: "output.particle",
    title: "Particle Output",
    category: "Output",
    domains: ["particle"],
    terminal: "particle",
    cost: 0,
    inputs: [
      {
        id: "color",
        name: "Color",
        type: VEC4,
        colorHint: true,
        defaultValue: [1, 1, 1, 1],
      },
    ],
    outputs: [],
  },
];

export const MATERIAL_CATALOG: readonly MaterialNodeDefinition[] = [
  ...CONSTANT_NODES,
  ...INPUT_NODES,
  ...MATH_NODES,
  ...VECTOR_NODES,
  ...LOGIC_NODES,
  ...DERIVATIVE_NODES,
  ...TEXTURE_NODES,
  ...SHADING_NODES,
  ...CUSTOM_NODES,
  ...FUNCTION_NODES,
  ...OUTPUT_NODES,
];

const BY_TYPE = new Map(
  MATERIAL_CATALOG.map((definition) => [definition.type, definition]),
);

export function materialNodeDefinition(
  type: string,
): MaterialNodeDefinition | undefined {
  return BY_TYPE.get(type);
}

export function nodeIsLegalInDomain(
  type: string,
  domain: MaterialDomain,
): boolean {
  const definition = BY_TYPE.get(type);
  if (!definition) return false;
  return definition.domains ? definition.domains.includes(domain) : true;
}

export function nodeIsLegalInStage(
  type: string,
  stage: MaterialStage,
): boolean {
  const definition = BY_TYPE.get(type);
  if (!definition) return false;
  return definition.stages ? definition.stages.includes(stage) : true;
}

/** Palette rows for one domain. Function plumbing nodes are hydrated per host. */
export function materialPaletteEntries(
  domain: MaterialDomain,
): MaterialNodeDefinition[] {
  return MATERIAL_CATALOG.filter(
    (definition) =>
      definition.type !== "function.input" &&
      definition.type !== "function.output" &&
      nodeIsLegalInDomain(definition.type, domain),
  );
}

export function terminalNodeTypeFor(domain: MaterialDomain): string {
  if (domain === "postProcess") return "output.postProcess";
  if (domain === "particle") return "output.particle";
  return "output.surface";
}
