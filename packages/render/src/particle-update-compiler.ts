import { Color4 } from "@babylonjs/core/Maths/math.color";
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
 * vector or colour per operation. Here each queue item of a block below becomes one program: the reads its process
 * makes, compiled once into a flat instruction tape (`Int32Array` opcodes and register operands, `Float64Array`
 * constants) that one `switch` loop runs over preallocated registers (`Float64Array` scalars and vector components, an
 * array of objects for vectors, colours and Babylon's own reads). The reads are in the same order, with the same number
 * of reads of every producer (a Random or a contextual source that writes as it reads is read as often as before) and
 * the same arithmetic, operand by operand, in doubles, so a seeded run is bit-identical, its random sequence included
 * (`particle-graph-realize.test.ts`). No code is generated: nothing here needs `eval` or `new Function`, so games run
 * under a Content Security Policy without `unsafe-eval` and on JIT-less WebKit.
 *
 * - A pure producer (an Input that reads without writing, and Math, Clamp, Gradient, Lerp, NLerp and Trigonometry over
 *   pure producers) is evaluated once per call however many reads reach it: Babylon re-evaluates it per read, which a
 *   graph whose values fan out and meet again (a diamond) repeats exponentially. Its value is the same either way.
 * - A queue item whose program would hold more than `PARTICLE_MAX_EMITTED_STATEMENTS` instructions (impure reads still
 *   expand per read) keeps Babylon's process, with a warning.
 * - Math truncates its result only when its output is an Int. Babylon truncates whenever the left input is an Int,
 *   which turns an Int times a vector into 0 and drops an Int times a Float's fraction.
 * - One interpreter (`run`) serves every program, so its call and property sites see the same few shapes whatever the
 *   graph; a program is data, not a closure per operation.
 * - Any other producer is read through Babylon's own `getConnectedValue`, and any other queue item keeps its process.
 * - What a read takes from a block (an Input's `value`, a Clamp's bounds, a Gradient stop's reference) is read on every
 *   call, so parameters written while the system runs apply as before.
 * - A vector or colour result goes into an object the read site owns, made once; Babylon makes a new one per read. Each
 *   is consumed (copied, or combined component by component) before the site runs again, and no program hands one to
 *   anything that could keep it.
 */

/** Most instructions one compiled update program holds (`ParticleUpdateTooLarge`). */
export const PARTICLE_MAX_EMITTED_STATEMENTS = 4096;

/** A queue item's program would hold more than `PARTICLE_MAX_EMITTED_STATEMENTS` instructions. */
class ParticleUpdateTooLarge extends Error {}

type State = NodeParticleBuildState;
type Process = (particle: Particle, system: ThinParticleSystem) => void;
type QueueItem = { process: Process; nextItem: QueueItem | null };

const isScalar = (type: Types) => type === Types.Float || type === Types.Int;

/*
 * Opcodes. An instruction is its opcode followed by its operands (`WIDTH` slots), all in one `Int32Array`. `f` names a scalar register
 * (`Float64Array`), `o` an object register (vectors, colours and whatever Babylon's own reads return), `k` a constant,
 * `r` an entry of the program's referenced blocks and ports. Jump targets are code offsets.
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
const JUMP_UNLESS_AT_MOST = 38; // a, b, target: if (!(a <= b)) jump
const JUMP = 39; // target
const WRITE_COLOR = 40, WRITE_DIRECTION = 41, WRITE_POSITION = 42, WRITE_SCALE = 43; // o: particle.<field>.copyFrom(o)
const WRITE_SIZE = 44, WRITE_ANGLE = 45; // f: particle.<field> = f
// Babylon's `ParticleTrigonometryBlock` functions: f, a.
const COS = 46, SIN = 47, ABS = 48, EXP = 49, EXP2 = 50, ROUND = 51, FLOOR = 52, CEILING = 53, SQRT = 54, LOG = 55,
  TAN = 56, ARC_TAN = 57, ARC_COS = 58, ARC_SIN = 59, SIGN = 60, NEGATE = 61, ONE_MINUS = 62, RECIPROCAL = 63,
  TO_RADIANS = 64, TO_DEGREES = 65, FRACT = 66;

/** Slots per instruction: its opcode and up to five operands (`SET4`), unused ones zero, so every instruction decodes alike. */
const WIDTH = 6;

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

type ParticleSource = Particle & {
  _properties: { directionScale: number; initialDirection: unknown };
  colorStep: unknown;
};
type SystemSource = ThinParticleSystem & { _actualFrame: number; _scaledUpdateSpeed: number };

function contextual(source: Contextual, particle: ParticleSource, system: SystemSource): unknown {
  switch (source) {
    case Contextual.Position: return particle.position;
    case Contextual.Direction: return particle.direction;
    case Contextual.DirectionScale: return particle._properties.directionScale;
    case Contextual.Color: return particle.color;
    case Contextual.InitialColor: return particle.initialColor;
    case Contextual.ColorDead: return particle.colorDead;
    case Contextual.Age: return particle.age;
    case Contextual.Lifetime: return particle.lifeTime;
    case Contextual.Angle: return particle.angle;
    case Contextual.Scale: return particle.scale;
    case Contextual.Size: return particle.size;
    case Contextual.AgeGradient: return particle.age / particle.lifeTime;
    case Contextual.SpriteCellEnd: return system.endSpriteCellID;
    case Contextual.SpriteCellIndex: return particle.cellIndex;
    case Contextual.SpriteCellStart: return system.startSpriteCellID;
    case Contextual.InitialDirection: return particle._properties.initialDirection;
    case Contextual.ColorStep: return particle.colorStep;
  }
  return undefined;
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

/** A compiled queue item: its code, constants, referenced blocks and ports, and preallocated registers. */
type Program = {
  /** The instructions, `WIDTH` slots each. */
  readonly code: Int32Array;
  readonly constants: Float64Array;
  readonly refs: readonly unknown[];
  readonly f: Float64Array;
  readonly o: unknown[];
  readonly state: State;
  readonly system: ThinParticleSystem;
};

/** Builds one queue item's program: what each read of Babylon's process makes, in the same order. */
class ProgramBuilder {
  private readonly code: number[] = [];
  private readonly constants: number[] = [];
  /** Ports and blocks the code reads every call (a value, bounds, a stop's reference). */
  readonly refs: unknown[] = [];
  /** What each object register starts as: the read sites' own result objects, made once. */
  private readonly objects: unknown[] = [];
  private scalars = 0;
  private instructions = 0;
  /** Reads emitted so far that may write as they read (Babylon's own, and writing contextual sources). */
  private impureReads = 0;
  /**
   * The value of each pure producer (by output port), per branch the code has open, innermost last: a value computed
   * in a branch is not known after it.
   */
  private readonly scopes: Map<NodeParticleConnectionPoint, Value>[] = [new Map()];

  /** Appends one instruction, refusing to grow past `PARTICLE_MAX_EMITTED_STATEMENTS`. */
  op(opcode: number, ...operands: number[]): number {
    if (this.instructions >= PARTICLE_MAX_EMITTED_STATEMENTS) throw new ParticleUpdateTooLarge();
    this.instructions += 1;
    const at = this.code.length;
    this.code.push(opcode, ...operands);
    while (this.code.length < at + WIDTH) this.code.push(0);
    return at;
  }

  /** The offset the next instruction takes. */
  here(): number {
    return this.code.length;
  }

  /** Points the jump operand at `at + offset` to `target`. */
  patch(at: number, offset: number, target: number): void {
    this.code[at + offset] = target;
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
    const exits: number[] = [];
    let opened = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]!;
      const reference = scalarOf(this.scalarOp(REFERENCE, this.ref(entry)));
      const test = this.op(JUMP_UNLESS_AT_MOST, reference, gradient, -1);
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
      exits.push(this.op(JUMP, -1));
      this.patch(test, 3, this.here());
      this.openScope();
      opened += 1;
    }
    if ("f" in result) this.op(K, result.f, this.constant(0));
    else this.op(ZERO_O, result.o);
    const end = this.here();
    for (const exit of exits) this.patch(exit, 1, end);
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

  build(state: State, system: ThinParticleSystem): Program {
    return {
      code: Int32Array.from(this.code), constants: Float64Array.from(this.constants), refs: this.refs,
      f: new Float64Array(this.scalars), o: [...this.objects], state, system,
    };
  }

  get size(): number {
    return this.instructions;
  }
}

type Port = { value: unknown; getConnectedValue(state: State): unknown };
type Block = { value: unknown; minimum: number; maximum: number; reference: number };
type Vector = { x: number; y: number; z: number; r: number; g: number; b: number; a: number };
type Writable = Vector & { set(x: number, y: number, z: number): void; normalize(): void; scaleInPlace(scale: number): void };

/**
 * Runs `program` for `particle`: one loop over its code, every value in preallocated registers. It allocates nothing;
 * what Babylon's own reads return is theirs.
 */
function run(program: Program, particle: Particle): void {
  const { code, constants, refs, f, o, state, system } = program;
  state.particleContext = particle;
  state.systemContext = system;
  const length = code.length;
  let pc = 0;
  while (pc < length) {
    const opcode = code[pc]!;
    const a = code[pc + 1]!, b = code[pc + 2]!, c = code[pc + 3]!, d = code[pc + 4]!;
    pc += WIDTH;
    switch (opcode) {
      case K: f[a] = constants[b]!; break;
      case BLOCK_VALUE: f[a] = (refs[b] as Block).value as number; break;
      case BLOCK_VALUE_O: o[a] = (refs[b] as Block).value; break;
      case MINIMUM: f[a] = (refs[b] as Block).minimum; break;
      case MAXIMUM: f[a] = (refs[b] as Block).maximum; break;
      case REFERENCE: f[a] = (refs[b] as Block).reference; break;
      case CONNECTED: f[a] = (refs[b] as Port).getConnectedValue(state) as number; break;
      case CONNECTED_O: o[a] = (refs[b] as Port).getConnectedValue(state); break;
      case SYSTEM_VALUE: f[a] = state.getSystemValue(b) as number; break;
      case SYSTEM_VALUE_O: o[a] = state.getSystemValue(b); break;
      case CONTEXT_VALUE: f[a] = state.getContextualValue(b) as number; break;
      case CONTEXT_VALUE_O: o[a] = state.getContextualValue(b); break;
      case CONTEXT: f[a] = contextual(b, particle as ParticleSource, system as SystemSource) as number; break;
      case TIME: f[a] = (system as SystemSource)._actualFrame; break;
      case DELTA: f[a] = (system as SystemSource)._scaledUpdateSpeed; break;
      case AGE: f[a] = particle.age; break;
      case LIFETIME: f[a] = particle.lifeTime; break;
      case AGE_GRADIENT: f[a] = particle.age / particle.lifeTime; break;
      case SIZE: f[a] = particle.size; break;
      case ANGLE: f[a] = particle.angle; break;
      case CONTEXT_O: o[a] = contextual(b, particle as ParticleSource, system as SystemSource); break;
      case COMPONENT_X: f[a] = (o[b] as Vector).x; break;
      case COMPONENT_Y: f[a] = (o[b] as Vector).y; break;
      case COMPONENT_Z: f[a] = (o[b] as Vector).z; break;
      case COMPONENT_R: f[a] = (o[b] as Vector).r; break;
      case COMPONENT_G: f[a] = (o[b] as Vector).g; break;
      case COMPONENT_B: f[a] = (o[b] as Vector).b; break;
      case COMPONENT_A: f[a] = (o[b] as Vector).a; break;
      case ADD: f[a] = f[b]! + f[c]!; break;
      case SUBTRACT: f[a] = f[b]! - f[c]!; break;
      case MULTIPLY: f[a] = f[b]! * f[c]!; break;
      case DIVIDE: f[a] = f[b]! / f[c]!; break;
      case MIN: f[a] = Math.min(f[b]!, f[c]!); break;
      case MAX: f[a] = Math.max(f[b]!, f[c]!); break;
      case TRUNCATE: f[a] = f[b]! | 0; break;
      case TRUNCATE_O: f[a] = (o[b] as number) | 0; break;
      case OR_ZERO: f[a] = f[b]! || 0; break;
      case OR_ZERO_O: o[a] = o[b] || 0; break;
      case CLAMP: f[a] = Math.max(f[c]!, Math.min(f[b]!, f[d]!)); break;
      case MIX: f[a] = (1 - f[d]!) * f[b]! + f[d]! * f[c]!; break;
      case STOP_LERP: f[a] = f[b]! + (f[c]! - f[b]!) * f[d]!; break;
      case STOP_SCALE: f[a] = Math.max(0, Math.min(1, (f[b]! - f[c]!) / (f[d]! - f[c]!))); break;
      case LENGTH4: {
        const color = o[b] as Vector;
        f[a] = Math.sqrt(color.r * color.r + color.g * color.g + color.b * color.b + color.a * color.a);
        break;
      }
      case SET2: { const target = o[a] as Vector; target.x = f[b]!; target.y = f[c]!; break; }
      case SET3: (o[a] as Writable).set(f[b]!, f[c]!, f[d]!); break;
      case SET4: {
        const target = o[a] as Vector;
        target.r = f[b]!; target.g = f[c]!; target.b = f[d]!; target.a = f[code[pc - 1]!]!;
        break;
      }
      case NORMALIZE: (o[a] as Writable).normalize(); break;
      case SCALE_UNLESS_ZERO: if (f[b] !== 0) (o[a] as Writable).scaleInPlace(1 / f[b]!); break;
      case MOVE: f[a] = f[b]!; break;
      case MOVE_O: o[a] = o[b]; break;
      case ZERO_O: o[a] = 0; break;
      case JUMP_UNLESS_AT_MOST: if (!(f[a]! <= f[b]!)) pc = c; break;
      case JUMP: pc = a; break;
      case WRITE_COLOR: particle.color.copyFrom(o[a] as Color4); break;
      case WRITE_DIRECTION: particle.direction.copyFrom(o[a] as Vector3); break;
      case WRITE_POSITION: particle.position.copyFrom(o[a] as Vector3); break;
      case WRITE_SCALE: particle.scale.copyFrom(o[a] as Vector2); break;
      case WRITE_SIZE: particle.size = f[a]!; break;
      case WRITE_ANGLE: particle.angle = f[a]!; break;
      case COS: f[a] = Math.cos(f[b]!); break;
      case SIN: f[a] = Math.sin(f[b]!); break;
      case ABS: f[a] = Math.abs(f[b]!); break;
      case EXP: f[a] = Math.exp(f[b]!); break;
      case EXP2: f[a] = Math.pow(2, f[b]!); break;
      case ROUND: f[a] = Math.round(f[b]!); break;
      case FLOOR: f[a] = Math.floor(f[b]!); break;
      case CEILING: f[a] = Math.ceil(f[b]!); break;
      case SQRT: f[a] = Math.sqrt(f[b]!); break;
      case LOG: f[a] = Math.log(f[b]!); break;
      case TAN: f[a] = Math.tan(f[b]!); break;
      case ARC_TAN: f[a] = Math.atan(f[b]!); break;
      case ARC_COS: f[a] = Math.acos(f[b]!); break;
      case ARC_SIN: f[a] = Math.asin(f[b]!); break;
      case SIGN: f[a] = Math.sign(f[b]!); break;
      case NEGATE: f[a] = -f[b]!; break;
      case ONE_MINUS: f[a] = 1 - f[b]!; break;
      case RECIPROCAL: f[a] = 1 / f[b]!; break;
      case TO_RADIANS: f[a] = (f[b]! * Math.PI) / 180; break;
      case TO_DEGREES: f[a] = (f[b]! * 180) / Math.PI; break;
      case FRACT: { const v = f[b]!; f[a] = v >= 0 ? v - Math.floor(v) : v - Math.ceil(v); break; }
    }
  }
}

const programs = new WeakMap<Process, Program>();

/** Instructions in the program a compiled process runs, or null for a process this module did not compile. */
export function compiledParticleUpdateSize(process: unknown): number | null {
  const program = programs.get(process as Process);
  return program ? program.code.length / WIDTH : null;
}

/** The compiled process for the queue item `block` added, or null to keep Babylon's. */
function compileProcess(block: NodeParticleBlock, state: State, system: ThinParticleSystem): Process | null {
  const builder = new ProgramBuilder();
  if (block instanceof UpdateColorBlock) builder.op(WRITE_COLOR, objectOf(builder.read(block.color)));
  else if (block instanceof UpdateDirectionBlock) builder.op(WRITE_DIRECTION, objectOf(builder.read(block.direction)));
  else if (block instanceof UpdatePositionBlock) builder.op(WRITE_POSITION, objectOf(builder.read(block.position)));
  else if (block instanceof UpdateScaleBlock) builder.op(WRITE_SCALE, objectOf(builder.read(block.scale)));
  else if (block instanceof UpdateSizeBlock) builder.op(WRITE_SIZE, scalarOf(builder.read(block.size)));
  else if (block instanceof UpdateAngleBlock) builder.op(WRITE_ANGLE, scalarOf(builder.read(block.angle)));
  else return null;
  const program = builder.build(state, system);
  const process: Process = function compiledParticleUpdate(particle) {
    run(program, particle);
  };
  programs.set(process, program);
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
  compile(system: ThinParticleSystem, state: State): number {
    let compiled = 0;
    for (let item = (system as unknown as { _updateQueueStart: QueueItem | null })._updateQueueStart; item; item = item.nextItem) {
      const block = this.owners.get(item);
      let process: Process | null;
      try {
        process = block ? compileProcess(block, state, system) : null;
      } catch (error) {
        // A step this module cannot generate keeps Babylon's process; the graph still builds.
        process = null;
        if (block && error instanceof ParticleUpdateTooLarge) {
          console.warn(`[render] Particle update "${block.name}" keeps Babylon's evaluation: its reads expand past ${PARTICLE_MAX_EMITTED_STATEMENTS} instructions.`);
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
