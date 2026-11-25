import type { DataBuffer } from "@babylonjs/core/Buffers/dataBuffer";
import type { AbstractEngine } from "@babylonjs/core/Engines/abstractEngine";
import { NodeMaterialBlockConnectionPointTypes } from "@babylonjs/core/Materials/Node/Enums/nodeMaterialBlockConnectionPointTypes";
import { NodeMaterialBlockTargets } from "@babylonjs/core/Materials/Node/Enums/nodeMaterialBlockTargets";
import type { NodeMaterial, NodeMaterialDefines } from "@babylonjs/core/Materials/Node/nodeMaterial";
import { NodeMaterialBlock } from "@babylonjs/core/Materials/Node/nodeMaterialBlock";
import type { NodeMaterialBuildState } from "@babylonjs/core/Materials/Node/nodeMaterialBuildState";
import type { NodeMaterialConnectionPoint } from "@babylonjs/core/Materials/Node/nodeMaterialBlockConnectionPoint";
import type { Effect } from "@babylonjs/core/Materials/effect";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector2, Vector3, Vector4 } from "@babylonjs/core/Maths/math.vector";
import { RegisterClass } from "@babylonjs/core/Misc/typeStore";
import type { MaterialBuildPlan, MaterialOperand, MaterialOperation } from "@haptic/shader-graph";

/** The light and environment blocks every lit program binds (`HapticLightingBlock`), in binding-point order. */
export const HAPTIC_LIGHT_UNIFORM_BLOCKS = ["HapticLights", "HapticClusters", "HapticEnvironment"] as const;

/** The per-Material `std140` uniform block every Material-mode program of the compiler reads its record from. */
export const MATERIAL_RECORD_BLOCK = "HapticMaterial";

/**
 * The most slots (one `vec4` each) a record may hold: 4 KiB, a quarter of WebGL2's minimum `MAX_UNIFORM_BLOCK_SIZE`
 * (16 KiB, which WebKit and ANGLE report), so no device refuses it. A plan that would need more keeps its values as
 * plain uniforms (`planMaterialRecord`).
 */
export const MATERIAL_RECORD_MAX_SLOTS = 256;

/** Parameter node types whose value a record slot holds (a texture is a sampler). */
const RECORD_PARAMETERS: ReadonlySet<string> = new Set(["param.float", "param.vec2", "param.vec3", "param.vec4", "param.color"]);

/**
 * A plan's record layout, in plan order (so the layout is the program's): one slot per parameter read as a value (Per
 * Instance parameters are attributes) and per hoisted literal (`MaterialBuildPlan.hoistedConstants` and constant
 * operands marked `hoisted`), each operation's own slot first, then its inputs' by pin id, then the Material Output's
 * hoisted literals by pin id. Null when the plan reads
 * none, or more than `MATERIAL_RECORD_MAX_SLOTS`: its parameters then stay plain uniforms and its literals code.
 */
export function planMaterialRecord(
  plan: MaterialBuildPlan, perInstance: (operation: MaterialOperation) => boolean,
): { slots: number; slotOf: ReadonlyMap<string, number>; operandSlot: ReadonlyMap<MaterialOperand, number> } | null {
  const slotOf = new Map<string, number>();
  const operandSlot = new Map<MaterialOperand, number>();
  const hoisted = new Set(plan.hoistedConstants);
  let slots = 0;
  for (const operation of plan.operations) {
    if ((RECORD_PARAMETERS.has(operation.nodeType) && !perInstance(operation)) || hoisted.has(operation.id)) slotOf.set(operation.id, slots++);
    for (const pinId of Object.keys(operation.inputs).sort()) {
      const operand = operation.inputs[pinId]!;
      if (operand.kind === "constant" && operand.hoisted && !operandSlot.has(operand)) operandSlot.set(operand, slots++);
    }
  }
  // Then the Material Output's hoisted literals, by pin id.
  for (const pinId of Object.keys(plan.outputs).sort()) {
    const operand = plan.outputs[pinId];
    if (operand?.kind === "constant" && operand.hoisted && !operandSlot.has(operand)) operandSlot.set(operand, slots++);
  }
  return slots === 0 || slots > MATERIAL_RECORD_MAX_SLOTS ? null : { slots, slotOf, operandSlot };
}

/** A value a record slot holds, as the Babylon block it replaces held it. */
export type MaterialRecordValue = number | Vector2 | Vector3 | Vector4 | Color3 | Color4;

/**
 * One Material's record: one `vec4` slot per value it reads (`layout(std140) uniform HapticMaterial { vec4
 * hapticMaterial[N]; }`), in a uniform buffer of its own. The slot layout is the program's (the plan's shape decides
 * it), the bytes are the Material's: Materials sharing a program bind their own record on every draw.
 */
/** Per Engine, the shared record buffers by their bytes, with how many records bind each. */
const sharedRecords = new WeakMap<AbstractEngine, Map<string, { buffer: DataBuffer; users: number }>>();

/** A record's bytes as a key: two records with one key hold the same values in the same size of buffer. */
function recordKey(data: Float32Array): string {
  const words = new Uint16Array(data.buffer, data.byteOffset, data.byteLength / 2);
  let key = "";
  for (let index = 0; index < words.length; index += 4096) key += String.fromCharCode(...words.subarray(index, index + 4096));
  return key;
}

/**
 * One Material's record. Records holding the same bytes (a Material and its outline, capture, shadow and water variants,
 * its Instances that override nothing, Materials of one graph and values) bind one shared buffer per Engine, so
 * consecutive draws of them keep the buffer at the binding point and Babylon's binding cache skips the bind. A record
 * written after its first bind (a parameter edit) leaves the shared buffer for one of its own, which later writes
 * update in place.
 */
export class MaterialRecord {
  readonly data: Float32Array;
  private buffer: DataBuffer | null = null;
  /** The shared buffer's key while the record binds one; null for a buffer of its own. */
  private sharedKey: string | null = null;
  /** Written after it first bound: it binds a buffer of its own. */
  private own = false;
  private dirty = true;
  private disposed = false;
  private readonly engine: AbstractEngine;
  readonly slots: number;

  constructor(engine: AbstractEngine, slots: number) {
    this.engine = engine;
    this.slots = slots;
    this.data = new Float32Array(slots * 4);
  }

  /** Writes `components` (at most four) into `slot`; the next bind uploads them. */
  write(slot: number, components: readonly number[]): void {
    const offset = slot * 4;
    let changed = false;
    for (let index = 0; index < 4; index++) {
      const value = index < components.length ? components[index]! : 0;
      if (this.data[offset + index] !== Math.fround(value)) {
        this.data[offset + index] = value;
        changed = true;
      }
    }
    if (!changed) return;
    this.dirty = true;
    if (this.sharedKey !== null) {
      // Other records still bind the shared buffer with the old bytes.
      this.leaveShared();
      this.own = true;
    }
  }

  /** Binds the record at the program's `HapticMaterial` binding point. */
  bind(effect: Effect): void {
    if (this.disposed) return;
    if (!this.buffer) {
      if (this.own) this.buffer = this.engine.createUniformBuffer(this.data, MATERIAL_RECORD_BLOCK);
      else {
        let shared = sharedRecords.get(this.engine);
        if (!shared) sharedRecords.set(this.engine, (shared = new Map()));
        const key = recordKey(this.data);
        let entry = shared.get(key);
        if (!entry) shared.set(key, (entry = { buffer: this.engine.createUniformBuffer(this.data, MATERIAL_RECORD_BLOCK), users: 0 }));
        entry.users += 1;
        this.buffer = entry.buffer;
        this.sharedKey = key;
      }
      this.dirty = false;
    } else if (this.dirty) {
      this.engine.updateUniformBuffer(this.buffer, this.data);
      this.dirty = false;
    }
    effect.bindUniformBuffer(this.buffer, MATERIAL_RECORD_BLOCK);
  }

  private leaveShared(): void {
    const key = this.sharedKey;
    if (key === null) return;
    const shared = sharedRecords.get(this.engine);
    const entry = shared?.get(key);
    if (entry && --entry.users === 0) {
      shared!.delete(key);
      this.engine._releaseBuffer(entry.buffer);
    }
    this.sharedKey = null;
    this.buffer = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.sharedKey !== null) this.leaveShared();
    else if (this.buffer) this.engine._releaseBuffer(this.buffer);
    this.buffer = null;
  }
}

/** The GLSL declaration of a record of `slots` slots. A declaration only: nothing is a function. */
export function materialRecordDeclaration(slots: number): string {
  return `layout(std140) uniform ${MATERIAL_RECORD_BLOCK} {\n  vec4 hapticMaterial[${slots}];\n};\n`;
}

const SWIZZLES: Partial<Record<NodeMaterialBlockConnectionPointTypes, string>> = {
  [NodeMaterialBlockConnectionPointTypes.Float]: ".x",
  [NodeMaterialBlockConnectionPointTypes.Vector2]: ".xy",
  [NodeMaterialBlockConnectionPointTypes.Vector3]: ".xyz",
  [NodeMaterialBlockConnectionPointTypes.Color3]: ".xyz",
  [NodeMaterialBlockConnectionPointTypes.Vector4]: "",
  [NodeMaterialBlockConnectionPointTypes.Color4]: "",
};

/**
 * Reads one slot of the Material's record, in whichever stage uses it (a uniform does the same). It holds the value
 * the slot carries as the `InputBlock` it replaces held it (`value`, `convertToLinearSpace` for a Color), and writes
 * the record on every change: a Color's RGB goes to linear space by the Engine's rule, as an `InputBlock` transmits it.
 */
export class MaterialRecordReadBlock extends NodeMaterialBlock {
  private current: MaterialRecordValue = 0;
  /** A Color picked in sRGB: the record holds its RGB in linear space. */
  readonly convertToLinearSpace: boolean;
  readonly type: NodeMaterialBlockConnectionPointTypes;
  readonly slot: number;
  readonly record: MaterialRecord;
  private readonly exactSrgb: boolean;

  constructor(
    name: string,
    type: NodeMaterialBlockConnectionPointTypes,
    slot: number,
    record: MaterialRecord,
    value: MaterialRecordValue,
    convertToLinearSpace = false,
    exactSrgb = false,
  ) {
    super(name, NodeMaterialBlockTargets.VertexAndFragment);
    this.type = type;
    this.slot = slot;
    this.record = record;
    this.exactSrgb = exactSrgb;
    this.convertToLinearSpace = convertToLinearSpace;
    this.registerOutput("output", type);
    this.value = value;
  }

  override getClassName(): string {
    return "MaterialRecordReadBlock";
  }

  get output(): NodeMaterialConnectionPoint {
    return this._outputs[0]!;
  }

  get value(): MaterialRecordValue {
    return this.current;
  }

  set value(value: MaterialRecordValue) {
    this.current = value;
    this.record.write(this.slot, this.components(value));
  }

  private components(value: MaterialRecordValue): number[] {
    if (typeof value === "number") return [value];
    if (value instanceof Color4 || value instanceof Color3) {
      const linear = this.convertToLinearSpace ? value.toLinearSpace(this.exactSrgb) : value;
      return value instanceof Color4 ? [linear.r, linear.g, linear.b, (value as Color4).a] : [linear.r, linear.g, linear.b];
    }
    return value.asArray();
  }

  override updateUniformsAndSamples(state: NodeMaterialBuildState, material: NodeMaterial, defines: NodeMaterialDefines, uniformBuffers: string[]): void {
    super.updateUniformsAndSamples(state, material, defines, uniformBuffers);
    // A binding point is the block's position in the program's list. The record comes after the light blocks, listed
    // first whether or not the program reads them (an unread name binds nothing), so the record has one binding point
    // in every program and the lights keep theirs: Babylon's binding cache (`Effect._BaseCache`) then skips a bind
    // whose buffer is already there, and only a change of record rebinds.
    for (const name of HAPTIC_LIGHT_UNIFORM_BLOCKS) if (!uniformBuffers.includes(name)) uniformBuffers.push(name);
    if (!uniformBuffers.includes(MATERIAL_RECORD_BLOCK)) uniformBuffers.push(MATERIAL_RECORD_BLOCK);
  }

  /**
   * Every draw binds the Material's record (a forced bindable block): one binding point serves every program's record,
   * and a draw with another, smaller buffer there fails on ANGLE.
   */
  override bind(effect: Effect): void {
    this.record.bind(effect);
  }

  protected override _buildBlock(state: NodeMaterialBuildState) {
    super._buildBlock(state);
    state._emitFunction("hapticMaterialRecord", materialRecordDeclaration(this.record.slots), "");
    if (!state.sharedData.forcedBindableBlocks.includes(this)) state.sharedData.forcedBindableBlocks.push(this);
    // Babylon asks only these blocks for the uniform blocks a program binds (`updateUniformsAndSamples`).
    if (!state.sharedData.dynamicUniformBlocks.includes(this)) state.sharedData.dynamicUniformBlocks.push(this);
    state.compilationString += `${state._declareOutput(this.output)} = hapticMaterial[${this.slot}]${SWIZZLES[this.type] ?? ""};\n`;
    return this;
  }
}

RegisterClass("BABYLON.MaterialRecordReadBlock", MaterialRecordReadBlock);
