import {
  AlignAngleBlock,
  BasicColorUpdateBlock,
  BasicPositionUpdateBlock,
  BoxShapeBlock,
  Color4,
  ConeShapeBlock,
  CreateParticleBlock,
  CylinderShapeBlock,
  NodeParticleBlockConnectionPointTypes,
  NodeParticleContextualSources,
  NodeParticleSystemSources,
  ParticleClampBlock,
  ParticleConditionBlock,
  ParticleConditionBlockTests,
  ParticleConverterBlock,
  ParticleGradientBlock,
  ParticleGradientValueBlock,
  ParticleInputBlock,
  ParticleLerpBlock,
  ParticleMathBlock,
  ParticleMathBlockOperations,
  ParticleNumberMathBlock,
  ParticleNumberMathBlockOperations,
  ParticleRandomBlock,
  ParticleRandomBlockLocks,
  ParticleSmoothStepBlock,
  ParticleStepBlock,
  ParticleTextureSourceBlock,
  ParticleTrigonometryBlock,
  ParticleTrigonometryBlockOperations,
  ParticleVectorLengthBlock,
  ParticleVectorMathBlock,
  ParticleVectorMathBlockOperations,
  PointShapeBlock,
  SphereShapeBlock,
  SystemBlock,
  UpdateAngleBlock,
  UpdateAttractorBlock,
  UpdateColorBlock,
  UpdateDirectionBlock,
  UpdatePositionBlock,
  UpdateScaleBlock,
  UpdateSizeBlock,
  Vector2,
  Vector3,
  type AbstractMesh,
  type NodeParticleBlock,
  type NodeParticleConnectionPoint,
} from "@babylonjs/core";
import {
  PARTICLE_UPDATE_SPEED,
  particlePrewarmSteps,
  type ParticleSpace,
} from "@babylonslate/core";
import {
  resizeParticleValue,
  type ParticleGradientStop,
  type ParticleGraphSettings,
  type ParticleNumericType,
  type ParticleOperation,
} from "@babylonslate/particle-graph";
import { PARTICLE_BILLBOARD_MODES, PARTICLE_BLEND_MODES } from "./particle-render-modes";

/**
 * Babylon 9.20 never initializes `NodeParticleBlock._buildId`: `createSystem` computes
 * `undefined++` (NaN), so `build()` never recognizes an already built block and a value
 * node reached by N consumers runs `_build` N times. Seeding a finite id before
 * `createSystem` makes every block build once per system (docs/design/particle-emitters.md).
 */
export class SlateSystemBlock extends SystemBlock {
  seedBuildId(id: number): void {
    this._buildId = id;
  }
}

/** Babylon blocks for one plan operation, keyed by IR pin id. */
export interface ParticleBlockRealization {
  /** Every block the adapter created; the realizer attaches them to the set. */
  blocks: NodeParticleBlock[];
  inputs: Readonly<Record<string, NodeParticleConnectionPoint>>;
  outputs: Readonly<Record<string, NodeParticleConnectionPoint>>;
  /** Pins whose Babylon block adapts a Float operand itself, so no splat block is inserted. */
  nativeSplat?: ReadonlySet<string>;
  /** Pins connected without Babylon's type check (Emit Rate: an Int port fed by a Float). */
  coerce?: ReadonlySet<string>;
  /** The terminal's SystemBlock. */
  system?: SlateSystemBlock;
}

export interface ParticleBlockAdapterContext {
  operation: ParticleOperation;
  /** Babylon block name (`<system>/<node id>`); Babylon's own errors quote it. */
  name: string;
  /** The Particle System's Space: Local lowers Apply Velocity through `LocalPositionUpdated`. */
  space: ParticleSpace;
}

export type ParticleBlockAdapter = (context: ParticleBlockAdapterContext) => ParticleBlockRealization;

const BABYLON_TYPES: Readonly<Record<ParticleNumericType, NodeParticleBlockConnectionPointTypes>> = {
  float: NodeParticleBlockConnectionPointTypes.Float,
  vec2: NodeParticleBlockConnectionPointTypes.Vector2,
  vec3: NodeParticleBlockConnectionPointTypes.Vector3,
  color: NodeParticleBlockConnectionPointTypes.Color4,
};

function babylonValue(type: ParticleNumericType, value: readonly number[]): number | Vector2 | Vector3 | Color4 {
  const [x = 0, y = 0, z = 0, w = 1] = resizeParticleValue(value, type);
  switch (type) {
    case "float": return x;
    case "vec2": return new Vector2(x, y);
    case "vec3": return new Vector3(x, y, z);
    case "color": return new Color4(x, y, z, w);
  }
}

/** A typed constant; render always connects constants instead of writing `port.value`. */
export function particleConstantBlock(name: string, type: ParticleNumericType, value: readonly number[]): ParticleInputBlock {
  const block = new ParticleInputBlock(name, BABYLON_TYPES[type]);
  block.value = babylonValue(type, value);
  return block;
}

function contextualBlock(name: string, source: NodeParticleContextualSources): ParticleInputBlock {
  const block = new ParticleInputBlock(name);
  block.contextualValue = source;
  return block;
}

function systemSourceBlock(name: string, source: NodeParticleSystemSources): ParticleInputBlock {
  const block = new ParticleInputBlock(name);
  block.systemSource = source;
  return block;
}

/** Multiplies a Float source by ones of `to`, which is Babylon's own splat (`adapt`). */
export function particleSplatBlocks(
  name: string,
  source: NodeParticleConnectionPoint,
  to: Exclude<ParticleNumericType, "float">,
): { blocks: NodeParticleBlock[]; output: NodeParticleConnectionPoint } {
  const ones = particleConstantBlock(`${name}/ones`, to, [1]);
  const multiply = new ParticleMathBlock(`${name}/splat`);
  multiply.operation = ParticleMathBlockOperations.Multiply;
  source.connectTo(multiply.left, true);
  ones.output.connectTo(multiply.right, true);
  return { blocks: [ones, multiply], output: multiply.output };
}

type SpineBlock = NodeParticleBlock & { particle: NodeParticleConnectionPoint; output: NodeParticleConnectionPoint };

/** A Shape or Update block: `particle` in, `out` from Babylon's `output`, plus its value pins. */
function spine<T extends SpineBlock>(
  create: (name: string) => T,
  pins: (block: T) => Record<string, NodeParticleConnectionPoint> = () => ({}),
  configure?: (block: T, operation: ParticleOperation) => void,
): ParticleBlockAdapter {
  return ({ name, operation }) => {
    const block = create(name);
    configure?.(block, operation);
    return { blocks: [block], inputs: { particle: block.particle, ...pins(block) }, outputs: { out: block.output } };
  };
}

function contextual(source: NodeParticleContextualSources): ParticleBlockAdapter {
  return ({ name }) => {
    const block = contextualBlock(name, source);
    return { blocks: [block], inputs: {}, outputs: { out: block.output } };
  };
}

function systemValue(source: NodeParticleSystemSources): ParticleBlockAdapter {
  return ({ name }) => {
    const block = systemSourceBlock(name, source);
    return { blocks: [block], inputs: {}, outputs: { out: block.output } };
  };
}

function constant(type: ParticleNumericType): ParticleBlockAdapter {
  return ({ name, operation }) => {
    const value = Array.isArray(operation.properties.value) ? (operation.properties.value as number[]) : [];
    const block = particleConstantBlock(name, type, value);
    return { blocks: [block], inputs: {}, outputs: { out: block.output } };
  };
}

const MATH_PINS = new Set(["a", "b"]);

function math(operation: ParticleMathBlockOperations): ParticleBlockAdapter {
  return ({ name }) => {
    const block = new ParticleMathBlock(name);
    block.operation = operation;
    // Babylon adapts a Float operand to the other side's vector or color type.
    return { blocks: [block], inputs: { a: block.left, b: block.right }, outputs: { out: block.output }, nativeSplat: MATH_PINS };
  };
}

function numberMath(operation: ParticleNumberMathBlockOperations, left: string, right: string): ParticleBlockAdapter {
  return ({ name }) => {
    const block = new ParticleNumberMathBlock(name);
    block.operation = operation;
    return { blocks: [block], inputs: { [left]: block.left, [right]: block.right }, outputs: { out: block.output } };
  };
}

function vectorMath(operation: ParticleVectorMathBlockOperations): ParticleBlockAdapter {
  return ({ name }) => {
    const block = new ParticleVectorMathBlock(name);
    block.operation = operation;
    return { blocks: [block], inputs: { a: block.left, b: block.right }, outputs: { out: block.output } };
  };
}

function unary(operation: ParticleTrigonometryBlockOperations): ParticleBlockAdapter {
  return ({ name }) => {
    const block = new ParticleTrigonometryBlock(name);
    block.operation = operation;
    return { blocks: [block], inputs: { value: block.input }, outputs: { out: block.output } };
  };
}

/** Condition tests by name: Babylon orders Xor, Or, And differently from the IR list. */
const CONDITION_TESTS: Readonly<Record<string, ParticleConditionBlockTests>> = {
  equal: ParticleConditionBlockTests.Equal,
  notEqual: ParticleConditionBlockTests.NotEqual,
  lessThan: ParticleConditionBlockTests.LessThan,
  greaterThan: ParticleConditionBlockTests.GreaterThan,
  lessOrEqual: ParticleConditionBlockTests.LessOrEqual,
  greaterOrEqual: ParticleConditionBlockTests.GreaterOrEqual,
  and: ParticleConditionBlockTests.And,
  or: ParticleConditionBlockTests.Or,
  xor: ParticleConditionBlockTests.Xor,
};

function numericType(value: unknown, fallback: ParticleNumericType): ParticleNumericType {
  return value === "float" || value === "vec2" || value === "vec3" || value === "color" ? value : fallback;
}

/**
 * Ratio is clamped to 0–1 before the lookup (Babylon returns the number 0 below its
 * first stop); each stop is a typed constant feeding a `ParticleGradientValueBlock`.
 * Babylon adds the next `value<i>` input as each one is connected.
 */
const gradientAdapter: ParticleBlockAdapter = ({ name, operation }) => {
  const type = numericType(operation.properties.valueType, "color");
  const stops = Array.isArray(operation.properties.stops) ? (operation.properties.stops as ParticleGradientStop[]) : [];
  if (stops.length === 0) throw new Error("Gradient has no stops.");
  const ratio = new ParticleClampBlock(`${name}/ratio`);
  const gradient = new ParticleGradientBlock(name);
  const blocks: NodeParticleBlock[] = [ratio, gradient];
  ratio.output.connectTo(gradient.gradient, true);
  stops.forEach((stop, index) => {
    const value = particleConstantBlock(`${name}/stop${index}`, type, stop.value);
    const entry = new ParticleGradientValueBlock(`${name}/stop${index}/entry`);
    entry.reference = stop.position;
    value.output.connectTo(entry.value, true);
    const port = gradient.inputs[1 + index];
    if (!port) throw new Error("Babylon did not add a gradient entry input.");
    entry.output.connectTo(port, true);
    blocks.push(value, entry);
  });
  return { blocks, inputs: { ratio: ratio.value }, outputs: { out: gradient.output } };
};

/** Babylon's own gravity recipe: Direction + Acceleration × Delta Time into Update Direction. */
const gravityAdapter: ParticleBlockAdapter = ({ name }) => {
  const delta = systemSourceBlock(`${name}/delta`, NodeParticleSystemSources.Delta);
  const scaled = new ParticleMathBlock(`${name}/scaled`);
  scaled.operation = ParticleMathBlockOperations.Multiply;
  const direction = contextualBlock(`${name}/direction`, NodeParticleContextualSources.Direction);
  const add = new ParticleMathBlock(`${name}/add`);
  add.operation = ParticleMathBlockOperations.Add;
  const update = new UpdateDirectionBlock(name);
  delta.output.connectTo(scaled.right, true);
  direction.output.connectTo(add.left, true);
  scaled.output.connectTo(add.right, true);
  add.output.connectTo(update.direction, true);
  return {
    blocks: [update, delta, scaled, direction, add],
    inputs: { particle: update.particle, acceleration: scaled.left },
    outputs: { out: update.output },
  };
};

/**
 * Local Space: node-built systems have no update queue, so Babylon's own local step never
 * runs. `LocalPositionUpdated` advances the stored local position and re-projects it
 * through the emitter every frame (Babylon's converter does the same), so particles
 * follow the actor. Position, Emitter Position and Attractor reads stay world-space.
 */
const applyVelocityAdapter: ParticleBlockAdapter = ({ name, space }) => {
  if (space !== "local") {
    const block = new BasicPositionUpdateBlock(name);
    return { blocks: [block], inputs: { particle: block.particle }, outputs: { out: block.output } };
  }
  const update = new UpdatePositionBlock(name);
  const local = contextualBlock(`${name}/localPosition`, NodeParticleContextualSources.LocalPositionUpdated);
  local.output.connectTo(update.position, true);
  return { blocks: [update, local], inputs: { particle: update.particle }, outputs: { out: update.output } };
};

/**
 * The texture input is required, so it takes a stock source block with no source or URL:
 * it stores null and creates no texture. The realizer then gives the built system its own
 * readiness texture.
 */
const outputAdapter: ParticleBlockAdapter = ({ name }) => {
  const system = new SlateSystemBlock(name);
  const texture = new ParticleTextureSourceBlock(`${name}/texture`);
  texture.textureOutput.connectTo(system.texture, true);
  return {
    blocks: [system, texture],
    inputs: { particle: system.particle, emitRate: system.emitRate },
    outputs: {},
    coerce: new Set(["emitRate"]),
    system,
  };
};

/** IR node type → Babylon blocks. Blocks are constructed directly: no Parse, snippets or class registry. */
export const PARTICLE_BLOCK_ADAPTERS: Readonly<Record<string, ParticleBlockAdapter>> = {
  "particle.output": outputAdapter,
  "particle.create": ({ name }) => {
    const block = new CreateParticleBlock(name);
    return {
      blocks: [block],
      inputs: {
        emitPower: block.emitPower, lifetime: block.lifeTime, color: block.color, deadColor: block.colorDead,
        size: block.size, scale: block.scale, angle: block.angle,
      },
      outputs: { out: block.particle },
    };
  },
  "shape.point": spine((name) => new PointShapeBlock(name), (block) => ({ direction1: block.direction1, direction2: block.direction2 })),
  "shape.box": spine((name) => new BoxShapeBlock(name), (block) => ({
    direction1: block.direction1, direction2: block.direction2, boxMin: block.minEmitBox, boxMax: block.maxEmitBox,
  })),
  "shape.sphere": spine((name) => new SphereShapeBlock(name), (block) => ({
    radius: block.radius, radiusRange: block.radiusRange, directionRandomizer: block.directionRandomizer,
    direction1: block.direction1, direction2: block.direction2,
  }), (block, operation) => { block.isHemispheric = operation.properties.hemisphere === true; }),
  "shape.cone": spine((name) => new ConeShapeBlock(name), (block) => ({
    radius: block.radius, angle: block.angle, radiusRange: block.radiusRange, heightRange: block.heightRange,
    directionRandomizer: block.directionRandomizer, direction1: block.direction1, direction2: block.direction2,
  }), (block, operation) => { block.emitFromSpawnPointOnly = operation.properties.emitFromSpawnPointOnly === true; }),
  "shape.cylinder": spine((name) => new CylinderShapeBlock(name), (block) => ({
    radius: block.radius, height: block.height, radiusRange: block.radiusRange,
    directionRandomizer: block.directionRandomizer, direction1: block.direction1, direction2: block.direction2,
  })),
  "update.position": spine((name) => new UpdatePositionBlock(name), (block) => ({ position: block.position })),
  "update.direction": spine((name) => new UpdateDirectionBlock(name), (block) => ({ direction: block.direction })),
  "update.color": spine((name) => new UpdateColorBlock(name), (block) => ({ color: block.color })),
  "update.size": spine((name) => new UpdateSizeBlock(name), (block) => ({ size: block.size })),
  "update.scale": spine((name) => new UpdateScaleBlock(name), (block) => ({ scale: block.scale })),
  "update.angle": spine((name) => new UpdateAngleBlock(name), (block) => ({ angle: block.angle })),
  "update.basicPosition": applyVelocityAdapter,
  "update.basicColor": spine((name) => new BasicColorUpdateBlock(name)),
  "update.alignAngle": spine((name) => new AlignAngleBlock(name), undefined, (block, operation) => {
    const alignment = operation.properties.alignment;
    if (typeof alignment === "number" && Number.isFinite(alignment)) block.alignment = alignment;
  }),
  "force.gravity": gravityAdapter,
  "force.attractor": spine((name) => new UpdateAttractorBlock(name), (block) => ({ position: block.attractor, strength: block.strength })),
  "input.contextual.position": contextual(NodeParticleContextualSources.Position),
  "input.contextual.direction": contextual(NodeParticleContextualSources.Direction),
  "input.contextual.scaledDirection": contextual(NodeParticleContextualSources.ScaledDirection),
  "input.contextual.age": contextual(NodeParticleContextualSources.Age),
  "input.contextual.lifetime": contextual(NodeParticleContextualSources.Lifetime),
  "input.contextual.normalizedAge": contextual(NodeParticleContextualSources.AgeGradient),
  "input.contextual.color": contextual(NodeParticleContextualSources.Color),
  "input.contextual.initialColor": contextual(NodeParticleContextualSources.InitialColor),
  "input.contextual.deadColor": contextual(NodeParticleContextualSources.ColorDead),
  "input.contextual.size": contextual(NodeParticleContextualSources.Size),
  "input.contextual.scale": contextual(NodeParticleContextualSources.Scale),
  "input.contextual.angle": contextual(NodeParticleContextualSources.Angle),
  "input.system.time": systemValue(NodeParticleSystemSources.Time),
  "input.system.deltaTime": systemValue(NodeParticleSystemSources.Delta),
  "input.system.emitterPosition": systemValue(NodeParticleSystemSources.Emitter),
  "input.system.cameraPosition": systemValue(NodeParticleSystemSources.CameraPosition),
  "const.float": constant("float"),
  "const.vec2": constant("vec2"),
  "const.vec3": constant("vec3"),
  "const.color": constant("color"),
  "random.range": ({ name, operation }) => {
    const block = new ParticleRandomBlock(name);
    block.lockMode = operation.properties.lock === "everyRead" ? ParticleRandomBlockLocks.None : ParticleRandomBlockLocks.PerParticle;
    return { blocks: [block], inputs: { min: block.min, max: block.max }, outputs: { out: block.output } };
  },
  "gradient.sample": gradientAdapter,
  "math.add": math(ParticleMathBlockOperations.Add),
  "math.subtract": math(ParticleMathBlockOperations.Subtract),
  "math.multiply": math(ParticleMathBlockOperations.Multiply),
  "math.divide": math(ParticleMathBlockOperations.Divide),
  "math.min": math(ParticleMathBlockOperations.Min),
  "math.max": math(ParticleMathBlockOperations.Max),
  "math.mod": numberMath(ParticleNumberMathBlockOperations.Modulo, "a", "b"),
  "math.pow": numberMath(ParticleNumberMathBlockOperations.Pow, "base", "exponent"),
  "math.lerp": ({ name }) => {
    const block = new ParticleLerpBlock(name);
    return { blocks: [block], inputs: { a: block.left, b: block.right, alpha: block.gradient }, outputs: { out: block.output } };
  },
  "math.smoothstep": ({ name }) => {
    const block = new ParticleSmoothStepBlock(name);
    return { blocks: [block], inputs: { value: block.value, edgeA: block.edge0, edgeB: block.edge1 }, outputs: { out: block.output } };
  },
  "math.step": ({ name }) => {
    const block = new ParticleStepBlock(name);
    return { blocks: [block], inputs: { value: block.value, edge: block.edge }, outputs: { out: block.output } };
  },
  "math.clamp": ({ name }) => {
    const block = new ParticleClampBlock(name);
    return { blocks: [block], inputs: { value: block.value, min: block.min, max: block.max }, outputs: { out: block.output } };
  },
  "math.cos": unary(ParticleTrigonometryBlockOperations.Cos),
  "math.sin": unary(ParticleTrigonometryBlockOperations.Sin),
  "math.abs": unary(ParticleTrigonometryBlockOperations.Abs),
  "math.exp": unary(ParticleTrigonometryBlockOperations.Exp),
  "math.exp2": unary(ParticleTrigonometryBlockOperations.Exp2),
  "math.round": unary(ParticleTrigonometryBlockOperations.Round),
  "math.floor": unary(ParticleTrigonometryBlockOperations.Floor),
  "math.ceil": unary(ParticleTrigonometryBlockOperations.Ceiling),
  "math.sqrt": unary(ParticleTrigonometryBlockOperations.Sqrt),
  "math.log": unary(ParticleTrigonometryBlockOperations.Log),
  "math.tan": unary(ParticleTrigonometryBlockOperations.Tan),
  "math.atan": unary(ParticleTrigonometryBlockOperations.ArcTan),
  "math.acos": unary(ParticleTrigonometryBlockOperations.ArcCos),
  "math.asin": unary(ParticleTrigonometryBlockOperations.ArcSin),
  "math.sign": unary(ParticleTrigonometryBlockOperations.Sign),
  "math.negate": unary(ParticleTrigonometryBlockOperations.Negate),
  "math.oneMinus": unary(ParticleTrigonometryBlockOperations.OneMinus),
  "math.reciprocal": unary(ParticleTrigonometryBlockOperations.Reciprocal),
  "math.degrees": unary(ParticleTrigonometryBlockOperations.ToDegrees),
  "math.radians": unary(ParticleTrigonometryBlockOperations.ToRadians),
  "math.fract": unary(ParticleTrigonometryBlockOperations.Fract),
  "vector.length": ({ name }) => {
    const block = new ParticleVectorLengthBlock(name);
    return { blocks: [block], inputs: { value: block.input }, outputs: { out: block.output } };
  },
  "vector.dot": vectorMath(ParticleVectorMathBlockOperations.Dot),
  "vector.distance": vectorMath(ParticleVectorMathBlockOperations.Distance),
  "vector.split": ({ name, operation }) => {
    const block = new ParticleConverterBlock(name);
    const type = numericType(operation.resolvedType, "color");
    // Babylon's converter inputs end in a space ("xyz "); only the typed getters are used.
    const value = type === "vec2" ? block.xyIn : type === "vec3" ? block.xyzIn : type === "color" ? block.colorIn : null;
    if (!value) throw new Error("Split needs a Vector 2, Vector 3 or Color value.");
    return { blocks: [block], inputs: { value }, outputs: { x: block.xOut, y: block.yOut, z: block.zOut, w: block.wOut } };
  },
  "vector.combine": ({ name }) => {
    const block = new ParticleConverterBlock(name);
    return {
      blocks: [block],
      inputs: { x: block.xIn, y: block.yIn, z: block.zIn, w: block.wIn },
      outputs: { xy: block.xyOut, xyz: block.xyzOut, color: block.colorOut },
    };
  },
  "logic.condition": ({ name, operation }) => {
    const block = new ParticleConditionBlock(name);
    block.test = CONDITION_TESTS[String(operation.properties.test)] ?? ParticleConditionBlockTests.LessThan;
    const epsilon = operation.properties.epsilon;
    block.epsilon = typeof epsilon === "number" && Number.isFinite(epsilon) ? Math.max(0, epsilon) : 0;
    return {
      blocks: [block],
      inputs: { a: block.left, b: block.right, whenTrue: block.ifTrue, whenFalse: block.ifFalse },
      outputs: { out: block.output },
    };
  },
};

export function particleBlockAdapterFor(nodeType: string): ParticleBlockAdapter | undefined {
  return Object.hasOwn(PARTICLE_BLOCK_ADAPTERS, nodeType) ? PARTICLE_BLOCK_ADAPTERS[nodeType] : undefined;
}

/**
 * Emitter settings Babylon copies from the SystemBlock inside `createSystem`, so they are
 * written before the build. `targetStopDuration` is an input port (assigning the getter
 * throws); `billBoardMode` has a capital B on the block. Capacity is not capped: graphs
 * simulate on the CPU and only warn above 512.
 */
export function configureParticleSystemBlock(
  block: SlateSystemBlock,
  settings: ParticleGraphSettings,
  options: { name: string; emitter: AbstractMesh; space: ParticleSpace },
): void {
  const infinite = settings.loop === "infinite";
  const prewarm = particlePrewarmSteps(infinite ? settings.prewarm : 0);
  block.name = options.name;
  block.capacity = settings.capacity;
  block.updateSpeed = PARTICLE_UPDATE_SPEED;
  block.blendMode = PARTICLE_BLEND_MODES[settings.blendMode];
  block.isBillboardBased = true;
  block.billBoardMode = PARTICLE_BILLBOARD_MODES[settings.billboard];
  block.preWarmCycles = prewarm.cycles;
  block.preWarmStepOffset = prewarm.stepOffset;
  block.targetStopDuration.value = infinite ? 0 : settings.duration;
  block.isLocal = options.space === "local";
  block.emitter = options.emitter;
  block.manualEmitCount = -1;
  // A real-time timeout that pause cannot hold; the service starts with `start(0)`.
  block.startDelay = 0;
  // The service owns stop, drain and disposal; the set's dispose releases the system.
  block.disposeOnStop = false;
  block.doNoStart = false;
  block.renderingGroupId = 0;
}
