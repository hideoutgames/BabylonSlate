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
 * vector or colour per operation. Here each queue item of a block below becomes one generated function: the reads its
 * process makes, as straight-line JavaScript in the same order, with the same number of reads of every producer (a
 * Random or a contextual source that writes as it reads is read as often as before) and the same arithmetic, operand
 * by operand, so a seeded run is bit-identical, its random sequence included (`particle-graph-realize.test.ts`).
 *
 * - A pure producer (an Input that reads without writing, and Math, Clamp, Gradient, Lerp, NLerp and Trigonometry over
 *   pure producers) is evaluated once per call however many reads reach it: Babylon re-evaluates it per read, which a
 *   graph whose values fan out and meet again (a diamond) repeats exponentially. Its value is the same either way.
 * - A queue item whose function would hold more than `PARTICLE_MAX_EMITTED_STATEMENTS` statements (impure reads still
 *   expand per read) keeps Babylon's process, with a warning.
 * - Math truncates its result only when its output is an Int. Babylon truncates whenever the left input is an Int,
 *   which turns an Int times a vector into 0 and drops an Int times a Float's fraction.
 *
 * Generated code, not composed closures: closures made from one function literal share its inline caches, so a graph
 * of them calls through megamorphic sites V8 cannot inline, which costs most of what resolving the reads saves.
 *
 * - Any other producer is read through Babylon's own `getConnectedValue`, and any other queue item keeps its process.
 * - What a read takes from a block (an Input's `value`, a Clamp's bounds, a Gradient stop's reference) is read on every
 *   call, so parameters written while the system runs apply as before.
 * - A vector or colour result goes into an object the read site owns, made once; Babylon makes a new one per read. Each
 *   is consumed (copied, or combined component by component) before the site runs again, and no generated code hands
 *   one to anything that could keep it.
 */

/** Most statements one generated update function holds (`ParticleUpdateTooLarge`). */
export const PARTICLE_MAX_EMITTED_STATEMENTS = 4096;

/** A queue item's function would hold more than `PARTICLE_MAX_EMITTED_STATEMENTS` statements. */
class ParticleUpdateTooLarge extends Error {}

type State = NodeParticleBuildState;
type Process = (particle: Particle, system: ThinParticleSystem) => void;
type QueueItem = { process: Process; nextItem: QueueItem | null };

const COMPONENTS: Partial<Record<Types, readonly string[]>> = {
  [Types.Vector2]: ["x", "y"],
  [Types.Vector3]: ["x", "y", "z"],
  [Types.Color4]: ["r", "g", "b", "a"],
};

/** Babylon's `ParticleTrigonometryBlock` functions, as expressions of `v`. */
const TRIGONOMETRY: Partial<Record<Trig, (v: string) => string>> = {
  [Trig.Cos]: (v) => `Math.cos(${v})`,
  [Trig.Sin]: (v) => `Math.sin(${v})`,
  [Trig.Abs]: (v) => `Math.abs(${v})`,
  [Trig.Exp]: (v) => `Math.exp(${v})`,
  [Trig.Exp2]: (v) => `Math.pow(2, ${v})`,
  [Trig.Round]: (v) => `Math.round(${v})`,
  [Trig.Floor]: (v) => `Math.floor(${v})`,
  [Trig.Ceiling]: (v) => `Math.ceil(${v})`,
  [Trig.Sqrt]: (v) => `Math.sqrt(${v})`,
  [Trig.Log]: (v) => `Math.log(${v})`,
  [Trig.Tan]: (v) => `Math.tan(${v})`,
  [Trig.ArcTan]: (v) => `Math.atan(${v})`,
  [Trig.ArcCos]: (v) => `Math.acos(${v})`,
  [Trig.ArcSin]: (v) => `Math.asin(${v})`,
  [Trig.Sign]: (v) => `Math.sign(${v})`,
  [Trig.Negate]: (v) => `(-${v})`,
  [Trig.OneMinus]: (v) => `(1 - ${v})`,
  [Trig.Reciprocal]: (v) => `(1 / ${v})`,
  [Trig.ToRadians]: (v) => `((${v} * Math.PI) / 180)`,
  [Trig.ToDegrees]: (v) => `((${v} * 180) / Math.PI)`,
  [Trig.Fract]: (v) => `(${v} >= 0 ? ${v} - Math.floor(${v}) : ${v} - Math.ceil(${v}))`,
};

/** `NodeParticleBuildState.getContextualValue` with its particle and system set, one source resolved. */
const CONTEXTUAL: Partial<Record<Contextual, string>> = {
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

const isScalar = (type: Types) => type === Types.Float || type === Types.Int;

/** One queue item's generated function: its statements and the objects they refer to. */
class Emitter {
  readonly lines: string[] = [];
  /** Objects the code refers to as `R[i]`: ports, blocks and the read sites' own results. */
  readonly refs: unknown[] = [];
  private next = 0;
  /** Reads emitted so far that may write as they read (Babylon's own, and writing contextual sources). */
  private impureReads = 0;
  /**
   * The variable holding each pure producer's value (by output port), per block scope the code has open, innermost
   * last: a variable declared in a branch is not in scope after it.
   */
  private readonly scopes: Map<NodeParticleConnectionPoint, string>[] = [new Map()];

  /** Appends one statement, refusing to grow past `PARTICLE_MAX_EMITTED_STATEMENTS`. */
  emit(line: string): void {
    if (this.lines.length >= PARTICLE_MAX_EMITTED_STATEMENTS) throw new ParticleUpdateTooLarge();
    this.lines.push(line);
  }

  /** Emits `line`, which opens a block (`if (...) {`, `} else {`), entering its scope. */
  openScope(line: string): void {
    this.emit(line);
    this.scopes.push(new Map());
  }

  /** Leaves the innermost scope, whose closing brace the caller emits. */
  closeScope(): void {
    this.scopes.pop();
  }

  private known(output: NodeParticleConnectionPoint): string | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const value = this.scopes[i]!.get(output);
      if (value !== undefined) return value;
    }
    return undefined;
  }

  ref(value: unknown): string {
    let index = this.refs.indexOf(value);
    if (index < 0) index = this.refs.push(value) - 1;
    return `R[${index}]`;
  }

  /** A new variable holding `expression`, evaluated now. */
  bind(expression: string): string {
    const name = `v${this.next++}`;
    this.emit(`const ${name} = ${expression};`);
    return name;
  }

  /** A new result object of `type` for one read site, made at compile time. */
  result(type: Types): string | null {
    switch (type) {
      case Types.Vector2: return this.bind(this.ref(new Vector2()));
      case Types.Vector3: return this.bind(this.ref(new Vector3()));
      case Types.Color4: return this.bind(this.ref(new Color4()));
    }
    return null;
  }

  /** Writes one expression per component of `type` into `target`. */
  store(type: Types, target: string, components: readonly string[]): void {
    if (type === Types.Vector3) {
      this.emit(`${target}.set(${components.join(", ")});`);
      return;
    }
    const names = COMPONENTS[type]!;
    // Every component is computed before the first is written, as Babylon's constructor arguments are.
    const values = components.map((component) => this.bind(component));
    for (let i = 0; i < names.length; i++) this.emit(`${target}.${names[i]} = ${values[i]};`);
  }

  variable(): string {
    const name = `v${this.next++}`;
    this.emit(`let ${name};`);
    return name;
  }

  /** The value `port.getConnectedValue(state)` gives, as a variable. */
  read(port: NodeParticleConnectionPoint): string {
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
    if (!source && !port.isConnected) return this.bind(`${this.ref(port)}.value`);
    this.impureReads += 1;
    return this.bind(`${this.ref(port)}.getConnectedValue(state)`);
  }

  private output(output: NodeParticleConnectionPoint): string | null {
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

  private input(block: ParticleInputBlock): string {
    const internals = block as unknown as { _contextualSource: Contextual; _systemSource: SystemSources };
    if (block.isSystemSource) {
      switch (internals._systemSource) {
        case SystemSources.Time: return this.bind("system._actualFrame");
        case SystemSources.Delta: return this.bind("system._scaledUpdateSpeed");
      }
      this.impureReads += 1;
      return this.bind(`state.getSystemValue(${internals._systemSource})`);
    }
    if (block.isContextual) {
      const source = CONTEXTUAL[internals._contextualSource];
      if (source) return this.bind(source);
      // Sources that write as they read (scaled direction, colour step, local position) keep Babylon's own code.
      this.impureReads += 1;
      return this.bind(`state.getContextualValue(${internals._contextualSource})`);
    }
    return this.bind(`${this.ref(block)}.value`);
  }

  private math(block: ParticleMathBlock): string | null {
    const { left, right, operation } = block;
    if (!left.isConnected || !right.isConnected) return null;
    const leftScalar = isScalar(left.type), rightScalar = isScalar(right.type);
    const symbol = { [ParticleMathBlockOperations.Add]: "+", [ParticleMathBlockOperations.Subtract]: "-",
      [ParticleMathBlockOperations.Multiply]: "*", [ParticleMathBlockOperations.Divide]: "/" }[operation as number];
    const minMax = operation === ParticleMathBlockOperations.Min ? "Math.min" : operation === ParticleMathBlockOperations.Max ? "Math.max" : null;
    // An Int result is truncated; a Float or vector one is not (where Babylon truncates whenever the left input is an Int).
    const truncate = (value: string) => (block.output.type === Types.Int ? this.bind(`${value} | 0`) : value);
    if (leftScalar && rightScalar) {
      // Decided before any read: a read emitted and then left to Babylon would be made twice.
      if (!symbol && !minMax) return null;
      const a = this.read(left), b = this.read(right);
      return truncate(this.bind(symbol ? `${a} ${symbol} ${b}` : `${minMax}(${a}, ${b})`));
    }
    // Arithmetic between a vector or colour and a scalar or one of its own type; Min and Max between vectors, and
    // anything Babylon would throw on (a colour's division), keep Babylon's.
    if (!symbol) return null;
    const type = leftScalar ? right.type : left.type;
    const names = COMPONENTS[type];
    if (!names || (!leftScalar && !rightScalar && left.type !== right.type)) return null;
    if (type === Types.Color4 && operation === ParticleMathBlockOperations.Divide) return null;
    // Babylon adapts the scalar side (the right one when both are vectors) through `state.adapt`, which reads it
    // `|| 0` and spreads a scalar to every component; the other side is read as it is.
    const operand = (port: NodeParticleConnectionPoint, scalar: boolean, adapted: boolean) => {
      const value = adapted ? this.bind(`${this.read(port)} || 0`) : this.read(port);
      return (component: string) => (scalar ? value : `${value}.${component}`);
    };
    const a = operand(left, leftScalar, leftScalar), b = operand(right, rightScalar, !leftScalar);
    const out = this.result(type)!;
    this.store(type, out, names.map((component) => `${a(component)} ${symbol} ${b(component)}`));
    return truncate(out);
  }

  private clamp(block: ParticleClampBlock): string | null {
    if (!block.value.isConnected) return null;
    const type = block.value.type;
    const names = COMPONENTS[type];
    if (!isScalar(type) && !names) return null;
    const value = this.read(block.value);
    const min = block.min.isConnected ? this.read(block.min) : this.bind(`${this.ref(block)}.minimum`);
    const max = block.max.isConnected ? this.read(block.max) : this.bind(`${this.ref(block)}.maximum`);
    const clamp = (v: string) => `Math.max(${min}, Math.min(${v}, ${max}))`;
    if (!names) return this.bind(clamp(value));
    const out = this.result(type)!;
    this.store(type, out, names.map((component) => clamp(`${value}.${component}`)));
    return out;
  }

  private gradient(block: ParticleGradientBlock): string {
    const entries: ParticleGradientValueBlock[] = [];
    for (let i = 1; i < block.inputs.length; i++) {
      const port = block.inputs[i]!;
      if (port.isConnected) entries.push(port.connectedPoint!.ownerBlock as ParticleGradientValueBlock);
    }
    // Babylon sorts by reference once, at build.
    entries.sort((a, b) => a.reference - b.reference);
    const gradient = this.read(block.gradient);
    const result = this.variable();
    const type = block.output.type;
    const names = COMPONENTS[type];
    if (entries.length === 1) {
      this.emit(`${result} = ${this.read(entries[0]!.value)};`);
      return result;
    }
    // Babylon's walk down the entries, unrolled: the first whose reference is at most the gradient, interpolated
    // towards the entry after it. Each entry's value is read only on the branch Babylon reads it.
    const out = names ? this.result(type)! : null;
    let opened = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]!;
      const reference = this.bind(`${this.ref(entry)}.reference`);
      this.openScope(`if (${reference} <= ${gradient}) {`);
      const current = this.read(entry.value);
      const following = entries[i + 1];
      if (!following) {
        this.emit(`${result} = ${current};`);
      } else {
        const next = this.read(following.value);
        const scale = this.bind(`Math.max(0, Math.min(1, (${gradient} - ${reference}) / (${this.ref(following)}.reference - ${reference})))`);
        // Babylon's `Lerp`s: start + (end - start) * amount, per component; any other type keeps the current value.
        const lerp = (a: string, b: string) => `${a} + (${b} - ${a}) * ${scale}`;
        if (type === Types.Float) {
          this.emit(`${result} = ${lerp(current, next)};`);
        } else if (names) {
          this.store(type, out!, names.map((component) => lerp(`${current}.${component}`, `${next}.${component}`)));
          this.emit(`${result} = ${out};`);
        } else {
          this.emit(`${result} = ${current};`);
        }
      }
      this.closeScope();
      this.openScope("} else {");
      opened += 1;
    }
    this.emit(`${result} = 0;`);
    this.emit("}".repeat(opened));
    for (let i = 0; i < opened; i++) this.closeScope();
    return result;
  }

  private lerp(block: ParticleLerpBlock | ParticleNLerpBlock, normalize: boolean): string | null {
    if (!block.left.isConnected || !block.right.isConnected) return null;
    const type = block.left.type;
    const names = COMPONENTS[type];
    const a = this.read(block.left), b = this.read(block.right), t = this.read(block.gradient);
    const mix = (x: string, y: string) => `(1 - ${t}) * ${x} + ${t} * ${y}`;
    if (isScalar(type)) return this.bind(mix(a, b));
    if (!names) return this.bind("0");
    const out = this.result(type)!;
    this.store(type, out, names.map((component) => mix(`${a}.${component}`, `${b}.${component}`)));
    if (normalize) {
      if (type === Types.Color4) {
        const length = this.bind(`Math.sqrt(${out}.r * ${out}.r + ${out}.g * ${out}.g + ${out}.b * ${out}.b + ${out}.a * ${out}.a)`);
        this.emit(`if (${length} !== 0) ${out}.scaleInPlace(1 / ${length});`);
      } else {
        this.emit(`${out}.normalize();`);
      }
    }
    return out;
  }

  private trigonometry(block: ParticleTrigonometryBlock): string | null {
    const func = TRIGONOMETRY[block.operation];
    const type = block.input.type;
    const names = COMPONENTS[type];
    if (!func || (!isScalar(type) && !names)) return null;
    const value = this.read(block.input);
    if (!names) {
      const v = this.bind(value);
      return this.bind(func(v));
    }
    const out = this.result(type)!;
    const parts = names.map((component) => this.bind(`${value}.${component}`));
    this.store(type, out, parts.map((part) => func(part)));
    return out;
  }
}

/** The generated process for the queue item `block` added, or null to keep Babylon's. */
function compileProcess(block: NodeParticleBlock, state: State, system: ThinParticleSystem): Process | null {
  const emitter = new Emitter();
  if (block instanceof UpdateColorBlock) emitter.emit(`particle.color.copyFrom(${emitter.read(block.color)});`);
  else if (block instanceof UpdateDirectionBlock) emitter.emit(`particle.direction.copyFrom(${emitter.read(block.direction)});`);
  else if (block instanceof UpdatePositionBlock) emitter.emit(`particle.position.copyFrom(${emitter.read(block.position)});`);
  else if (block instanceof UpdateScaleBlock) emitter.emit(`particle.scale.copyFrom(${emitter.read(block.scale)});`);
  else if (block instanceof UpdateSizeBlock) emitter.emit(`particle.size = ${emitter.read(block.size)};`);
  else if (block instanceof UpdateAngleBlock) emitter.emit(`particle.angle = ${emitter.read(block.angle)};`);
  else return null;
  const source = `return function (particle) {\nstate.particleContext = particle;\nstate.systemContext = system;\n${emitter.lines.join("\n")}\n};`;
  return new Function("R", "state", "system", source)(emitter.refs, state, system) as Process;
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
