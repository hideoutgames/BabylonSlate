import { Color4 } from "@babylonjs/core/Maths/math.color";
import { assetContentHash } from "@haptic/assets";
import { Vector2, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { ParticleClampBlock } from "@babylonjs/core/Particles/Node/Blocks/particleClampBlock";
import { ParticleGradientBlock } from "@babylonjs/core/Particles/Node/Blocks/particleGradientBlock";
import type { ParticleGradientValueBlock } from "@babylonjs/core/Particles/Node/Blocks/particleGradientValueBlock";
import { ParticleInputBlock } from "@babylonjs/core/Particles/Node/Blocks/particleInputBlock";
import { ParticleLerpBlock } from "@babylonjs/core/Particles/Node/Blocks/particleLerpBlock";
import { ParticleMathBlock, ParticleMathBlockOperations } from "@babylonjs/core/Particles/Node/Blocks/particleMathBlock";
import { ParticleNLerpBlock } from "@babylonjs/core/Particles/Node/Blocks/particleNLerpBlock";
import {
  ParticleTrigonometryBlock,
  ParticleTrigonometryBlockOperations as Trig,
} from "@babylonjs/core/Particles/Node/Blocks/particleTrigonometryBlock";
import { UpdateAngleBlock } from "@babylonjs/core/Particles/Node/Blocks/Update/updateAngleBlock";
import { UpdateColorBlock } from "@babylonjs/core/Particles/Node/Blocks/Update/updateColorBlock";
import { UpdateDirectionBlock } from "@babylonjs/core/Particles/Node/Blocks/Update/updateDirectionBlock";
import { UpdatePositionBlock } from "@babylonjs/core/Particles/Node/Blocks/Update/updatePositionBlock";
import { UpdateScaleBlock } from "@babylonjs/core/Particles/Node/Blocks/Update/updateScaleBlock";
import { UpdateSizeBlock } from "@babylonjs/core/Particles/Node/Blocks/Update/updateSizeBlock";
import { NodeParticleBlockConnectionPointTypes as Types } from "@babylonjs/core/Particles/Node/Enums/nodeParticleBlockConnectionPointTypes";
import { NodeParticleContextualSources as Contextual } from "@babylonjs/core/Particles/Node/Enums/nodeParticleContextualSources";
import { NodeParticleSystemSources as SystemSources } from "@babylonjs/core/Particles/Node/Enums/nodeParticleSystemSources";
import type { NodeParticleBlock } from "@babylonjs/core/Particles/Node/nodeParticleBlock";
import type { NodeParticleConnectionPoint } from "@babylonjs/core/Particles/Node/nodeParticleBlockConnectionPoint";
import type { NodeParticleBuildState } from "@babylonjs/core/Particles/Node/nodeParticleBuildState";
import type { Particle } from "@babylonjs/core/Particles/particle";
import type { ThinParticleSystem } from "@babylonjs/core/Particles/thinParticleSystem";

/**
 * Value-identical, faster replacements for the per-particle update closures Babylon 9.29's node particle blocks build.
 *
 * Babylon evaluates a Particle Graph by pulling: an update block's queue item reads its input port, which calls the
 * producing block's closure, which reads its own ports the same way, re-resolving on every read what a built graph
 * never changes (which port is connected, the port's type, the block's operation, a getter per port) and allocating a
 * vector or colour per operation. Here each queue item of a block below becomes one kernel: the reads its process makes,
 * as straight-line JavaScript in the same order, with the same number of reads of every producer (a Random or a
 * contextual source that writes as it reads is read as often as before) and the same arithmetic, operand by operand, so
 * a seeded run is bit-identical, its random sequence included (`particle-graph-realize.test.ts`).
 *
 * One generator writes every kernel's source (`ProgramBuilder`: an instruction list, each instruction one statement,
 * `kernelSource`). Where the source becomes a function is the host's (`ParticleUpdateKernels`): Editor Play evaluates
 * it with `new Function` (`functionParticleUpdateKernels`, live recompilation); an exported game finds the identical
 * source, written at export into its static scripts module, by its key (`staticParticleUpdateKernels`), so games
 * evaluate no text. A block without a kernel keeps Babylon's process.
 *
 * - A pure producer (an Input that reads without writing, and Math, Clamp, Gradient, Lerp, NLerp and Trigonometry over
 *   pure producers) is evaluated once per call however many reads reach it: Babylon re-evaluates it per read, which a
 *   graph whose values fan out and meet again (a diamond) repeats exponentially. Its value is the same either way.
 * - A queue item whose kernel would hold more than `PARTICLE_MAX_EMITTED_STATEMENTS` statements (impure reads still
 *   expand per read) keeps Babylon's process, with a warning.
 * - Math truncates its result only when its output is an Int. Babylon truncates whenever the left input is an Int,
 *   which turns an Int times a vector into 0 and drops an Int times a Float's fraction.
 * - Generated code, not composed closures: closures made from one function literal share its inline caches, so a graph
 *   of them calls through megamorphic sites V8 cannot inline, which costs most of what resolving the reads saves.
 * - Any other producer is read through Babylon's own `getConnectedValue`, and any other queue item keeps its process.
 * - What a read takes from a block (an Input's `value`, a Clamp's bounds, a Gradient stop's reference) is read on every
 *   call, so parameters written while the system runs apply as before.
 * - A vector or colour result goes into an object the read site owns, made once; Babylon makes a new one per read. Each
 *   is consumed (copied, or combined component by component) before the site runs again, and no kernel hands one to
 *   anything that could keep it.
 */

/** Most statements one kernel holds (`ParticleUpdateTooLarge`). */
export const PARTICLE_MAX_EMITTED_STATEMENTS = 4096;

/** A queue item's kernel would hold more than `PARTICLE_MAX_EMITTED_STATEMENTS` statements. */
class ParticleUpdateTooLarge extends Error {}

type State = NodeParticleBuildState;
type Process = (particle: Particle, system: ThinParticleSystem) => void;
type QueueItem = { process: Process; nextItem: QueueItem | null };

const isScalar = (type: Types) => type === Types.Float || type === Types.Int;

/*
 * The instructions the generator records, each written as one statement (`statement`). `f` names a scalar local, `o`
 * an object local (vectors, colours and whatever Babylon's own reads return), `k` a constant and `r` an entry of the
 * kernel's referenced blocks and ports (`R<n>`).
 */
const K = 0; // f, k: f = k
const BLOCK_VALUE = 1; // f, r: f = r.value
const BLOCK_VALUE_O = 2; // o, r: o = r.value
const MINIMUM = 3; // f, r: f = r.minimum
const MAXIMUM = 4; // f, r: f = r.maximum
const REFERENCE = 5; // f, r: f = r.reference
const CONNECTED = 6; // f, r: f = r.getConnectedValue(state)
const CONNECTED_O = 7; // o, r
const SYSTEM_VALUE = 8; // f, source: f = state.getSystemValue(source)
const SYSTEM_VALUE_O = 9; // o, source
const CONTEXT_VALUE = 10; // f, source: f = state.getContextualValue(source)
const CONTEXT_VALUE_O = 11; // o, source
const CONTEXT = 12; // f, source: a contextual source read straight off the particle or system (`contextual`)
const CONTEXT_O = 13; // o, source
const COMPONENT_X = 14; // f, o: f = o.x (COMPONENT_Y to COMPONENT_A below read .y to .a, each a named read)
const ADD = 15, SUBTRACT = 16, MULTIPLY = 17, DIVIDE = 18, MIN = 19, MAX = 20; // f, a, b
const TRUNCATE = 21; // f, a: f = a | 0
const TRUNCATE_O = 22; // f, o: f = o | 0
const OR_ZERO = 23; // f, a: f = a || 0
const OR_ZERO_O = 24; // o, src: o = src || 0
const CLAMP = 25; // f, v, min, max: f = Math.max(min, Math.min(v, max))
const MIX = 26; // f, a, b, t: f = (1 - t) * a + t * b
const STOP_LERP = 27; // f, a, b, s: f = a + (b - a) * s
const STOP_SCALE = 28; // f, g, r, next: f = Math.max(0, Math.min(1, (g - r) / (next - r)))
const LENGTH4 = 29; // f, o: f = Math.sqrt(o.r * o.r + o.g * o.g + o.b * o.b + o.a * o.a)
const SET2 = 30; // o, a, b: o.x = a; o.y = b
const SET3 = 31; // o, a, b, c: o.set(a, b, c)
const SET4 = 32; // o, a, b, c, d: o.r = a; o.g = b; o.b = c; o.a = d
const NORMALIZE = 33; // o: o.normalize()
const SCALE_UNLESS_ZERO = 34; // o, length: if (length !== 0) o.scaleInPlace(1 / length)
const MOVE = 35; // f, src
const MOVE_O = 36; // o, src
const ZERO_O = 37; // o: o = 0
const WRITE_COLOR = 40, WRITE_DIRECTION = 41, WRITE_POSITION = 42, WRITE_SCALE = 43; // o: particle.<field>.copyFrom(o)
const WRITE_SIZE = 44, WRITE_ANGLE = 45; // f: particle.<field> = f
// Babylon's `ParticleTrigonometryBlock` functions: f, a.
const COS = 46, SIN = 47, ABS = 48, EXP = 49, EXP2 = 50, ROUND = 51, FLOOR = 52, CEILING = 53, SQRT = 54, LOG = 55,
  TAN = 56, ARC_TAN = 57, ARC_COS = 58, ARC_SIN = 59, SIGN = 60, NEGATE = 61, ONE_MINUS = 62, RECIPROCAL = 63,
  TO_RADIANS = 64, TO_DEGREES = 65, FRACT = 66;

// f, o: one opcode per component, each a named property read (a read keyed by the name would be megamorphic).
const COMPONENT_Y = 67, COMPONENT_Z = 68, COMPONENT_R = 69, COMPONENT_G = 70, COMPONENT_B = 71, COMPONENT_A = 72;
// f: the sources most graphs read, each its own opcode rather than a `contextual` call.
const TIME = 73, DELTA = 74, AGE = 75, LIFETIME = 76, AGE_GRADIENT = 77, SIZE = 78, ANGLE = 79;
/** The scalar contextual sources with an opcode of their own. */
const SCALAR_SOURCES: Partial<Record<Contextual, number>> = {
  [Contextual.Age]: AGE, [Contextual.Lifetime]: LIFETIME, [Contextual.AgeGradient]: AGE_GRADIENT,
  [Contextual.Size]: SIZE, [Contextual.Angle]: ANGLE,
};
/** The read of each component, by `COMPONENTS` index (x, y, z, r, g, b, a). */
const COMPONENT_READS = [COMPONENT_X, COMPONENT_Y, COMPONENT_Z, COMPONENT_R, COMPONENT_G, COMPONENT_B, COMPONENT_A];

const TRIGONOMETRY: Partial<Record<Trig, number>> = {
  [Trig.Cos]: COS, [Trig.Sin]: SIN, [Trig.Abs]: ABS, [Trig.Exp]: EXP, [Trig.Exp2]: EXP2, [Trig.Round]: ROUND,
  [Trig.Floor]: FLOOR, [Trig.Ceiling]: CEILING, [Trig.Sqrt]: SQRT, [Trig.Log]: LOG, [Trig.Tan]: TAN,
  [Trig.ArcTan]: ARC_TAN, [Trig.ArcCos]: ARC_COS, [Trig.ArcSin]: ARC_SIN, [Trig.Sign]: SIGN, [Trig.Negate]: NEGATE,
  [Trig.OneMinus]: ONE_MINUS, [Trig.Reciprocal]: RECIPROCAL, [Trig.ToRadians]: TO_RADIANS, [Trig.ToDegrees]: TO_DEGREES,
  [Trig.Fract]: FRACT,
};

const COMPONENTS: Partial<Record<Types, readonly number[]>> = {
  [Types.Vector2]: [0, 1],
  [Types.Vector3]: [0, 1, 2],
  [Types.Color4]: [3, 4, 5, 6],
};

/** The contextual sources read straight off the particle or system, as `NodeParticleBuildState.getContextualValue` reads them. */
const CONTEXTUAL = new Set<Contextual>([
  Contextual.Position, Contextual.Direction, Contextual.DirectionScale, Contextual.Color, Contextual.InitialColor,
  Contextual.ColorDead, Contextual.Age, Contextual.Lifetime, Contextual.Angle, Contextual.Scale, Contextual.Size,
  Contextual.AgeGradient, Contextual.SpriteCellEnd, Contextual.SpriteCellIndex, Contextual.SpriteCellStart,
  Contextual.InitialDirection, Contextual.ColorStep,
]);

/** The contextual sources read straight off the particle or system, as `NodeParticleBuildState.getContextualValue` reads them. */
const CONTEXT_EXPRESSIONS: Partial<Record<Contextual, string>> = {
  [Contextual.Position]: "particle.position",
  [Contextual.Direction]: "particle.direction",
  [Contextual.DirectionScale]: "particle._properties.directionScale",
  [Contextual.Color]: "particle.color",
  [Contextual.InitialColor]: "particle.initialColor",
  [Contextual.ColorDead]: "particle.colorDead",
  [Contextual.Age]: "particle.age",
  [Contextual.Lifetime]: "particle.lifeTime",
  [Contextual.Angle]: "particle.angle",
  [Contextual.Scale]: "particle.scale",
  [Contextual.Size]: "particle.size",
  [Contextual.AgeGradient]: "(particle.age / particle.lifeTime)",
  [Contextual.SpriteCellEnd]: "system.endSpriteCellID",
  [Contextual.SpriteCellIndex]: "particle.cellIndex",
  [Contextual.SpriteCellStart]: "system.startSpriteCellID",
  [Contextual.InitialDirection]: "particle._properties.initialDirection",
  [Contextual.ColorStep]: "particle.colorStep",
};

/** A number as a JavaScript literal that reads back as the same double. */
function literal(value: number): string {
  if (Object.is(value, -0)) return "-0";
  if (Number.isNaN(value)) return "NaN";
  if (!Number.isFinite(value)) return value > 0 ? "Infinity" : "-Infinity";
  return String(value);
}

/**
 * One instruction as the JavaScript statement a kernel runs in its place: the same reads and the same arithmetic,
 * operand by operand, in the same order (`run` is the reference). Jumps have none: `gradient` writes their branches.
 */
function statement(opcode: number, [a = 0, b = 0, c = 0, d = 0, e = 0]: readonly number[], constants: readonly number[]): string {
  const f = (register: number) => `f${register}`, o = (register: number) => `o${register}`;
  const unary = (expression: (v: string) => string) => `${f(a)} = ${expression(f(b))};`;
  switch (opcode) {
    case K: return `${f(a)} = ${literal(constants[b]!)};`;
    case BLOCK_VALUE: return `${f(a)} = R${b}.value;`;
    case BLOCK_VALUE_O: return `${o(a)} = R${b}.value;`;
    case MINIMUM: return `${f(a)} = R${b}.minimum;`;
    case MAXIMUM: return `${f(a)} = R${b}.maximum;`;
    case REFERENCE: return `${f(a)} = R${b}.reference;`;
    case CONNECTED: return `${f(a)} = R${b}.getConnectedValue(state);`;
    case CONNECTED_O: return `${o(a)} = R${b}.getConnectedValue(state);`;
    case SYSTEM_VALUE: return `${f(a)} = state.getSystemValue(${b});`;
    case SYSTEM_VALUE_O: return `${o(a)} = state.getSystemValue(${b});`;
    case CONTEXT_VALUE: return `${f(a)} = state.getContextualValue(${b});`;
    case CONTEXT_VALUE_O: return `${o(a)} = state.getContextualValue(${b});`;
    case CONTEXT: return `${f(a)} = ${CONTEXT_EXPRESSIONS[b as Contextual]};`;
    case CONTEXT_O: return `${o(a)} = ${CONTEXT_EXPRESSIONS[b as Contextual]};`;
    case TIME: return `${f(a)} = system._actualFrame;`;
    case DELTA: return `${f(a)} = system._scaledUpdateSpeed;`;
    case AGE: return `${f(a)} = particle.age;`;
    case LIFETIME: return `${f(a)} = particle.lifeTime;`;
    case AGE_GRADIENT: return `${f(a)} = particle.age / particle.lifeTime;`;
    case SIZE: return `${f(a)} = particle.size;`;
    case ANGLE: return `${f(a)} = particle.angle;`;
    case COMPONENT_X: return `${f(a)} = ${o(b)}.x;`;
    case COMPONENT_Y: return `${f(a)} = ${o(b)}.y;`;
    case COMPONENT_Z: return `${f(a)} = ${o(b)}.z;`;
    case COMPONENT_R: return `${f(a)} = ${o(b)}.r;`;
    case COMPONENT_G: return `${f(a)} = ${o(b)}.g;`;
    case COMPONENT_B: return `${f(a)} = ${o(b)}.b;`;
    case COMPONENT_A: return `${f(a)} = ${o(b)}.a;`;
    case ADD: return `${f(a)} = ${f(b)} + ${f(c)};`;
    case SUBTRACT: return `${f(a)} = ${f(b)} - ${f(c)};`;
    case MULTIPLY: return `${f(a)} = ${f(b)} * ${f(c)};`;
    case DIVIDE: return `${f(a)} = ${f(b)} / ${f(c)};`;
    case MIN: return `${f(a)} = Math.min(${f(b)}, ${f(c)});`;
    case MAX: return `${f(a)} = Math.max(${f(b)}, ${f(c)});`;
    case TRUNCATE: return `${f(a)} = ${f(b)} | 0;`;
    case TRUNCATE_O: return `${f(a)} = ${o(b)} | 0;`;
    case OR_ZERO: return `${f(a)} = ${f(b)} || 0;`;
    case OR_ZERO_O: return `${o(a)} = ${o(b)} || 0;`;
    case CLAMP: return `${f(a)} = Math.max(${f(c)}, Math.min(${f(b)}, ${f(d)}));`;
    case MIX: return `${f(a)} = (1 - ${f(d)}) * ${f(b)} + ${f(d)} * ${f(c)};`;
    case STOP_LERP: return `${f(a)} = ${f(b)} + (${f(c)} - ${f(b)}) * ${f(d)};`;
    case STOP_SCALE: return `${f(a)} = Math.max(0, Math.min(1, (${f(b)} - ${f(c)}) / (${f(d)} - ${f(c)})));`;
    case LENGTH4: return `${f(a)} = Math.sqrt(${o(b)}.r * ${o(b)}.r + ${o(b)}.g * ${o(b)}.g + ${o(b)}.b * ${o(b)}.b + ${o(b)}.a * ${o(b)}.a);`;
    case SET2: return `${o(a)}.x = ${f(b)}; ${o(a)}.y = ${f(c)};`;
    case SET3: return `${o(a)}.set(${f(b)}, ${f(c)}, ${f(d)});`;
    case SET4: return `${o(a)}.r = ${f(b)}; ${o(a)}.g = ${f(c)}; ${o(a)}.b = ${f(d)}; ${o(a)}.a = ${f(e)};`;
    case NORMALIZE: return `${o(a)}.normalize();`;
    case SCALE_UNLESS_ZERO: return `if (${f(b)} !== 0) ${o(a)}.scaleInPlace(1 / ${f(b)});`;
    case MOVE: return `${f(a)} = ${f(b)};`;
    case MOVE_O: return `${o(a)} = ${o(b)};`;
    case ZERO_O: return `${o(a)} = 0;`;
    case WRITE_COLOR: return `particle.color.copyFrom(${o(a)});`;
    case WRITE_DIRECTION: return `particle.direction.copyFrom(${o(a)});`;
    case WRITE_POSITION: return `particle.position.copyFrom(${o(a)});`;
    case WRITE_SCALE: return `particle.scale.copyFrom(${o(a)});`;
    case WRITE_SIZE: return `particle.size = ${f(a)};`;
    case WRITE_ANGLE: return `particle.angle = ${f(a)};`;
    case COS: return unary((v) => `Math.cos(${v})`);
    case SIN: return unary((v) => `Math.sin(${v})`);
    case ABS: return unary((v) => `Math.abs(${v})`);
    case EXP: return unary((v) => `Math.exp(${v})`);
    case EXP2: return unary((v) => `Math.pow(2, ${v})`);
    case ROUND: return unary((v) => `Math.round(${v})`);
    case FLOOR: return unary((v) => `Math.floor(${v})`);
    case CEILING: return unary((v) => `Math.ceil(${v})`);
    case SQRT: return unary((v) => `Math.sqrt(${v})`);
    case LOG: return unary((v) => `Math.log(${v})`);
    case TAN: return unary((v) => `Math.tan(${v})`);
    case ARC_TAN: return unary((v) => `Math.atan(${v})`);
    case ARC_COS: return unary((v) => `Math.acos(${v})`);
    case ARC_SIN: return unary((v) => `Math.asin(${v})`);
    case SIGN: return unary((v) => `Math.sign(${v})`);
    case NEGATE: return unary((v) => `-${v}`);
    case ONE_MINUS: return unary((v) => `1 - ${v}`);
    case RECIPROCAL: return unary((v) => `1 / ${v}`);
    case TO_RADIANS: return unary((v) => `(${v} * Math.PI) / 180`);
    case TO_DEGREES: return unary((v) => `(${v} * 180) / Math.PI`);
    case FRACT: return unary((v) => `${v} >= 0 ? ${v} - Math.floor(${v}) : ${v} - Math.ceil(${v})`);
  }
  throw new Error(`No kernel statement for opcode ${opcode}.`);
}

/** A value of the program: a scalar register (`f`) or an object register (`o`). */
type Value = { f: number } | { o: number };
const scalarOf = (value: Value): number => {
  if (!("f" in value)) throw new Error("A scalar read took an object value.");
  return value.f;
};
const objectOf = (value: Value): number => {
  if (!("o" in value)) throw new Error("A vector read took a scalar value.");
  return value.o;
};

/** Builds one queue item's kernel: what each read of Babylon's process makes, in the same order. */
class ProgramBuilder {
  private readonly constants: number[] = [];
  /** Ports and blocks the code reads every call (a value, bounds, a stop's reference). */
  readonly refs: unknown[] = [];
  /** What each object register starts as: the read sites' own result objects, made once. */
  private readonly objects: unknown[] = [];
  private scalars = 0;
  private instructions = 0;
  /** The kernel's statements, one per instruction (`statement`), and the branches `gradient` writes. */
  private readonly lines: string[] = [];
  /** Reads emitted so far that may write as they read (Babylon's own, and writing contextual sources). */
  private impureReads = 0;
  /**
   * The value of each pure producer (by output port), per branch the code has open, innermost last: a value computed
   * in a branch is not known after it.
   */
  private readonly scopes: Map<NodeParticleConnectionPoint, Value>[] = [new Map()];

  /** Appends one instruction's statement, refusing to grow past `PARTICLE_MAX_EMITTED_STATEMENTS`. */
  op(opcode: number, ...operands: number[]): void {
    this.line(statement(opcode, operands, this.constants));
  }

  /** Appends one statement or branch line, refusing to grow past `PARTICLE_MAX_EMITTED_STATEMENTS`. */
  line(text: string): void {
    if (this.instructions >= PARTICLE_MAX_EMITTED_STATEMENTS) throw new ParticleUpdateTooLarge();
    this.instructions += 1;
    this.lines.push(text);
  }

  openScope(): void {
    this.scopes.push(new Map());
  }

  closeScope(): void {
    this.scopes.pop();
  }

  private known(output: NodeParticleConnectionPoint): Value | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const value = this.scopes[i]!.get(output);
      if (value !== undefined) return value;
    }
    return undefined;
  }

  ref(value: unknown): number {
    let index = this.refs.indexOf(value);
    if (index < 0) index = this.refs.push(value) - 1;
    return index;
  }

  scalar(): number {
    return this.scalars++;
  }

  object(initial: unknown = undefined): number {
    return this.objects.push(initial) - 1;
  }

  constant(value: number): number {
    let index = this.constants.indexOf(value);
    if (index < 0) index = this.constants.push(value) - 1;
    return index;
  }

  /** A scalar computed by `opcode` over `operands`. */
  scalarOp(opcode: number, ...operands: number[]): Value {
    const f = this.scalar();
    this.op(opcode, f, ...operands);
    return { f };
  }

  /** An object register set by `opcode` over `operands`. */
  objectOp(opcode: number, ...operands: number[]): Value {
    const o = this.object();
    this.op(opcode, o, ...operands);
    return { o };
  }

  /** A read site's own result object of `type`, made at compile time. */
  result(type: Types): number {
    switch (type) {
      case Types.Vector2: return this.object(new Vector2());
      case Types.Vector3: return this.object(new Vector3());
      case Types.Color4: return this.object(new Color4());
    }
    throw new Error(`No result object for type ${type}.`);
  }

  /** Writes one scalar per component of `type` into `target`; every component is computed before the first is written. */
  store(type: Types, target: number, components: readonly number[]): void {
    if (type === Types.Vector2) this.op(SET2, target, components[0]!, components[1]!);
    else if (type === Types.Vector3) this.op(SET3, target, components[0]!, components[1]!, components[2]!);
    else this.op(SET4, target, components[0]!, components[1]!, components[2]!, components[3]!);
  }

  component(value: Value, component: number): number {
    return scalarOf(this.scalarOp(COMPONENT_READS[component]!, objectOf(value)));
  }

  /** The value `port.getConnectedValue(state)` gives. */
  read(port: NodeParticleConnectionPoint): Value {
    const source = port.connectedPoint;
    if (source && source._storedFunction) {
      const known = this.known(source);
      if (known !== undefined) return known;
      const impureBefore = this.impureReads;
      const compiled = this.output(source);
      if (compiled !== null) {
        // Nothing under it writes as it reads: every later read in this scope takes the same value.
        if (this.impureReads === impureBefore) this.scopes.at(-1)!.set(source, compiled);
        return compiled;
      }
    }
    const scalar = isScalar(port.type);
    if (!source && !port.isConnected) return scalar ? this.scalarOp(BLOCK_VALUE, this.ref(port)) : this.objectOp(BLOCK_VALUE_O, this.ref(port));
    this.impureReads += 1;
    return scalar ? this.scalarOp(CONNECTED, this.ref(port)) : this.objectOp(CONNECTED_O, this.ref(port));
  }

  private output(output: NodeParticleConnectionPoint): Value | null {
    const block = output.ownerBlock;
    if (block instanceof ParticleInputBlock) return this.input(block);
    if (block instanceof ParticleMathBlock) return this.math(block);
    if (block instanceof ParticleClampBlock) return this.clamp(block);
    if (block instanceof ParticleGradientBlock) return this.gradient(block);
    if (block instanceof ParticleLerpBlock) return this.lerp(block, false);
    if (block instanceof ParticleNLerpBlock) return this.lerp(block, true);
    if (block instanceof ParticleTrigonometryBlock) return this.trigonometry(block);
    return null;
  }

  private input(block: ParticleInputBlock): Value {
    const internals = block as unknown as { _contextualSource: Contextual; _systemSource: SystemSources };
    const scalar = isScalar(block.type);
    if (block.isSystemSource) {
      switch (internals._systemSource) {
        case SystemSources.Time: return this.scalarOp(TIME);
        case SystemSources.Delta: return this.scalarOp(DELTA);
      }
      this.impureReads += 1;
      return scalar ? this.scalarOp(SYSTEM_VALUE, internals._systemSource) : this.objectOp(SYSTEM_VALUE_O, internals._systemSource);
    }
    if (block.isContextual) {
      const source = internals._contextualSource;
      if (CONTEXTUAL.has(source)) {
        const own = SCALAR_SOURCES[source];
        if (scalar && own !== undefined) return this.scalarOp(own);
        return scalar ? this.scalarOp(CONTEXT, source) : this.objectOp(CONTEXT_O, source);
      }
      // Sources that write as they read (scaled direction, colour step, local position) keep Babylon's own code.
      this.impureReads += 1;
      return scalar ? this.scalarOp(CONTEXT_VALUE, source) : this.objectOp(CONTEXT_VALUE_O, source);
    }
    return scalar ? this.scalarOp(BLOCK_VALUE, this.ref(block)) : this.objectOp(BLOCK_VALUE_O, this.ref(block));
  }

  private math(block: ParticleMathBlock): Value | null {
    const { left, right, operation } = block;
    if (!left.isConnected || !right.isConnected) return null;
    const leftScalar = isScalar(left.type), rightScalar = isScalar(right.type);
    const symbol = { [ParticleMathBlockOperations.Add]: ADD, [ParticleMathBlockOperations.Subtract]: SUBTRACT,
      [ParticleMathBlockOperations.Multiply]: MULTIPLY, [ParticleMathBlockOperations.Divide]: DIVIDE }[operation as number];
    const minMax = operation === ParticleMathBlockOperations.Min ? MIN : operation === ParticleMathBlockOperations.Max ? MAX : null;
    // An Int result is truncated; a Float or vector one is not (where Babylon truncates whenever the left input is an Int).
    const truncate = (value: Value): Value => {
      if (block.output.type !== Types.Int) return value;
      return "f" in value ? this.scalarOp(TRUNCATE, value.f) : this.scalarOp(TRUNCATE_O, value.o);
    };
    if (leftScalar && rightScalar) {
      // Decided before any read: a read emitted and then left to Babylon would be made twice.
      const opcode = symbol ?? minMax;
      if (opcode === undefined || opcode === null) return null;
      const a = scalarOf(this.read(left)), b = scalarOf(this.read(right));
      return truncate(this.scalarOp(opcode, a, b));
    }
    // Arithmetic between a vector or colour and a scalar or one of its own type; Min and Max between vectors, and
    // anything Babylon would throw on (a colour's division), keep Babylon's.
    if (symbol === undefined) return null;
    const type = leftScalar ? right.type : left.type;
    const components = COMPONENTS[type];
    if (!components || (!leftScalar && !rightScalar && left.type !== right.type)) return null;
    if (type === Types.Color4 && operation === ParticleMathBlockOperations.Divide) return null;
    // Babylon adapts the scalar side (the right one when both are vectors) through `state.adapt`, which reads it
    // `|| 0` and spreads a scalar to every component; the other side is read as it is.
    const operand = (port: NodeParticleConnectionPoint, scalar: boolean, adapted: boolean) => {
      let value = this.read(port);
      if (adapted) value = "f" in value ? this.scalarOp(OR_ZERO, value.f) : this.objectOp(OR_ZERO_O, value.o);
      return (component: number) => (scalar ? scalarOf(value) : this.component(value, component));
    };
    const a = operand(left, leftScalar, leftScalar), b = operand(right, rightScalar, !leftScalar);
    const out = this.result(type);
    this.store(type, out, components.map((component) => scalarOf(this.scalarOp(symbol, a(component), b(component)))));
    return truncate({ o: out });
  }

  private clamp(block: ParticleClampBlock): Value | null {
    if (!block.value.isConnected) return null;
    const type = block.value.type;
    const components = COMPONENTS[type];
    if (!isScalar(type) && !components) return null;
    const value = this.read(block.value);
    const min = block.min.isConnected ? scalarOf(this.read(block.min)) : scalarOf(this.scalarOp(MINIMUM, this.ref(block)));
    const max = block.max.isConnected ? scalarOf(this.read(block.max)) : scalarOf(this.scalarOp(MAXIMUM, this.ref(block)));
    if (!components) return this.scalarOp(CLAMP, scalarOf(value), min, max);
    const out = this.result(type);
    this.store(type, out, components.map((component) => scalarOf(this.scalarOp(CLAMP, this.component(value, component), min, max))));
    return { o: out };
  }

  private gradient(block: ParticleGradientBlock): Value {
    const entries: ParticleGradientValueBlock[] = [];
    for (let i = 1; i < block.inputs.length; i++) {
      const port = block.inputs[i]!;
      if (port.isConnected) entries.push(port.connectedPoint!.ownerBlock as ParticleGradientValueBlock);
    }
    // Babylon sorts by reference once, at build.
    entries.sort((a, b) => a.reference - b.reference);
    const gradient = scalarOf(this.read(block.gradient));
    const type = block.output.type;
    const scalar = isScalar(type);
    const result: Value = scalar ? { f: this.scalar() } : { o: this.object() };
    const assign = (value: Value) => {
      if ("f" in result) this.op(MOVE, result.f, scalarOf(value));
      else this.op(MOVE_O, result.o, objectOf(value));
    };
    if (entries.length === 1) {
      assign(this.read(entries[0]!.value));
      return result;
    }
    const components = COMPONENTS[type];
    // Babylon's walk down the entries: the first whose reference is at most the gradient, interpolated towards the
    // entry after it. Each entry's value is read only on the branch Babylon reads it.
    const out = components ? this.result(type) : null;
    let opened = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]!;
      const reference = scalarOf(this.scalarOp(REFERENCE, this.ref(entry)));
      this.line(`if (f${reference} <= f${gradient}) {`);
      this.openScope();
      const current = this.read(entry.value);
      const following = entries[i + 1];
      if (!following) {
        assign(current);
      } else {
        const next = this.read(following.value);
        const nextReference = scalarOf(this.scalarOp(REFERENCE, this.ref(following)));
        const scale = scalarOf(this.scalarOp(STOP_SCALE, gradient, reference, nextReference));
        // Babylon's `Lerp`s: start + (end - start) * amount, per component; any other type keeps the current value.
        if (type === Types.Float) {
          assign(this.scalarOp(STOP_LERP, scalarOf(current), scalarOf(next), scale));
        } else if (components) {
          this.store(type, out!, components.map((component) =>
            scalarOf(this.scalarOp(STOP_LERP, this.component(current, component), this.component(next, component), scale))));
          assign({ o: out! });
        } else {
          assign(current);
        }
      }
      this.closeScope();
      this.line("} else {");
      this.openScope();
      opened += 1;
    }
    if ("f" in result) this.op(K, result.f, this.constant(0));
    else this.op(ZERO_O, result.o);
    this.line("}".repeat(opened));
    for (let i = 0; i < opened; i++) this.closeScope();
    return result;
  }

  private lerp(block: ParticleLerpBlock | ParticleNLerpBlock, normalize: boolean): Value | null {
    if (!block.left.isConnected || !block.right.isConnected) return null;
    const type = block.left.type;
    const components = COMPONENTS[type];
    const a = this.read(block.left), b = this.read(block.right), t = scalarOf(this.read(block.gradient));
    if (isScalar(type)) return this.scalarOp(MIX, scalarOf(a), scalarOf(b), t);
    if (!components) return this.objectOp(ZERO_O);
    const out = this.result(type);
    this.store(type, out, components.map((component) => scalarOf(this.scalarOp(MIX, this.component(a, component), this.component(b, component), t))));
    if (normalize) {
      if (type === Types.Color4) this.op(SCALE_UNLESS_ZERO, out, scalarOf(this.scalarOp(LENGTH4, out)));
      else this.op(NORMALIZE, out);
    }
    return { o: out };
  }

  private trigonometry(block: ParticleTrigonometryBlock): Value | null {
    const opcode = TRIGONOMETRY[block.operation];
    const type = block.input.type;
    const components = COMPONENTS[type];
    if (opcode === undefined || (!isScalar(type) && !components)) return null;
    const value = this.read(block.input);
    if (!components) return this.scalarOp(opcode, scalarOf(value));
    const out = this.result(type);
    const parts = components.map((component) => this.component(value, component));
    this.store(type, out, parts.map((part) => scalarOf(this.scalarOp(opcode, part))));
    return { o: out };
  }

  /**
   * The program as a kernel factory's source: `function (R, O, state, system)` returning the per-particle function. `R`
   * are the referenced ports and blocks and `O` the object registers' starting values (the read sites' own results);
   * every register is a local. Equal programs give equal sources, so the source is also the kernel's key.
   */
  kernelSource(): string {
    const refs = this.refs.map((_, index) => `R${index} = R[${index}]`);
    const objects = this.objects.flatMap((value, index) => (value === undefined ? [] : [`O${index} = O[${index}]`]));
    const scalars = Array.from({ length: this.scalars }, (_, index) => `f${index}`);
    const registers = this.objects.map((value, index) => (value === undefined ? `o${index}` : `o${index} = O${index}`));
    return [
      "function (R, O, state, system) {",
      ...(refs.length ? [`const ${refs.join(", ")};`] : []),
      ...(objects.length ? [`const ${objects.join(", ")};`] : []),
      "return function compiledParticleUpdate(particle) {",
      "state.particleContext = particle;",
      "state.systemContext = system;",
      ...(scalars.length ? [`let ${scalars.join(", ")};`] : []),
      ...(registers.length ? [`let ${registers.join(", ")};`] : []),
      ...this.lines,
      "};",
      "}",
    ].join("\n");
  }

  /** The referenced ports and blocks (`R`) and the object locals' starting values (`O`) a kernel factory takes. */
  bindings(): { refs: readonly unknown[]; objects: readonly unknown[] } {
    return { refs: this.refs, objects: [...this.objects] };
  }

  get size(): number {
    return this.instructions;
  }
}

/**
 * A compiled update's kernel factory (`ProgramBuilder.kernelSource`): given the program's referenced ports and blocks,
 * its object registers' starting values, the build state and the system, the per-particle update.
 */
export type ParticleUpdateKernel = (refs: readonly unknown[], objects: readonly unknown[], state: NodeParticleBuildState, system: ThinParticleSystem) => (particle: Particle) => void;

/**
 * Where compiled updates find their kernels, by the key of the kernel's source (`particleUpdateKernelKey`); `source`
 * makes it on demand. Null keeps Babylon's process. Editor Play compiles the source
 * (`functionParticleUpdateKernels`), an exported game looks the key up in its scripts module
 * (`staticParticleUpdateKernels`), and export records every source (`recordingParticleUpdateKernels`).
 */
export interface ParticleUpdateKernels {
  kernel(key: string, source: () => string): ParticleUpdateKernel | null;
}

const kernelText = new TextEncoder();

/** The key a kernel's source is found by: equal programs, equal keys. */
export function particleUpdateKernelKey(source: string): string {
  return `pk1:${assetContentHash(kernelText.encode(source))}`;
}

/**
 * An exported game's kernels: written at export into its scripts module and found by key. A block the export did not
 * see keeps Babylon's process, with one `[render]` warning per kernel.
 */
export function staticParticleUpdateKernels(kernels: Readonly<Record<string, ParticleUpdateKernel>>): ParticleUpdateKernels {
  const missing = new Set<string>();
  return {
    kernel(key) {
      if (Object.hasOwn(kernels, key)) return kernels[key]!;
      if (!missing.has(key)) {
        missing.add(key);
        console.warn(`[render] Particle update ${key} has no kernel in this game's scripts module; it keeps Babylon's evaluation.`);
      }
      return null;
    },
  };
}

/** Records each kernel's source by key (for the export's scripts module); the recorded system keeps Babylon's processes. */
export function recordingParticleUpdateKernels(sources: Map<string, string>): ParticleUpdateKernels {
  return { kernel: (key, source) => { if (!sources.has(key)) sources.set(key, source()); return null; } };
}

const sizes = new WeakMap<Process, number>();

/** Statements in the kernel a compiled process runs, or null for a process this module did not compile. */
export function compiledParticleUpdateSize(process: unknown): number | null {
  return sizes.get(process as Process) ?? null;
}

/**
 * The compiled process for the queue item `block` added, or null to keep Babylon's: its kernel from `kernels`, or none
 * (a block outside this module, past the cap, or with no kernel the host knows).
 */
function compileProcess(block: NodeParticleBlock, state: State, system: ThinParticleSystem, kernels: ParticleUpdateKernels | null): Process | null {
  const builder = new ProgramBuilder();
  if (block instanceof UpdateColorBlock) builder.op(WRITE_COLOR, objectOf(builder.read(block.color)));
  else if (block instanceof UpdateDirectionBlock) builder.op(WRITE_DIRECTION, objectOf(builder.read(block.direction)));
  else if (block instanceof UpdatePositionBlock) builder.op(WRITE_POSITION, objectOf(builder.read(block.position)));
  else if (block instanceof UpdateScaleBlock) builder.op(WRITE_SCALE, objectOf(builder.read(block.scale)));
  else if (block instanceof UpdateSizeBlock) builder.op(WRITE_SIZE, scalarOf(builder.read(block.size)));
  else if (block instanceof UpdateAngleBlock) builder.op(WRITE_ANGLE, scalarOf(builder.read(block.angle)));
  else return null;
  const source = builder.kernelSource();
  const kernel = kernels?.kernel(particleUpdateKernelKey(source), () => source) ?? null;
  if (!kernel) return null;
  const { refs, objects } = builder.bindings();
  const process: Process = kernel(refs, objects, state, system);
  sizes.set(process, builder.size);
  return process;
}

/**
 * Records which block added each of a system's update queue items while the graph builds (`track` around every
 * block's `_build`), then replaces the processes of the blocks this module compiles (`compile`).
 */
export class ParticleUpdateQueueOwners {
  private readonly owners = new Map<QueueItem, NodeParticleBlock>();

  /** Runs `build` for `block`, noting the queue item it appends to the system on its `particle` input, if any. */
  track<T>(block: NodeParticleBlock, build: () => T): T {
    const system = particleInputSystem(block);
    const before = system ? queueTail(system) : null;
    const result = build();
    const after = system ? queueTail(system) : null;
    if (after && after !== before) this.owners.set(after, block);
    return result;
  }

  /**
   * Replaces the process of every queue item of `system` whose block this module compiles, and returns how many.
   * `state` is the build state Babylon's processes were built with; the replacements set its particle and system
   * context as those do, for the producers still read through Babylon.
   */
  compile(system: ThinParticleSystem, state: State, kernels: ParticleUpdateKernels | null = null): number {
    let compiled = 0;
    for (let item = (system as unknown as { _updateQueueStart: QueueItem | null })._updateQueueStart; item; item = item.nextItem) {
      const block = this.owners.get(item);
      let process: Process | null;
      try {
        process = block ? compileProcess(block, state, system, kernels) : null;
      } catch (error) {
        // A step this module cannot generate keeps Babylon's process; the graph still builds.
        process = null;
        if (block && error instanceof ParticleUpdateTooLarge) {
          console.warn(`[render] Particle update "${block.name}" keeps Babylon's evaluation: its reads expand past ${PARTICLE_MAX_EMITTED_STATEMENTS} statements.`);
        }
      }
      if (!process) continue;
      item.process = process;
      compiled += 1;
    }
    return compiled;
  }
}

function particleInputSystem(block: NodeParticleBlock): ThinParticleSystem | null {
  const port = block.inputs.find((input) => input.name === "particle");
  const value = port?.connectedPoint?._storedValue as object | null | undefined;
  return value && typeof value === "object" && "_updateQueueStart" in value ? (value as ThinParticleSystem) : null;
}

function queueTail(system: ThinParticleSystem): QueueItem | null {
  let item = (system as unknown as { _updateQueueStart: QueueItem | null })._updateQueueStart;
  while (item?.nextItem) item = item.nextItem;
  return item ?? null;
}
