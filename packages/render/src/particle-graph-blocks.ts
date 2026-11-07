import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector2, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import {
  ParticleConditionBlock,
  ParticleConditionBlockTests,
} from "@babylonjs/core/Particles/Node/Blocks/Conditions/particleConditionBlock";
import { BoxShapeBlock } from "@babylonjs/core/Particles/Node/Blocks/Emitters/boxShapeBlock";
import { ConeShapeBlock } from "@babylonjs/core/Particles/Node/Blocks/Emitters/coneShapeBlock";
import { CreateParticleBlock } from "@babylonjs/core/Particles/Node/Blocks/Emitters/createParticleBlock";
import { CylinderShapeBlock } from "@babylonjs/core/Particles/Node/Blocks/Emitters/cylinderShapeBlock";
import { PointShapeBlock } from "@babylonjs/core/Particles/Node/Blocks/Emitters/pointShapeBlock";
import { SphereShapeBlock } from "@babylonjs/core/Particles/Node/Blocks/Emitters/sphereShapeBlock";
import { AlignAngleBlock } from "@babylonjs/core/Particles/Node/Blocks/Update/alignAngleBlock";
import { BasicColorUpdateBlock } from "@babylonjs/core/Particles/Node/Blocks/Update/basicColorUpdateBlock";
import { BasicPositionUpdateBlock } from "@babylonjs/core/Particles/Node/Blocks/Update/basicPositionUpdateBlock";
import { UpdateAngleBlock } from "@babylonjs/core/Particles/Node/Blocks/Update/updateAngleBlock";
import { UpdateAttractorBlock } from "@babylonjs/core/Particles/Node/Blocks/Update/updateAttractorBlock";
import { UpdateColorBlock } from "@babylonjs/core/Particles/Node/Blocks/Update/updateColorBlock";
import { UpdateDirectionBlock } from "@babylonjs/core/Particles/Node/Blocks/Update/updateDirectionBlock";
import { UpdatePositionBlock } from "@babylonjs/core/Particles/Node/Blocks/Update/updatePositionBlock";
import { UpdateScaleBlock } from "@babylonjs/core/Particles/Node/Blocks/Update/updateScaleBlock";
import { UpdateSizeBlock } from "@babylonjs/core/Particles/Node/Blocks/Update/updateSizeBlock";
import { ParticleClampBlock } from "@babylonjs/core/Particles/Node/Blocks/particleClampBlock";
import { ParticleConverterBlock } from "@babylonjs/core/Particles/Node/Blocks/particleConverterBlock";
import { ParticleGradientBlock } from "@babylonjs/core/Particles/Node/Blocks/particleGradientBlock";
import { ParticleGradientValueBlock } from "@babylonjs/core/Particles/Node/Blocks/particleGradientValueBlock";
import { ParticleInputBlock } from "@babylonjs/core/Particles/Node/Blocks/particleInputBlock";
import { globalParameterComponents, globalParameterDefaults, type GlobalParameterValueSource } from "./global-parameter-values";
import { ParticleLerpBlock } from "@babylonjs/core/Particles/Node/Blocks/particleLerpBlock";
import {
  ParticleLocalVariableBlock,
  ParticleLocalVariableBlockScope,
} from "@babylonjs/core/Particles/Node/Blocks/particleLocalVariableBlock";
import {
  ParticleMathBlock,
  ParticleMathBlockOperations,
} from "@babylonjs/core/Particles/Node/Blocks/particleMathBlock";
import { ParticleNLerpBlock } from "@babylonjs/core/Particles/Node/Blocks/particleNLerpBlock";
import {
  ParticleNumberMathBlock,
  ParticleNumberMathBlockOperations,
} from "@babylonjs/core/Particles/Node/Blocks/particleNumberMathBlock";
import {
  ParticleRandomBlock,
  ParticleRandomBlockLocks,
} from "@babylonjs/core/Particles/Node/Blocks/particleRandomBlock";
import { ParticleSmoothStepBlock } from "@babylonjs/core/Particles/Node/Blocks/particleSmoothStepBlock";
import { ParticleTextureSourceBlock } from "@babylonjs/core/Particles/Node/Blocks/particleSourceTextureBlock";
import { ParticleStepBlock } from "@babylonjs/core/Particles/Node/Blocks/particleStepBlock";
import {
  ParticleTrigonometryBlock,
  ParticleTrigonometryBlockOperations,
} from "@babylonjs/core/Particles/Node/Blocks/particleTrigonometryBlock";
import { ParticleVectorLengthBlock } from "@babylonjs/core/Particles/Node/Blocks/particleVectorLengthBlock";
import {
  ParticleVectorMathBlock,
  ParticleVectorMathBlockOperations,
} from "@babylonjs/core/Particles/Node/Blocks/particleVectorMathBlock";
import { SystemBlock } from "@babylonjs/core/Particles/Node/Blocks/systemBlock";
import {
  NodeParticleBlockConnectionPointTypes,
} from "@babylonjs/core/Particles/Node/Enums/nodeParticleBlockConnectionPointTypes";
import { NodeParticleContextualSources } from "@babylonjs/core/Particles/Node/Enums/nodeParticleContextualSources";
import { NodeParticleSystemSources } from "@babylonjs/core/Particles/Node/Enums/nodeParticleSystemSources";
import { NodeParticleBlock } from "@babylonjs/core/Particles/Node/nodeParticleBlock";
import type { NodeParticleConnectionPoint } from "@babylonjs/core/Particles/Node/nodeParticleBlockConnectionPoint";
import type { NodeParticleBuildState } from "@babylonjs/core/Particles/Node/nodeParticleBuildState";
import type { Particle } from "@babylonjs/core/Particles/particle";
import type { ParticleSystem } from "@babylonjs/core/Particles/particleSystem";
import {
  PARTICLE_UPDATE_SPEED,
  globalParameterSelection,
  particlePrewarmSteps,
  type GlobalParameterSelection,
  type ParticleSpace,
} from "@haptic/core";
import {
  particleSpriteSheetSettings,
  resizeParticleValue,
  type ParticleGradientStop,
  type ParticleGraphParameter,
  type ParticleGraphSettings,
  type ParticleNumericType,
  type ParticleOperation,
} from "@haptic/particle-graph";
import { SlateMeshShapeBlock, type ParticleMeshShapeSource } from "./particle-mesh-shape";
import { SlateSpriteAnimateBlock, SlateSpriteCellBlock, SlateSpriteSheetBlock } from "./particle-sprite-sheet";
import { SlateSpawnBlock, type ParticleSpawnSink } from "./particle-spawn";
import { BUILTIN_PARTICLE_NOISE, type ParticleNoiseSource } from "./particle-noise";
import { PARTICLE_BILLBOARD_MODES, PARTICLE_BLEND_MODES } from "./particle-render-modes";

/**
 * Babylon 9.29 never initializes `NodeParticleBlock._buildId`: `createSystem` computes
 * `undefined++` (NaN), so `build()` never recognizes an already built block and a value
 * node reached by N consumers runs `_build` N times. Seeding a finite id before
 * `createSystem` makes every block build once per system (.agents/reference/architecture/particles.md).
 */
export class SlateSystemBlock extends SystemBlock {
  seedBuildId(id: number): void {
    this._buildId = id;
  }
}

/**
 * Babylon 9.29's Local Variable never drops its per-frame entries in Loop scope, and a second
 * Particle-scope variable replaces the first one's reset hook, so entries pile up. This one keeps,
 * per particle, a value tagged with the particle's id (a reset gives the particle a new id), and
 * in Loop scope only the current frame's value. Read outside a particle, Particle scope acts as Loop.
 */
export class SlateLocalVariableBlock extends ParticleLocalVariableBlock {
  private readonly particleValues = new WeakMap<object, { id: number; value: unknown }>();
  private loopValue: { frame: number; value: unknown } | null = null;

  override _build(state: NodeParticleBuildState): void {
    if (!this.input.isConnected) {
      this.output._storedFunction = null;
      this.output._storedValue = null;
      return;
    }
    // Vectors and colors are cloned so later math on the source never changes the kept value.
    const snapshot = (value: unknown) => {
      const cloneable = value as { clone?: () => unknown } | null;
      return cloneable && typeof cloneable.clone === "function" ? cloneable.clone() : value;
    };
    const read = (current: NodeParticleBuildState) => {
      const particle = current.particleContext;
      if (this.scope === ParticleLocalVariableBlockScope.Particle && particle) {
        const kept = this.particleValues.get(particle);
        if (kept?.id === particle.id) return kept.value;
        const value = snapshot(this.input.getConnectedValue(current));
        this.particleValues.set(particle, { id: particle.id, value });
        return value;
      }
      const frame = current.systemContext?.getScene()?.getFrameId() ?? -1;
      if (this.loopValue?.frame !== frame) this.loopValue = { frame, value: snapshot(this.input.getConnectedValue(current)) };
      return this.loopValue.value;
    };
    if (this.output.isConnected) this.output._storedFunction = read;
    else this.output._storedValue = read(state);
  }

  override dispose(): void {
    this.loopValue = null;
    super.dispose();
  }
}

type NoiseCoordinates = { a: Vector3; b: Vector3 };
type NoiseParticle = Particle & { _properties: Record<string, unknown> };
type QueueItem = { process: (particle: Particle) => void; previousItem: QueueItem | null; nextItem: QueueItem | null };
type QueueSystem = ParticleSystem & { _updateQueueStart: QueueItem | null; _tempScaledUpdateSpeed: number;
  _fetchR(u: number, v: number, width: number, height: number, pixels: Uint8Array): number };

/**
 * Noise: each particle gets fixed random coordinates in a noise image and is pushed every frame
 * by (2 × sample − 1) × Strength per axis, scaled by the frame's simulated seconds (so it follows
 * pause and time dilation), as Babylon's `UpdateNoiseBlock`. Babylon's block reads its texture
 * back from the GPU every frame; this one samples CPU pixels its source caches once, and pushes
 * nothing until they are there.
 */
export class SlateNoiseBlock extends NodeParticleBlock {
  source: ParticleNoiseSource = BUILTIN_PARTICLE_NOISE;

  constructor(name: string) {
    super(name);
    this.registerInput("particle", NodeParticleBlockConnectionPointTypes.Particle);
    this.registerInput("strength", NodeParticleBlockConnectionPointTypes.Vector3, true, new Vector3(2, 2, 2));
    this.registerOutput("output", NodeParticleBlockConnectionPointTypes.Particle);
  }

  override getClassName(): string {
    return "SlateNoiseBlock";
  }

  get particle(): NodeParticleConnectionPoint {
    return this._inputs[0]!;
  }

  get strength(): NodeParticleConnectionPoint {
    return this._inputs[1]!;
  }

  get output(): NodeParticleConnectionPoint {
    return this._outputs[0]!;
  }

  override _build(state: NodeParticleBuildState): void {
    const system = this.particle.getConnectedValue(state) as QueueSystem;
    const source = this.source;
    const force = new Vector3();
    const item: QueueItem = {
      process: (particle) => {
        const pixels = source.pixels();
        if (!pixels) return;
        state.particleContext = particle;
        state.systemContext = system;
        const strength = this.strength.getConnectedValue(state) as Vector3;
        const properties = (particle as NoiseParticle)._properties;
        let coordinates = properties.slateNoise as NoiseCoordinates | undefined;
        if (!coordinates) {
          coordinates = { a: new Vector3(Math.random(), Math.random(), Math.random()), b: new Vector3(Math.random(), Math.random(), Math.random()) };
          properties.slateNoise = coordinates;
        }
        const fetch = (u: number, v: number) => system._fetchR(u, v, pixels.width, pixels.height, pixels.data);
        force.copyFromFloats(
          (2 * fetch(coordinates.a.x, coordinates.a.y) - 1) * strength.x,
          (2 * fetch(coordinates.a.z, coordinates.b.x) - 1) * strength.y,
          (2 * fetch(coordinates.b.y, coordinates.b.z) - 1) * strength.z,
        );
        particle.direction.addInPlace(force.scaleInPlace(system._tempScaledUpdateSpeed));
      },
      previousItem: null,
      nextItem: null,
    };
    if (!system._updateQueueStart) system._updateQueueStart = item;
    else {
      let last = system._updateQueueStart;
      while (last.nextItem) last = last.nextItem;
      item.previousItem = last;
      last.nextItem = item;
    }
    this.output._storedValue = system;
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
  /** A Noise node's pixels for its Texture (null: the built-in noise). Defaults to the built-in noise. */
  noise?: (textureGuid: string | null) => ParticleNoiseSource;
  /** A Mesh Shape's geometry for its properties (Source, Model). Without it Mesh Shape spawns at the emitter. */
  meshShape?: (properties: Readonly<Record<string, unknown>>) => ParticleMeshShapeSource;
  /** The plan's declared parameters by id. */
  parameters: ReadonlyMap<string, ParticleGraphParameter>;
  /** What Global Parameter nodes read; the editor's defaults when omitted. */
  globalParameters?: GlobalParameterValueSource;
  /** Where a Spawn Emitter's requests go, for its properties; without one (or null) it spawns nothing. */
  spawn?: (properties: Readonly<Record<string, unknown>>) => ParticleSpawnSink | null;
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

/**
 * Writes a parameter value onto its input block. Babylon 9.29 builds an input block's output as
 * `() => this.value`, so the running system reads the new value on its next evaluation.
 */
export function setParticleInputBlockValue(block: ParticleInputBlock, type: ParticleNumericType, value: readonly number[]): void {
  block.value = babylonValue(type, value);
}

/**
 * A Particle Graph **Global Parameter** node's input. Babylon's built output reads `value` on
 * every evaluation, so the getter refreshes from `source` once its revision moves: setting a
 * global parameter changes every running emitter that reads it, with no rebuild.
 */
class GlobalParameterInputBlock extends ParticleInputBlock {
  private readonly selection: GlobalParameterSelection;
  private readonly source: GlobalParameterValueSource;
  private revision = Number.NaN;

  constructor(name: string, selection: GlobalParameterSelection, source: GlobalParameterValueSource) {
    super(name, BABYLON_TYPES[selection.valueType]);
    this.selection = selection;
    this.source = source;
  }

  override get value() {
    // The base constructor reads and writes `value` before this block's fields exist.
    const source = this.source as GlobalParameterValueSource | undefined;
    if (source && source.revision !== this.revision) {
      this.revision = source.revision;
      const { collectionGuid, parameterId, valueType } = this.selection;
      super.value = babylonValue(valueType, globalParameterComponents(source, collectionGuid, parameterId, valueType));
    }
    return super.value;
  }

  override set value(value) {
    super.value = value;
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

/**
 * A chain of unary operations: `value` feeds the first, `out` is the last. The degree
 * variants compose the radian blocks with Babylon's own To Radians / To Degrees.
 */
function unaryChain(...operations: ParticleTrigonometryBlockOperations[]): ParticleBlockAdapter {
  return ({ name }) => {
    const blocks = operations.map((operation, index) => {
      const block = new ParticleTrigonometryBlock(index === operations.length - 1 ? name : `${name}/${index}`);
      block.operation = operation;
      return block;
    });
    for (let index = 1; index < blocks.length; index += 1) blocks[index - 1]!.output.connectTo(blocks[index]!.input, true);
    return { blocks, inputs: { value: blocks[0]!.input }, outputs: { out: blocks.at(-1)!.output } };
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
  "update.angleDegrees": ({ name }) => {
    const radians = new ParticleTrigonometryBlock(`${name}/radians`);
    radians.operation = ParticleTrigonometryBlockOperations.ToRadians;
    const update = new UpdateAngleBlock(name);
    radians.output.connectTo(update.angle, true);
    return { blocks: [update, radians], inputs: { particle: update.particle, angle: radians.input }, outputs: { out: update.output } };
  },
  "update.basicPosition": applyVelocityAdapter,
  "update.basicColor": spine((name) => new BasicColorUpdateBlock(name)),
  "update.alignAngle": spine((name) => new AlignAngleBlock(name), undefined, (block, operation) => {
    const alignment = operation.properties.alignment;
    if (typeof alignment === "number" && Number.isFinite(alignment)) block.alignment = alignment;
  }),
  "force.gravity": gravityAdapter,
  "force.attractor": spine((name) => new UpdateAttractorBlock(name), (block) => ({ position: block.attractor, strength: block.strength })),
  "shape.mesh": ({ name, operation, meshShape }) => {
    const block = new SlateMeshShapeBlock(name);
    block.useMeshNormals = operation.properties.useMeshNormals !== false;
    block.useMeshColor = operation.properties.useMeshColor === true;
    if (meshShape) block.source = meshShape(operation.properties);
    return { blocks: [block], inputs: { particle: block.particle, direction1: block.direction1, direction2: block.direction2 }, outputs: { out: block.output } };
  },
  "sprite.setup": ({ name, operation }) => {
    const block = new SlateSpriteSheetBlock(name);
    block.sheet = particleSpriteSheetSettings(operation.properties);
    return { blocks: [block], inputs: { particle: block.particle }, outputs: { out: block.output } };
  },
  "update.basicSprite": spine((name) => new SlateSpriteAnimateBlock(name)),
  "update.spriteCell": spine((name) => new SlateSpriteCellBlock(name), (block) => ({ cell: block.cell })),
  "trigger.spawn": ({ name, operation, spawn }) => {
    const block = new SlateSpawnBlock(name);
    block.sink = spawn?.(operation.properties) ?? null;
    return { blocks: [block], inputs: { particle: block.particle, condition: block.condition }, outputs: { out: block.output } };
  },
  "update.noise": ({ name, operation, noise }) => {
    const block = new SlateNoiseBlock(name);
    const textureGuid = typeof operation.properties.textureGuid === "string" && operation.properties.textureGuid ? operation.properties.textureGuid : null;
    block.source = noise?.(textureGuid) ?? BUILTIN_PARTICLE_NOISE;
    return { blocks: [block], inputs: { particle: block.particle, strength: block.strength }, outputs: { out: block.output } };
  },
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
  "input.contextual.angleDegrees": ({ name }) => {
    const angle = contextualBlock(`${name}/radians`, NodeParticleContextualSources.Angle);
    const degrees = new ParticleTrigonometryBlock(name);
    degrees.operation = ParticleTrigonometryBlockOperations.ToDegrees;
    angle.output.connectTo(degrees.input, true);
    return { blocks: [degrees, angle], inputs: {}, outputs: { out: degrees.output } };
  },
  "input.system.time": systemValue(NodeParticleSystemSources.Time),
  "input.system.deltaTime": systemValue(NodeParticleSystemSources.Delta),
  "input.system.emitterPosition": systemValue(NodeParticleSystemSources.Emitter),
  "input.system.cameraPosition": systemValue(NodeParticleSystemSources.CameraPosition),
  "const.float": constant("float"),
  "const.vec2": constant("vec2"),
  "const.vec3": constant("vec3"),
  "const.color": constant("color"),
  "global.parameter": ({ name, operation, globalParameters }): ParticleBlockRealization => {
    // Without a parameter the node has no output, so nothing reads it.
    const selection = globalParameterSelection(operation.properties);
    if (!selection) return { blocks: [], inputs: {}, outputs: {} };
    const block = new GlobalParameterInputBlock(name, selection, globalParameters ?? globalParameterDefaults);
    return { blocks: [block], inputs: {}, outputs: { out: block.output } };
  },
  "input.parameter": ({ name, operation, parameters }) => {
    const parameter = parameters.get(String(operation.properties.parameterId ?? ""));
    if (!parameter) throw new Error("The Parameter node's parameter does not exist.");
    const block = particleConstantBlock(name, parameter.type, parameter.defaultValue);
    return { blocks: [block], inputs: {}, outputs: { out: block.output } };
  },
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
  "math.nlerp": ({ name }) => {
    const block = new ParticleNLerpBlock(name);
    return { blocks: [block], inputs: { a: block.left, b: block.right, alpha: block.gradient }, outputs: { out: block.output } };
  },
  "utility.localVariable": ({ name, operation }) => {
    const block = new SlateLocalVariableBlock(name);
    block.scope = operation.properties.scope === "loop" ? ParticleLocalVariableBlockScope.Loop : ParticleLocalVariableBlockScope.Particle;
    return { blocks: [block], inputs: { value: block.input }, outputs: { out: block.output } };
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
  "math.cosDegrees": unaryChain(ParticleTrigonometryBlockOperations.ToRadians, ParticleTrigonometryBlockOperations.Cos),
  "math.sin": unary(ParticleTrigonometryBlockOperations.Sin),
  "math.sinDegrees": unaryChain(ParticleTrigonometryBlockOperations.ToRadians, ParticleTrigonometryBlockOperations.Sin),
  "math.abs": unary(ParticleTrigonometryBlockOperations.Abs),
  "math.exp": unary(ParticleTrigonometryBlockOperations.Exp),
  "math.exp2": unary(ParticleTrigonometryBlockOperations.Exp2),
  "math.round": unary(ParticleTrigonometryBlockOperations.Round),
  "math.floor": unary(ParticleTrigonometryBlockOperations.Floor),
  "math.ceil": unary(ParticleTrigonometryBlockOperations.Ceiling),
  "math.sqrt": unary(ParticleTrigonometryBlockOperations.Sqrt),
  "math.log": unary(ParticleTrigonometryBlockOperations.Log),
  "math.tan": unary(ParticleTrigonometryBlockOperations.Tan),
  "math.tanDegrees": unaryChain(ParticleTrigonometryBlockOperations.ToRadians, ParticleTrigonometryBlockOperations.Tan),
  "math.atan": unary(ParticleTrigonometryBlockOperations.ArcTan),
  "math.atanDegrees": unaryChain(ParticleTrigonometryBlockOperations.ArcTan, ParticleTrigonometryBlockOperations.ToDegrees),
  "math.acos": unary(ParticleTrigonometryBlockOperations.ArcCos),
  "math.acosDegrees": unaryChain(ParticleTrigonometryBlockOperations.ArcCos, ParticleTrigonometryBlockOperations.ToDegrees),
  "math.asin": unary(ParticleTrigonometryBlockOperations.ArcSin),
  "math.asinDegrees": unaryChain(ParticleTrigonometryBlockOperations.ArcSin, ParticleTrigonometryBlockOperations.ToDegrees),
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
