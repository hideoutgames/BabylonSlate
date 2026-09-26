import type { ParticleGraphNode } from "./document";
import {
  resizeParticleValue,
  type ParticleNumericType,
  type ParticleValueType,
} from "./types";

/**
 * Header role of a node. The editor maps it onto the shared particle stage
 * tokens (`PARTICLE_STAGE_ROLE` in `@babylonslate/ui`), so the graph spine and
 * the Basic module stack use one colour sequence.
 */
export type ParticleNodeRole =
  | "output"
  | "create"
  | "shape"
  | "update"
  | "input"
  | "value";

/** Roles that sit on the Particle spine (Create → Shape → Update → Emitter Output). */
export function isParticleSpineRole(role: ParticleNodeRole): boolean {
  return role === "output" || role === "create" || role === "shape" || role === "update";
}

export type ParticlePinType =
  | { kind: ParticleValueType }
  | {
      kind: "generic";
      /** Non-Float types the group accepts (Float always splats in). Default: every numeric type. */
      accepts?: readonly ParticleNumericType[];
      /** Type of the group when no non-Float input is wired. Default Float. */
      fallback?: ParticleNumericType;
    };

export interface ParticlePinDefinition {
  /** camelCase, unique across the inputs and outputs of one node. */
  id: string;
  /** Title Case display name. */
  name: string;
  type: ParticlePinType;
  /** Literal used while unwired. Omitted: the pin stays unconnected in Babylon. */
  defaultValue?: number[];
  /** Unwired with no authored default raises `particle.missingInput`. */
  required?: boolean;
  /** Per-component clamp applied by Details and by lowering. */
  min?: number;
  max?: number;
  /** Pin typed by the node's `valueType` property (Random, Gradient). */
  followsValueType?: true;
  description?: string;
  /** Unit shown verbatim after the Details label, such as `s` or `m/s`. */
  unit?: string;
}

export interface ParticleNodeDefinition {
  type: string;
  /** Title Case. */
  title: string;
  /** Title Case palette group. */
  category: string;
  description?: string;
  /** Additional names accepted by Add Node search; never persisted. */
  searchAliases?: readonly string[];
  role: ParticleNodeRole;
  /** The protected Emitter Output. Exactly one per graph. */
  terminal?: true;
  /** Reads a per-particle attribute (stale outside a particle evaluation). */
  perParticleSource?: true;
  /** A vector system source, null until the system is simulating. */
  systemVectorSource?: true;
  inputs: readonly ParticlePinDefinition[];
  outputs: readonly ParticlePinDefinition[];
}

export const PARTICLE_OUTPUT_NODE_TYPE = "particle.output";

/** Palette groups in display order. */
export const PARTICLE_PALETTE_CATEGORIES = [
  "Emitter",
  "Shape",
  "Update",
  "Forces",
  "Particle Attributes",
  "System Values",
  "Constants",
  "Utility",
  "Math",
  "Vector",
  "Logic",
] as const;

export type ParticleConditionTest =
  | "equal"
  | "notEqual"
  | "lessThan"
  | "greaterThan"
  | "lessOrEqual"
  | "greaterOrEqual"
  | "and"
  | "or"
  | "xor";

export const PARTICLE_CONDITION_TESTS: readonly {
  id: ParticleConditionTest;
  label: string;
}[] = [
  { id: "equal", label: "Equal" },
  { id: "notEqual", label: "Not Equal" },
  { id: "lessThan", label: "Less Than" },
  { id: "greaterThan", label: "Greater Than" },
  { id: "lessOrEqual", label: "Less Or Equal" },
  { id: "greaterOrEqual", label: "Greater Or Equal" },
  { id: "and", label: "And" },
  { id: "or", label: "Or" },
  { id: "xor", label: "Xor" },
];

export type ParticleRandomLock = "perParticle" | "everyRead";

export const PARTICLE_RANDOM_LOCKS: readonly {
  id: ParticleRandomLock;
  label: string;
}[] = [
  { id: "perParticle", label: "Per Particle" },
  { id: "everyRead", label: "Every Read" },
];

export const PARTICLE_VALUE_TYPE_OPTIONS: readonly {
  id: ParticleNumericType;
  label: string;
}[] = [
  { id: "float", label: "Float" },
  { id: "vec2", label: "Vector 2" },
  { id: "vec3", label: "Vector 3" },
  { id: "color", label: "Color" },
];

/**
 * Babylon features deliberately left out of v1: type id → Title Case feature.
 * A document that holds one reports `particle.unsupportedNode` by name, and a
 * later version can enable it without renaming.
 */
export const PARTICLE_UNSUPPORTED_V1_TYPES: Readonly<Record<string, string>> = {
  "shape.mesh": "Mesh Shape",
  "shape.custom": "Custom Shape",
  "sprite.setup": "Sprite Sheet",
  "update.spriteCell": "Update Sprite Cell",
  "update.basicSprite": "Basic Sprite Update",
  "update.noise": "Noise",
  "update.flowMap": "Flow Map",
  "update.age": "Update Age",
  "trigger.spawn": "Particle Trigger",
  "utility.localVariable": "Local Variable",
  "math.nlerp": "Normalized Lerp",
  "math.floatToInt": "Float To Int",
};

const FLOAT: ParticlePinType = { kind: "float" };
const VEC2: ParticlePinType = { kind: "vec2" };
const VEC3: ParticlePinType = { kind: "vec3" };
const COLOR: ParticlePinType = { kind: "color" };
const PARTICLE: ParticlePinType = { kind: "particle" };
const GENERIC: ParticlePinType = { kind: "generic" };
/** Babylon's Color4 Max, Clamp, Step, Smooth Step and Divide are broken or throw. */
const GENERIC_NO_COLOR: ParticlePinType = {
  kind: "generic",
  accepts: ["float", "vec2", "vec3"],
};

/** Particle pins come first so the spine sits in the first pin row. */
const PARTICLE_IN: ParticlePinDefinition = {
  id: "particle",
  name: "Particle",
  type: PARTICLE,
  required: true,
};
const PARTICLE_OUT: ParticlePinDefinition = {
  id: "out",
  name: "Particle",
  type: PARTICLE,
};

const PARTICLE_SEARCH_ALIASES: Readonly<Record<string, readonly string[]>> = {
  "particle.create": ["spawn", "emit", "initialize"],
  "shape.sphere": ["hemisphere", "hemispheric"],
  "update.direction": ["velocity"],
  "update.angle": ["rotation"],
  "update.basicPosition": ["basic position update", "move", "velocity"],
  "update.basicColor": ["basic color update", "fade", "dead color"],
  "force.gravity": ["acceleration", "fall"],
  "force.attractor": ["attract", "magnet", "pull"],
  "input.contextual.direction": ["velocity"],
  "input.contextual.normalizedAge": ["age gradient", "life ratio"],
  "input.contextual.angle": ["rotation"],
  "input.system.deltaTime": ["delta", "dt"],
  "random.range": ["rand", "noise value"],
  "gradient.sample": ["ramp", "color over life", "curve"],
  "math.add": ["+", "a + b", "plus", "sum"],
  "math.subtract": ["-", "a - b", "minus"],
  "math.multiply": ["*", "×", "a * b", "product", "scale"],
  "math.divide": ["/", "÷", "a / b", "quotient"],
  "math.max": ["max", "max(a,b)"],
  "math.min": ["min", "min(a,b)"],
  "math.mod": ["%", "mod", "a % b", "remainder"],
  "math.pow": ["^", "**", "pow", "a^b"],
  "math.lerp": ["mix", "lerp(a,b,t)"],
  "math.smoothstep": ["smoothstep"],
  "math.clamp": ["clamp(x,min,max)", "saturate"],
  "math.cos": ["cos"],
  "math.sin": ["sin"],
  "math.tan": ["tan"],
  "math.abs": ["abs", "|x|"],
  "math.sqrt": ["sqrt", "√"],
  "math.exp": ["exp", "e^x"],
  "math.exp2": ["exp2", "2^x"],
  "math.log": ["log", "ln"],
  "math.acos": ["acos"],
  "math.asin": ["asin"],
  "math.atan": ["atan"],
  "math.ceil": ["ceil"],
  "math.fract": ["fract", "frac"],
  "math.negate": ["-x", "negative"],
  "math.oneMinus": ["1 - x", "invert"],
  "math.reciprocal": ["1/x", "inverse"],
  "logic.condition": ["if", "select", "compare", "<", ">", "=="],
  "vector.dot": ["dot"],
};

function withAliases(definition: ParticleNodeDefinition): ParticleNodeDefinition {
  const aliases = PARTICLE_SEARCH_ALIASES[definition.type];
  return aliases ? { ...definition, searchAliases: aliases } : definition;
}

function shapeNode(
  type: string,
  title: string,
  inputs: readonly ParticlePinDefinition[],
  description: string,
): ParticleNodeDefinition {
  return {
    type,
    title,
    category: "Shape",
    role: "shape",
    description,
    inputs: [PARTICLE_IN, ...inputs],
    outputs: [PARTICLE_OUT],
  };
}

function updateNode(
  type: string,
  title: string,
  category: "Update" | "Forces",
  inputs: readonly ParticlePinDefinition[],
  description: string,
): ParticleNodeDefinition {
  return {
    type,
    title,
    category,
    role: "update",
    description,
    inputs: [PARTICLE_IN, ...inputs],
    outputs: [PARTICLE_OUT],
  };
}

function attributeNode(
  type: string,
  title: string,
  outType: ParticlePinType,
  description?: string,
): ParticleNodeDefinition {
  return {
    type,
    title,
    category: "Particle Attributes",
    role: "input",
    perParticleSource: true,
    ...(description ? { description } : {}),
    inputs: [],
    outputs: [{ id: "out", name: title, type: outType }],
  };
}

function systemValueNode(
  type: string,
  title: string,
  outType: ParticlePinType,
  description: string,
): ParticleNodeDefinition {
  return {
    type,
    title,
    category: "System Values",
    role: "input",
    description,
    ...(outType.kind === "vec3" ? { systemVectorSource: true as const } : {}),
    inputs: [],
    outputs: [{ id: "out", name: title, type: outType }],
  };
}

function constantNode(
  type: string,
  title: string,
  outType: ParticlePinType,
): ParticleNodeDefinition {
  return {
    type,
    title,
    category: "Constants",
    role: "input",
    inputs: [],
    outputs: [{ id: "out", name: "Value", type: outType }],
  };
}

function binaryMath(
  type: string,
  title: string,
  pinType: ParticlePinType,
  bDefault: number,
): ParticleNodeDefinition {
  return {
    type,
    title,
    category: "Math",
    role: "value",
    inputs: [
      { id: "a", name: "A", type: pinType, defaultValue: [0] },
      { id: "b", name: "B", type: pinType, defaultValue: [bDefault] },
    ],
    outputs: [{ id: "out", name: "Out", type: pinType }],
  };
}

function unaryMath(type: string, title: string): ParticleNodeDefinition {
  return {
    type,
    title,
    category: "Math",
    role: "value",
    inputs: [{ id: "value", name: "Value", type: GENERIC, defaultValue: [0] }],
    outputs: [{ id: "out", name: "Out", type: GENERIC }],
  };
}

const EMITTER_NODES: ParticleNodeDefinition[] = [
  {
    type: PARTICLE_OUTPUT_NODE_TYPE,
    title: "Emitter Output",
    category: "Emitter",
    role: "output",
    terminal: true,
    description:
      "The emitter itself. Capacity, Loop, Duration, Pre Warm, Blend Mode and Billboard are graph settings.",
    inputs: [
      PARTICLE_IN,
      {
        id: "emitRate",
        name: "Emit Rate",
        type: FLOAT,
        defaultValue: [30],
        min: 0,
        unit: "/s",
        description: "Particles per second. Evaluated without a particle, so it cannot read particle attributes.",
      },
    ],
    outputs: [],
  },
  {
    type: "particle.create",
    title: "Create Particle",
    category: "Emitter",
    role: "create",
    description:
      "Starts the particle spine. Inputs are read once per new particle, before the Shape sets its position and direction.",
    inputs: [
      { id: "emitPower", name: "Emit Power", type: FLOAT, defaultValue: [1], unit: "m/s", description: "Initial speed along the emit direction (m/s)." },
      { id: "lifetime", name: "Lifetime", type: FLOAT, defaultValue: [1], min: 0.01, unit: "s", description: "Seconds." },
      { id: "color", name: "Color", type: COLOR, defaultValue: [1, 1, 1, 1] },
      { id: "deadColor", name: "Dead Color", type: COLOR, defaultValue: [0, 0, 0, 0] },
      { id: "size", name: "Size", type: FLOAT, defaultValue: [1], min: 0 },
      { id: "scale", name: "Scale", type: VEC2, defaultValue: [1, 1] },
      { id: "angle", name: "Angle", type: FLOAT, defaultValue: [0], unit: "rad", description: "Radians." },
    ],
    outputs: [PARTICLE_OUT],
  },
];

const DIRECTION_PAIR: readonly ParticlePinDefinition[] = [
  { id: "direction1", name: "Direction 1", type: VEC3, description: "Set both directions to emit between them instead of radially." },
  { id: "direction2", name: "Direction 2", type: VEC3, description: "Set both directions to emit between them instead of radially." },
];
const RADIUS: ParticlePinDefinition = { id: "radius", name: "Radius", type: FLOAT, defaultValue: [1], min: 0 };
const RADIUS_RANGE: ParticlePinDefinition = {
  id: "radiusRange",
  name: "Radius Range",
  type: FLOAT,
  defaultValue: [1],
  min: 0,
  max: 1,
  description: "0 spawns on the surface, 1 fills the volume.",
};
const DIRECTION_RANDOMIZER: ParticlePinDefinition = {
  id: "directionRandomizer",
  name: "Direction Randomizer",
  type: FLOAT,
  defaultValue: [0],
  min: 0,
  max: 1,
};
const RADIAL_NOTE = "Emits radially unless both directions are set.";

const SHAPE_NODES: ParticleNodeDefinition[] = [
  shapeNode(
    "shape.point",
    "Point Shape",
    [
      { id: "direction1", name: "Direction 1", type: VEC3, defaultValue: [0, 1, 0] },
      { id: "direction2", name: "Direction 2", type: VEC3, defaultValue: [0, 1, 0] },
    ],
    "Spawns at the emitter and moves between Direction 1 and Direction 2.",
  ),
  shapeNode(
    "shape.box",
    "Box Shape",
    [
      { id: "direction1", name: "Direction 1", type: VEC3, defaultValue: [0, 1, 0] },
      { id: "direction2", name: "Direction 2", type: VEC3, defaultValue: [0, 1, 0] },
      { id: "boxMin", name: "Box Min", type: VEC3, defaultValue: [-0.5, -0.5, -0.5] },
      { id: "boxMax", name: "Box Max", type: VEC3, defaultValue: [0.5, 0.5, 0.5] },
    ],
    "Spawns inside a box and moves between Direction 1 and Direction 2.",
  ),
  shapeNode(
    "shape.sphere",
    "Sphere Shape",
    [RADIUS, RADIUS_RANGE, DIRECTION_RANDOMIZER, ...DIRECTION_PAIR],
    `Spawns in a sphere, or a hemisphere when Hemispheric is on. ${RADIAL_NOTE}`,
  ),
  shapeNode(
    "shape.cone",
    "Cone Shape",
    [
      RADIUS,
      {
        id: "angle",
        name: "Angle",
        type: FLOAT,
        defaultValue: [Math.PI / 6],
        min: 0.01,
        max: Math.PI,
        unit: "rad",
        description: "Full opening angle in radians.",
      },
      RADIUS_RANGE,
      { id: "heightRange", name: "Height Range", type: FLOAT, defaultValue: [1], min: 0, max: 1 },
      DIRECTION_RANDOMIZER,
      ...DIRECTION_PAIR,
    ],
    `Spawns in a cone opening along the emitter's Y axis. ${RADIAL_NOTE}`,
  ),
  shapeNode(
    "shape.cylinder",
    "Cylinder Shape",
    [
      RADIUS,
      { id: "height", name: "Height", type: FLOAT, defaultValue: [1], min: 0 },
      RADIUS_RANGE,
      DIRECTION_RANDOMIZER,
      ...DIRECTION_PAIR,
    ],
    `Spawns in a cylinder along the emitter's Y axis. ${RADIAL_NOTE}`,
  ),
];

const UPDATE_NODES: ParticleNodeDefinition[] = [
  updateNode("update.position", "Update Position", "Update", [{ id: "position", name: "Position", type: VEC3, required: true }], "Sets the position every frame."),
  updateNode("update.direction", "Update Direction", "Update", [{ id: "direction", name: "Direction", type: VEC3, required: true }], "Sets the direction (velocity, m/s) every frame."),
  updateNode("update.color", "Update Color", "Update", [{ id: "color", name: "Color", type: COLOR, required: true }], "Sets the color every frame."),
  updateNode("update.size", "Update Size", "Update", [{ id: "size", name: "Size", type: FLOAT, required: true }], "Sets the size every frame."),
  updateNode("update.scale", "Update Scale", "Update", [{ id: "scale", name: "Scale", type: VEC2, required: true }], "Sets the X and Y scale every frame."),
  updateNode("update.angle", "Update Angle", "Update", [{ id: "angle", name: "Angle", type: FLOAT, required: true, unit: "rad", description: "Radians." }], "Sets the rotation (radians) every frame."),
  updateNode("update.basicPosition", "Apply Velocity", "Update", [], "Moves each particle along its direction every frame."),
  updateNode("update.basicColor", "Fade To Dead Color", "Update", [], "Blends each particle from its Color to its Dead Color over its life."),
  updateNode("update.alignAngle", "Align Angle", "Update", [], "Rotates each particle to face its direction of travel, plus Alignment."),
  updateNode(
    "force.gravity",
    "Gravity",
    "Forces",
    [{ id: "acceleration", name: "Acceleration", type: VEC3, defaultValue: [0, -9.81, 0], unit: "m/s²", description: "m/s²." }],
    "Adds Acceleration × Delta Time to the direction every frame.",
  ),
  updateNode(
    "force.attractor",
    "Attractor",
    "Forces",
    [
      { id: "position", name: "Position", type: VEC3, defaultValue: [0, 0, 0] },
      { id: "strength", name: "Strength", type: FLOAT, defaultValue: [1] },
    ],
    "Pulls particles toward Position. Its inputs are read without a particle, so particle attributes there are stale.",
  ),
];

const INPUT_NODES: ParticleNodeDefinition[] = [
  attributeNode("input.contextual.position", "Position", VEC3),
  attributeNode("input.contextual.direction", "Direction", VEC3, "Velocity in m/s."),
  attributeNode("input.contextual.scaledDirection", "Scaled Direction", VEC3, "Direction × this frame's seconds."),
  attributeNode("input.contextual.age", "Age", FLOAT, "Seconds since birth."),
  attributeNode("input.contextual.lifetime", "Lifetime", FLOAT, "Seconds."),
  attributeNode("input.contextual.normalizedAge", "Normalized Age", FLOAT, "Age ÷ Lifetime, 0 at birth and 1 at death."),
  attributeNode("input.contextual.color", "Particle Color", COLOR),
  attributeNode("input.contextual.initialColor", "Initial Color", COLOR),
  attributeNode("input.contextual.deadColor", "Dead Color", COLOR),
  attributeNode("input.contextual.size", "Size", FLOAT),
  attributeNode("input.contextual.scale", "Scale", VEC2),
  attributeNode("input.contextual.angle", "Angle", FLOAT, "Radians."),
  systemValueNode("input.system.time", "Time", FLOAT, "Seconds since the emitter started, including Pre Warm."),
  systemValueNode("input.system.deltaTime", "Delta Time", FLOAT, "Seconds simulated this frame."),
  systemValueNode("input.system.emitterPosition", "Emitter Position", VEC3, "World-space position of the emitter."),
  systemValueNode("input.system.cameraPosition", "Camera Position", VEC3, "World-space position of the active camera."),
  constantNode("const.float", "Float", FLOAT),
  constantNode("const.vec2", "Vector 2", VEC2),
  constantNode("const.vec3", "Vector 3", VEC3),
  constantNode("const.color", "Color", COLOR),
];

const UTILITY_NODES: ParticleNodeDefinition[] = [
  {
    type: "random.range",
    title: "Random",
    category: "Utility",
    role: "value",
    description:
      "A random value between Min and Max. Per Particle rolls once per particle evaluation: fixed in Create Particle inputs, re-rolled every frame in Update inputs. Every Read rolls on every read.",
    inputs: [
      { id: "min", name: "Min", type: FLOAT, defaultValue: [0], followsValueType: true },
      { id: "max", name: "Max", type: FLOAT, defaultValue: [1], followsValueType: true },
    ],
    outputs: [{ id: "out", name: "Value", type: FLOAT, followsValueType: true }],
  },
  {
    type: "gradient.sample",
    title: "Gradient",
    category: "Utility",
    role: "value",
    description: "Samples 2 to 8 stops at Ratio (clamped to 0–1). Edit the stops in Details.",
    inputs: [{ id: "ratio", name: "Ratio", type: FLOAT, defaultValue: [0], min: 0, max: 1 }],
    outputs: [{ id: "out", name: "Value", type: COLOR, followsValueType: true }],
  },
];

const MATH_NODES: ParticleNodeDefinition[] = [
  binaryMath("math.add", "Add", GENERIC, 0),
  binaryMath("math.subtract", "Subtract", GENERIC, 0),
  binaryMath("math.multiply", "Multiply", GENERIC, 1),
  binaryMath("math.divide", "Divide", GENERIC_NO_COLOR, 1),
  binaryMath("math.min", "Minimum", GENERIC, 0),
  binaryMath("math.max", "Maximum", GENERIC_NO_COLOR, 0),
  {
    type: "math.mod",
    title: "Modulo",
    category: "Math",
    role: "value",
    inputs: [
      { id: "a", name: "A", type: FLOAT, defaultValue: [0] },
      { id: "b", name: "B", type: FLOAT, defaultValue: [1] },
    ],
    outputs: [{ id: "out", name: "Out", type: FLOAT }],
  },
  {
    type: "math.pow",
    title: "Power",
    category: "Math",
    role: "value",
    inputs: [
      { id: "base", name: "Base", type: FLOAT, defaultValue: [0] },
      { id: "exponent", name: "Exponent", type: FLOAT, defaultValue: [1] },
    ],
    outputs: [{ id: "out", name: "Out", type: FLOAT }],
  },
  {
    type: "math.lerp",
    title: "Lerp",
    category: "Math",
    role: "value",
    inputs: [
      { id: "a", name: "A", type: GENERIC, defaultValue: [0] },
      { id: "b", name: "B", type: GENERIC, defaultValue: [1] },
      { id: "alpha", name: "Alpha", type: FLOAT, defaultValue: [0], min: 0, max: 1 },
    ],
    outputs: [{ id: "out", name: "Out", type: GENERIC }],
  },
  {
    type: "math.smoothstep",
    title: "Smooth Step",
    category: "Math",
    role: "value",
    inputs: [
      { id: "value", name: "Value", type: GENERIC_NO_COLOR, defaultValue: [0] },
      { id: "edgeA", name: "Edge A", type: FLOAT, defaultValue: [0] },
      { id: "edgeB", name: "Edge B", type: FLOAT, defaultValue: [1] },
    ],
    outputs: [{ id: "out", name: "Out", type: GENERIC_NO_COLOR }],
  },
  {
    type: "math.step",
    title: "Step",
    category: "Math",
    role: "value",
    inputs: [
      { id: "value", name: "Value", type: GENERIC_NO_COLOR, defaultValue: [0] },
      { id: "edge", name: "Edge", type: FLOAT, defaultValue: [0] },
    ],
    outputs: [{ id: "out", name: "Out", type: GENERIC_NO_COLOR }],
  },
  {
    type: "math.clamp",
    title: "Clamp",
    category: "Math",
    role: "value",
    inputs: [
      { id: "value", name: "Value", type: GENERIC_NO_COLOR, defaultValue: [0] },
      { id: "min", name: "Min", type: FLOAT, defaultValue: [0] },
      { id: "max", name: "Max", type: FLOAT, defaultValue: [1] },
    ],
    outputs: [{ id: "out", name: "Out", type: GENERIC_NO_COLOR }],
  },
  unaryMath("math.cos", "Cosine"),
  unaryMath("math.sin", "Sine"),
  unaryMath("math.abs", "Absolute"),
  unaryMath("math.exp", "Exponential"),
  unaryMath("math.exp2", "Exponential 2"),
  unaryMath("math.round", "Round"),
  unaryMath("math.floor", "Floor"),
  unaryMath("math.ceil", "Ceiling"),
  unaryMath("math.sqrt", "Square Root"),
  unaryMath("math.log", "Logarithm"),
  unaryMath("math.tan", "Tangent"),
  unaryMath("math.atan", "Arctangent"),
  unaryMath("math.acos", "Arccosine"),
  unaryMath("math.asin", "Arcsine"),
  unaryMath("math.sign", "Sign"),
  unaryMath("math.negate", "Negate"),
  unaryMath("math.oneMinus", "One Minus"),
  unaryMath("math.reciprocal", "Reciprocal"),
  unaryMath("math.degrees", "Degrees"),
  unaryMath("math.radians", "Radians"),
  unaryMath("math.fract", "Fraction"),
];

const VECTOR_NODES: ParticleNodeDefinition[] = [
  {
    type: "vector.length",
    title: "Length",
    category: "Vector",
    role: "value",
    inputs: [{ id: "value", name: "Value", type: VEC3, defaultValue: [0, 0, 0] }],
    outputs: [{ id: "out", name: "Out", type: FLOAT }],
  },
  {
    type: "vector.dot",
    title: "Dot Product",
    category: "Vector",
    role: "value",
    inputs: [
      { id: "a", name: "A", type: VEC3, defaultValue: [0, 0, 0] },
      { id: "b", name: "B", type: VEC3, defaultValue: [0, 0, 0] },
    ],
    outputs: [{ id: "out", name: "Out", type: FLOAT }],
  },
  {
    type: "vector.distance",
    title: "Distance",
    category: "Vector",
    role: "value",
    inputs: [
      { id: "a", name: "A", type: VEC3, defaultValue: [0, 0, 0] },
      { id: "b", name: "B", type: VEC3, defaultValue: [0, 0, 0] },
    ],
    outputs: [{ id: "out", name: "Out", type: FLOAT }],
  },
  {
    type: "vector.split",
    title: "Split",
    category: "Vector",
    role: "value",
    inputs: [
      {
        id: "value",
        name: "Value",
        type: { kind: "generic", accepts: ["vec2", "vec3", "color"], fallback: "color" },
        required: true,
      },
    ],
    outputs: [
      { id: "x", name: "X", type: FLOAT },
      { id: "y", name: "Y", type: FLOAT },
      { id: "z", name: "Z", type: FLOAT },
      { id: "w", name: "W", type: FLOAT },
    ],
  },
  {
    type: "vector.combine",
    title: "Combine",
    category: "Vector",
    role: "value",
    inputs: [
      { id: "x", name: "X", type: FLOAT, defaultValue: [0] },
      { id: "y", name: "Y", type: FLOAT, defaultValue: [0] },
      { id: "z", name: "Z", type: FLOAT, defaultValue: [0] },
      { id: "w", name: "W", type: FLOAT, defaultValue: [1] },
    ],
    outputs: [
      { id: "xy", name: "XY", type: VEC2 },
      { id: "xyz", name: "XYZ", type: VEC3 },
      { id: "color", name: "Color", type: COLOR },
    ],
  },
];

const LOGIC_NODES: ParticleNodeDefinition[] = [
  {
    type: "logic.condition",
    title: "Condition",
    category: "Logic",
    role: "value",
    description: "Compares A and B with Test and returns When True or When False.",
    inputs: [
      { id: "a", name: "A", type: FLOAT, defaultValue: [0] },
      { id: "b", name: "B", type: FLOAT, defaultValue: [0] },
      { id: "whenTrue", name: "When True", type: GENERIC, defaultValue: [1] },
      { id: "whenFalse", name: "When False", type: GENERIC, defaultValue: [0] },
    ],
    outputs: [{ id: "out", name: "Out", type: GENERIC }],
  },
];

export const PARTICLE_CATALOG: readonly ParticleNodeDefinition[] = [
  ...EMITTER_NODES,
  ...SHAPE_NODES,
  ...UPDATE_NODES,
  ...INPUT_NODES,
  ...UTILITY_NODES,
  ...MATH_NODES,
  ...VECTOR_NODES,
  ...LOGIC_NODES,
].map(withAliases);

const BY_TYPE = new Map(PARTICLE_CATALOG.map((definition) => [definition.type, definition]));

export function particleNodeDefinition(type: string): ParticleNodeDefinition | undefined {
  return BY_TYPE.get(type);
}

/** Node types whose pins follow `properties.valueType`, with their default type. */
const VALUE_TYPE_DEFAULTS: Readonly<Record<string, ParticleNumericType>> = {
  "random.range": "float",
  "gradient.sample": "color",
};

export function particleNodeValueTypeDefault(type: string): ParticleNumericType | undefined {
  return VALUE_TYPE_DEFAULTS[type];
}

/** `properties.valueType` of a Random or Gradient node, with the node's default. */
export function particleNodeValueType(
  type: string,
  properties: Record<string, unknown>,
): ParticleNumericType | undefined {
  const fallback = VALUE_TYPE_DEFAULTS[type];
  if (!fallback) return undefined;
  const value = properties.valueType;
  return value === "float" || value === "vec2" || value === "vec3" || value === "color"
    ? value
    : fallback;
}

function typedPin(pin: ParticlePinDefinition, valueType: ParticleNumericType): ParticlePinDefinition {
  if (!pin.followsValueType) return pin;
  return {
    ...pin,
    type: { kind: valueType },
    ...(pin.defaultValue ? { defaultValue: resizeParticleValue(pin.defaultValue, valueType) } : {}),
  };
}

/** Definition for one node, with Random and Gradient pins typed by `valueType`. */
export function particleNodeDefinitionFor(
  node: Pick<ParticleGraphNode, "type" | "properties">,
): ParticleNodeDefinition | undefined {
  const definition = BY_TYPE.get(node.type);
  if (!definition) return undefined;
  const valueType = particleNodeValueType(node.type, node.properties);
  if (!valueType) return definition;
  return {
    ...definition,
    inputs: definition.inputs.map((pin) => typedPin(pin, valueType)),
    outputs: definition.outputs.map((pin) => typedPin(pin, valueType)),
  };
}

/** Add Node entries: every catalog node except the protected Emitter Output. */
export function particlePaletteEntries(): ParticleNodeDefinition[] {
  return PARTICLE_CATALOG.filter((definition) => !definition.terminal);
}
