import { GameTimeInputBlock } from "./game-time-input-block";
import { QualityTextureBlock } from "./texture-quality";
import { EnvironmentSampleBlock } from "./environment-sample-block";
import { LogicalSceneTextureBlock } from "./logical-scene-texture-block";
import { SlateVoronoiNoiseBlock } from "./voronoi-noise-block";
import { WaterSurfaceBlock } from "./water-surface-block";
import { MirrorReflectionBlock } from "./mirror-reflection-block";
import type { WaterWavesBlock } from "./water-waves-block";
import { WaterColorsBlock, WaterDepthFadeBlock, WaterFoamBlock, WaterReflectionBlock, WaterSceneColorBlock } from "./water-node-blocks";
import { CurrentScreenBlock } from "@babylonjs/core/Materials/Node/Blocks/Dual/currentScreenBlock";
import { TextureBlock } from "@babylonjs/core/Materials/Node/Blocks/Dual/textureBlock";
import { DerivativeBlock } from "@babylonjs/core/Materials/Node/Blocks/Fragment/derivativeBlock";
import { PerturbNormalBlock } from "@babylonjs/core/Materials/Node/Blocks/Fragment/perturbNormalBlock";
import { FragCoordBlock } from "@babylonjs/core/Materials/Node/Blocks/Fragment/fragCoordBlock";
import { ScreenSizeBlock } from "@babylonjs/core/Materials/Node/Blocks/Fragment/screenSizeBlock";
import { InputBlock } from "@babylonjs/core/Materials/Node/Blocks/Input/inputBlock";
import { AddBlock } from "@babylonjs/core/Materials/Node/Blocks/addBlock";
import { ArcTan2Block } from "@babylonjs/core/Materials/Node/Blocks/arcTan2Block";
import { ClampBlock } from "@babylonjs/core/Materials/Node/Blocks/clampBlock";
import { ConditionalBlock, ConditionalBlockConditions } from "@babylonjs/core/Materials/Node/Blocks/conditionalBlock";
import { ColorConverterBlock } from "@babylonjs/core/Materials/Node/Blocks/colorConverterBlock";
import { CrossBlock } from "@babylonjs/core/Materials/Node/Blocks/crossBlock";
import { DesaturateBlock } from "@babylonjs/core/Materials/Node/Blocks/desaturateBlock";
import { DistanceBlock } from "@babylonjs/core/Materials/Node/Blocks/distanceBlock";
import { DivideBlock } from "@babylonjs/core/Materials/Node/Blocks/divideBlock";
import { DotBlock } from "@babylonjs/core/Materials/Node/Blocks/dotBlock";
import { FresnelBlock } from "@babylonjs/core/Materials/Node/Blocks/fresnelBlock";
import { GradientBlock, GradientBlockColorStep } from "@babylonjs/core/Materials/Node/Blocks/gradientBlock";
import { LengthBlock } from "@babylonjs/core/Materials/Node/Blocks/lengthBlock";
import { LerpBlock } from "@babylonjs/core/Materials/Node/Blocks/lerpBlock";
import { MaxBlock } from "@babylonjs/core/Materials/Node/Blocks/maxBlock";
import { MinBlock } from "@babylonjs/core/Materials/Node/Blocks/minBlock";
import { ModBlock } from "@babylonjs/core/Materials/Node/Blocks/modBlock";
import { MultiplyBlock } from "@babylonjs/core/Materials/Node/Blocks/multiplyBlock";
import { NegateBlock } from "@babylonjs/core/Materials/Node/Blocks/negateBlock";
import { NormalBlendBlock } from "@babylonjs/core/Materials/Node/Blocks/normalBlendBlock";
import { NormalizeBlock } from "@babylonjs/core/Materials/Node/Blocks/normalizeBlock";
import { OneMinusBlock } from "@babylonjs/core/Materials/Node/Blocks/oneMinusBlock";
import { PannerBlock } from "@babylonjs/core/Materials/Node/Blocks/pannerBlock";
import { PosterizeBlock } from "@babylonjs/core/Materials/Node/Blocks/posterizeBlock";
import { PowBlock } from "@babylonjs/core/Materials/Node/Blocks/powBlock";
import { ReciprocalBlock } from "@babylonjs/core/Materials/Node/Blocks/reciprocalBlock";
import { RefractBlock } from "@babylonjs/core/Materials/Node/Blocks/refractBlock";
import { RemapBlock } from "@babylonjs/core/Materials/Node/Blocks/remapBlock";
import { Rotate2dBlock } from "@babylonjs/core/Materials/Node/Blocks/rotate2dBlock";
import { ScaleBlock } from "@babylonjs/core/Materials/Node/Blocks/scaleBlock";
import { SmoothStepBlock } from "@babylonjs/core/Materials/Node/Blocks/smoothStepBlock";
import { StepBlock } from "@babylonjs/core/Materials/Node/Blocks/stepBlock";
import { SubtractBlock } from "@babylonjs/core/Materials/Node/Blocks/subtractBlock";
import { TransformBlock } from "@babylonjs/core/Materials/Node/Blocks/transformBlock";
import { TriPlanarBlock } from "@babylonjs/core/Materials/Node/Blocks/triPlanarBlock";
import {
  TrigonometryBlock,
  TrigonometryBlockOperations,
} from "@babylonjs/core/Materials/Node/Blocks/trigonometryBlock";
import { VectorMergerBlock } from "@babylonjs/core/Materials/Node/Blocks/vectorMergerBlock";
import { VectorSplitterBlock } from "@babylonjs/core/Materials/Node/Blocks/vectorSplitterBlock";
import {
  NodeMaterialBlockConnectionPointTypes,
} from "@babylonjs/core/Materials/Node/Enums/nodeMaterialBlockConnectionPointTypes";
import { NodeMaterialSystemValues } from "@babylonjs/core/Materials/Node/Enums/nodeMaterialSystemValues";
import type { NodeMaterialBlock } from "@babylonjs/core/Materials/Node/nodeMaterialBlock";
import type { NodeMaterialConnectionPoint } from "@babylonjs/core/Materials/Node/nodeMaterialBlockConnectionPoint";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector2, Vector3, Vector4 } from "@babylonjs/core/Maths/math.vector";
import { CustomBlock } from "@babylonjs/core/Materials/Node/Blocks/customBlock";
import { ImageSourceBlock } from "@babylonjs/core/Materials/Node/Blocks/Dual/imageSourceBlock";
import { SceneDepthBlock } from "@babylonjs/core/Materials/Node/Blocks/Dual/sceneDepthBlock";
import { PrePassTextureBlock } from "@babylonjs/core/Materials/Node/Blocks/Input/prePassTextureBlock";
import { SimplexPerlin3DBlock } from "@babylonjs/core/Materials/Node/Blocks/simplexPerlin3DBlock";
import { WorleyNoise3DBlock } from "@babylonjs/core/Materials/Node/Blocks/worleyNoise3DBlock";
import type {
  MaterialOperation,
  MaterialValueType,
} from "@haptic/shader-graph";
import { componentCount, customGlslInterface, materialGradientStops, swizzleComponents, vectorMaskChannels, VECTOR_MASK_CHANNELS } from "@haptic/shader-graph";
import { customGlslFunctionName } from "./material-glsl-diagnostics";

/**
 * One lowered operation realised as Babylon blocks.
 *
 * A single catalog node can need more than one Babylon block (fwidth is
 * derivatives plus absolute values plus an add), so an adapter reports every
 * block it created and the connection points its pins map onto.
 */
export interface BlockRealization {
  blocks: NodeMaterialBlock[];
  inputs: Record<string, NodeMaterialConnectionPoint>;
  /**
   * The further connection points of an input pin that feeds several blocks of a composite; the compiler wires the
   * pin's value to each. A pass-through block is no substitute: Babylon's Elbow builds in the vertex stage behind a
   * constant or a parameter, which costs a varying and hands the fragment stage an interpolated copy.
   */
  fanIn?: Record<string, NodeMaterialConnectionPoint[]>;
  outputs: Record<string, NodeMaterialConnectionPoint>;
}

/**
 * Connection points the compiler owns rather than the graph: world-space
 * geometry for surface materials and the screen UV of the fullscreen pass for
 * post-process materials.
 */
export interface MaterialPlumbing {
  logicalSceneBuffers?: boolean;
  particlePreview?: boolean;
  localNormal?: NodeMaterialConnectionPoint;
  localTangent?: NodeMaterialConnectionPoint;
  position?: NodeMaterialConnectionPoint;
  world?: NodeMaterialConnectionPoint;
  worldPosition?: NodeMaterialConnectionPoint;
  /** The surface's world position before any displacement: the rest point a Water Waves node evaluates at. */
  restWorldPosition?: NodeMaterialConnectionPoint;
  /** The graph's one Water Waves block, when it holds a Water Waves node. */
  waterWaves?: WaterWavesBlock;
  /** Offset used only to restore authored world-space graph input semantics. */
  worldOrigin?: NodeMaterialConnectionPoint;
  view?: NodeMaterialConnectionPoint;
  viewProjection?: NodeMaterialConnectionPoint;
  /** Vector3 for graph pins. */
  worldNormal?: NodeMaterialConnectionPoint;
  /** Vector4 for Babylon blocks that register a Vector4 normal. */
  worldNormal4?: NodeMaterialConnectionPoint;
  worldTangent?: NodeMaterialConnectionPoint;
  cameraPosition?: NodeMaterialConnectionPoint;
  viewDirection?: NodeMaterialConnectionPoint;
  uv?: NodeMaterialConnectionPoint;
  uv2?: NodeMaterialConnectionPoint;
  screenUv?: NodeMaterialConnectionPoint;
  /** Clip-space transform vector input; connected after World Position Offset. */
  clipPosition?: NodeMaterialConnectionPoint;
}

interface BlockAdapterContext {
  operation: MaterialOperation;
  /** Unique, stable block name prefix derived from the operation id. */
  name: string;
  /** Texture asset guid to a live Babylon texture, or null when unavailable. */
  resolveTexture?: (guid: string) => unknown | null;
  plumbing: MaterialPlumbing;
}

type BlockAdapter = (context: BlockAdapterContext) => BlockRealization;

function babylonTypeFor(
  type: MaterialValueType,
): NodeMaterialBlockConnectionPointTypes {
  switch (type) {
    case "vec2":
      return NodeMaterialBlockConnectionPointTypes.Vector2;
    case "vec3":
      return NodeMaterialBlockConnectionPointTypes.Vector3;
    case "vec4":
      return NodeMaterialBlockConnectionPointTypes.Vector4;
    case "texture":
      return NodeMaterialBlockConnectionPointTypes.Object;
    case "float":
    default:
      return NodeMaterialBlockConnectionPointTypes.Float;
  }
}

/** Build the Babylon value object a constant InputBlock expects. */
function babylonValueFor(
  type: MaterialValueType,
  components: readonly number[],
  asColor: boolean,
): unknown {
  const [x = 0, y = 0, z = 0, w = 1] = components;
  switch (type) {
    case "vec2":
      return new Vector2(x, y);
    case "vec3":
      return asColor ? new Color3(x, y, z) : new Vector3(x, y, z);
    case "vec4":
      return asColor ? new Color4(x, y, z, w) : new Vector4(x, y, z, w);
    case "float":
    default:
      return x;
  }
}

/**
 * An input block holding `components`. By default it is a shader constant: the value is written into the shader,
 * so it costs nothing per bind and the driver can fold it. `uniform` keeps it a uniform for a value that changes
 * after the build (a parameter, a global parameter).
 */
export function createConstantBlock(
  name: string,
  type: MaterialValueType,
  components: readonly number[],
  asColor = false,
  uniform = false,
): InputBlock {
  // Colors go through Color3/Color4 so the merged Babylon type matches the
  // pins that PBR and fragment output expect.
  const babylonType = asColor
    ? type === "vec3"
      ? NodeMaterialBlockConnectionPointTypes.Color3
      : NodeMaterialBlockConnectionPointTypes.Color4
    : babylonTypeFor(type);
  // Babylon removes digits from uniform names. Collapse separators first so
  // IDs such as custom_glsl_123_a cannot become reserved double underscores.
  const uniformName = name.replace(/[^A-Za-z]+/g, "_").replace(/^_+|_+$/g, "") || "value";
  const block = new InputBlock(uniformName, undefined, babylonType);
  block.value = babylonValueFor(type, components, asColor);
  block.convertToLinearSpace = asColor;
  // A value that is not finite cannot be written as a shader literal.
  block.isConstant = !uniform && components.every((component) => Number.isFinite(component));
  return block;
}

function attributeVector(
  name: string,
  attribute: string,
  components: 2 | 3 | 4,
): InputBlock {
  const type =
    components === 2
      ? NodeMaterialBlockConnectionPointTypes.Vector2
      : components === 3
        ? NodeMaterialBlockConnectionPointTypes.Vector3
        : NodeMaterialBlockConnectionPointTypes.Vector4;
  const block = new InputBlock(name, undefined, type);
  block.setAsAttribute(attribute);
  return block;
}

function single(
  block: NodeMaterialBlock,
  inputs: Record<string, NodeMaterialConnectionPoint>,
  outputs: Record<string, NodeMaterialConnectionPoint>,
): BlockRealization {
  return { blocks: [block], inputs, outputs };
}

/** `left`/`right`/`output` blocks cover most binary math. */
function binary(
  factory: new (name: string) => NodeMaterialBlock & {
    left: NodeMaterialConnectionPoint;
    right: NodeMaterialConnectionPoint;
    output: NodeMaterialConnectionPoint;
  },
  inputA = "a",
  inputB = "b",
): BlockAdapter {
  return ({ name }) => {
    const block = new factory(name);
    return single(
      block,
      { [inputA]: block.left, [inputB]: block.right },
      { out: block.output },
    );
  };
}

function trigonometry(operation: TrigonometryBlockOperations): BlockAdapter {
  return ({ name }) => {
    const block = new TrigonometryBlock(name);
    block.operation = operation;
    return single(block, { value: block.input }, { out: block.output });
  };
}

/** Trigonometry blocks in sequence: `value` feeds the first, `out` is the last (the Degrees variants). */
function trigonometryChain(...operations: TrigonometryBlockOperations[]): BlockAdapter {
  return ({ name }) => {
    const blocks = operations.map((operation, index) => {
      const block = new TrigonometryBlock(index === operations.length - 1 ? name : `${name}_${index}`);
      block.operation = operation;
      return block;
    });
    for (let index = 1; index < blocks.length; index += 1) blocks[index - 1]!.output.connectTo(blocks[index]!.input);
    return { blocks, inputs: { value: blocks[0]!.input }, outputs: { out: blocks.at(-1)!.output } };
  };
}

/** Lift Babylon's scalar-only operations to the graph's resolved numeric width. */
function componentwise(scalar: BlockAdapter): BlockAdapter {
  return (context) => {
    const { name, operation } = context;
    const width = componentCount(operation.resolvedType);
    if (width === 1) return scalar(context);
    const result = new VectorMergerBlock(`${name}_result`);
    const blocks: NodeMaterialBlock[] = [result];
    const inputs: BlockRealization["inputs"] = {};
    const splitters = new Map<string, VectorSplitterBlock>();
    const axes = ["x", "y", "z", "w"] as const;
    for (const axis of axes.slice(0, width)) {
      const part = scalar({ ...context, name: `${name}_${axis}`, operation: { ...operation, resolvedType: "float" } });
      blocks.push(...part.blocks);
      for (const [pin, input] of Object.entries(part.inputs)) {
        let split = splitters.get(pin);
        if (!split) {
          split = new VectorSplitterBlock(`${name}_${pin}`);
          splitters.set(pin, split);
          blocks.push(split);
          inputs[pin] = width === 2 ? split.xyIn : width === 3 ? split.xyzIn : split.xyzw;
        }
        split[axis].connectTo(input);
        for (const further of part.fanIn?.[pin] ?? []) split[axis].connectTo(further);
      }
      part.outputs.out!.connectTo(result[axis]);
    }
    return { blocks, inputs, outputs: { out: width === 2 ? result.xyOut : width === 3 ? result.xyzOut : result.xyzw } };
  };
}

function conditional(condition: ConditionalBlockConditions): BlockAdapter {
  return componentwise(({ name }) => {
    const block = new ConditionalBlock(name);
    block.condition = condition;
    const trueValue = createConstantBlock(`${name}_true`, "float", [1]);
    const falseValue = createConstantBlock(`${name}_false`, "float", [0]);
    trueValue.output.connectTo(block.true);
    falseValue.output.connectTo(block.false);
    return {
      blocks: [block, trueValue, falseValue],
      inputs: { a: block.a, b: block.b },
      outputs: { out: block.output },
    };
  });
}

/** Links two blocks of a composite whose types only resolve once the compiler wires the node's inputs. */
function link(from: NodeMaterialConnectionPoint, to: NodeMaterialConnectionPoint): void {
  from.connectTo(to, true);
}

function trigBlock(name: string, operation: TrigonometryBlockOperations): TrigonometryBlock {
  const block = new TrigonometryBlock(name);
  block.operation = operation;
  return block;
}

/** 1 where a Float reads as true (above 0.5, as Select reads its Condition) and 0 elsewhere; `invert` swaps the two. */
function maskTest(name: string, invert = false) {
  const block = new ConditionalBlock(name);
  block.condition = ConditionalBlockConditions.GreaterThan;
  const threshold = createConstantBlock(`${name}_threshold`, "float", [0.5]);
  const whenTrue = createConstantBlock(`${name}_true`, "float", [invert ? 0 : 1]);
  const whenFalse = createConstantBlock(`${name}_false`, "float", [invert ? 1 : 0]);
  threshold.output.connectTo(block.b);
  whenTrue.output.connectTo(block.true);
  whenFalse.output.connectTo(block.false);
  return { blocks: [block, threshold, whenTrue, whenFalse] as NodeMaterialBlock[], input: block.a, output: block.output };
}

/** And is the smaller of two masks read as true or false, Or the larger. */
function maskCombine(factory: typeof MinBlock | typeof MaxBlock): BlockAdapter {
  return componentwise(({ name }) => {
    const combined = new factory(`${name}_combined`);
    const test = maskTest(name);
    combined.output.connectTo(test.input, true);
    return { blocks: [combined, ...test.blocks], inputs: { a: combined.left, b: combined.right }, outputs: { out: test.output } };
  });
}

const selectBlock: BlockAdapter = ({ name }) => {
  const block = new ConditionalBlock(name);
  block.condition = ConditionalBlockConditions.GreaterThan;
  const threshold = createConstantBlock(`${name}_threshold`, "float", [0.5]);
  threshold.output.connectTo(block.b);
  return {
    blocks: [block, threshold],
    inputs: { condition: block.a, whenTrue: block.true, whenFalse: block.false },
    outputs: { out: block.output },
  };
};

/**
 * Select picks each component by its own Condition component. A Condition that is one Float for the whole value
 * (the common case) keeps one conditional; only a vector Condition pays for one per component.
 */
const selectAdapter: BlockAdapter = (context) => {
  const { name, operation } = context;
  const width = componentCount(operation.resolvedType);
  const condition = operation.inputs.condition;
  const uniform = !condition || (condition.kind === "constant"
    ? condition.value.every((component) => component === condition.value[0])
    : condition.conversions?.at(-1)?.from === "float");
  if (width === 1) return selectBlock(context);
  if (!uniform) return componentwise(selectBlock)(context);
  const select = selectBlock(context);
  const split = new VectorSplitterBlock(`${name}_condition`);
  split.x.connectTo(select.inputs.condition!);
  return {
    blocks: [...select.blocks, split],
    inputs: { ...select.inputs, condition: width === 2 ? split.xyIn : width === 3 ? split.xyzIn : split.xyzw },
    outputs: select.outputs,
  };
};

/** A Color4 source's RGBA with its RGB and A beside it, the three outputs every color source has. */
function colorOutputs(name: string, color: NodeMaterialConnectionPoint, blocks: NodeMaterialBlock[]): BlockRealization {
  const split = new VectorSplitterBlock(`${name}_channels`);
  color.connectTo(split.xyzw);
  return { blocks: [...blocks, split], inputs: {}, outputs: { color, rgb: split.xyzOut, a: split.w } };
}

/**
 * The cell of a sprite sheet as UVs. Frame 0 is the top left cell, frames run left to right and then down, and a
 * Frame past the last cell starts over. Textures load with V up, so the top row holds the highest V.
 */
const flipbookAdapter: BlockAdapter = ({ name }) => {
  const total = new MultiplyBlock(`${name}_total`);
  const frame = trigBlock(`${name}_frame`, TrigonometryBlockOperations.Floor);
  // frame - total * floor(frame / total): the wrapped frame, never negative on either backend.
  const laps = new DivideBlock(`${name}_laps`);
  link(frame.output, laps.left);
  link(total.output, laps.right);
  const wholeLaps = trigBlock(`${name}_wholeLaps`, TrigonometryBlockOperations.Floor);
  link(laps.output, wholeLaps.input);
  const lapped = new MultiplyBlock(`${name}_lapped`);
  link(total.output, lapped.left);
  link(wholeLaps.output, lapped.right);
  const index = new SubtractBlock(`${name}_index`);
  link(frame.output, index.left);
  link(lapped.output, index.right);
  const rowRatio = new DivideBlock(`${name}_rowRatio`);
  link(index.output, rowRatio.left);
  const row = trigBlock(`${name}_row`, TrigonometryBlockOperations.Floor);
  link(rowRatio.output, row.input);
  const rowStart = new MultiplyBlock(`${name}_rowStart`);
  link(row.output, rowStart.right);
  const column = new SubtractBlock(`${name}_column`);
  link(index.output, column.left);
  link(rowStart.output, column.right);
  const uv = new VectorSplitterBlock(`${name}_uv`);
  const u = new AddBlock(`${name}_u`);
  uv.x.connectTo(u.left);
  link(column.output, u.right);
  const cellU = new DivideBlock(`${name}_cellU`);
  u.output.connectTo(cellU.left);
  const one = createConstantBlock(`${name}_one`, "float", [1]);
  const lastRow = new SubtractBlock(`${name}_lastRow`);
  one.output.connectTo(lastRow.right);
  const fromBottom = new SubtractBlock(`${name}_fromBottom`);
  link(lastRow.output, fromBottom.left);
  link(row.output, fromBottom.right);
  const v = new AddBlock(`${name}_v`);
  uv.y.connectTo(v.left);
  link(fromBottom.output, v.right);
  const cellV = new DivideBlock(`${name}_cellV`);
  v.output.connectTo(cellV.left);
  const result = new VectorMergerBlock(name);
  link(cellU.output, result.x);
  link(cellV.output, result.y);
  return {
    blocks: [total, frame, laps, wholeLaps, lapped, index, rowRatio, row, rowStart, column, uv, u, cellU, one, lastRow, fromBottom, v, cellV, result],
    inputs: { uv: uv.xyIn, columns: total.left, rows: total.right, frame: frame.input },
    fanIn: { columns: [rowRatio.right, rowStart.left, cellU.right], rows: [lastRow.left, cellV.right] },
    outputs: { out: result.xyOut },
  };
};

/** Overlay per component: 2ab where the base is below 0.5, else 1 - 2(1 - a)(1 - b). */
const blendOverlayAdapter = componentwise(({ name }) => {
  const two = createConstantBlock(`${name}_two`, "float", [2]);
  const product = new MultiplyBlock(`${name}_product`);
  const dark = new MultiplyBlock(`${name}_dark`);
  link(product.output, dark.left);
  two.output.connectTo(dark.right);
  const inverseBase = new OneMinusBlock(`${name}_inverseBase`);
  const inverseBlend = new OneMinusBlock(`${name}_inverseBlend`);
  const inverseProduct = new MultiplyBlock(`${name}_inverseProduct`);
  link(inverseBase.output, inverseProduct.left);
  link(inverseBlend.output, inverseProduct.right);
  const doubled = new MultiplyBlock(`${name}_doubled`);
  link(inverseProduct.output, doubled.left);
  two.output.connectTo(doubled.right);
  const light = new OneMinusBlock(`${name}_light`);
  link(doubled.output, light.input);
  const pick = new ConditionalBlock(name);
  pick.condition = ConditionalBlockConditions.LessThan;
  const half = createConstantBlock(`${name}_half`, "float", [0.5]);
  half.output.connectTo(pick.b);
  link(dark.output, pick.true);
  link(light.output, pick.false);
  return {
    blocks: [two, product, dark, inverseBase, inverseBlend, inverseProduct, doubled, light, pick, half],
    inputs: { base: product.left, blend: product.right },
    fanIn: { base: [inverseBase.input, pick.a], blend: [inverseBlend.input] },
    outputs: { out: pick.output },
  };
});

const dotAdapter: BlockAdapter = (context) =>
  binary(context.operation.resolvedType === "float" ? MultiplyBlock : DotBlock)(context);

/** reflect(I, N) = I - 2 * dot(N, I) * N, preserving every resolved channel. */
const reflectAdapter: BlockAdapter = (context) => {
  const { name } = context;
  const dot = dotAdapter({ ...context, name: `${name}_dot` });
  const twice = new ScaleBlock(`${name}_twice`);
  const two = createConstantBlock(`${name}_two`, "float", [2]);
  link(dot.outputs.out!, twice.input);
  two.output.connectTo(twice.factor);
  const projected = new ScaleBlock(`${name}_projected`);
  link(twice.output, projected.factor);
  const result = new SubtractBlock(name);
  link(projected.output, result.right);
  return {
    blocks: [...dot.blocks, twice, two, projected, result],
    inputs: { incident: dot.inputs.a!, normal: dot.inputs.b! },
    fanIn: { incident: [result.left], normal: [projected.input] },
    outputs: { out: result.output },
  };
};

/**
 * Modulo with the sign of A on every backend: `sign(a) * mod(|a|, |b|)`. Babylon's block alone is
 * GLSL `mod` (the sign of B) on WebGL2 and WGSL `%` (the sign of A) on WebGPU; the two agree
 * once both operands are positive.
 */
const moduloAdapter: BlockAdapter = ({ name }) => {
  const absA = trigBlock(`${name}_absA`, TrigonometryBlockOperations.Abs);
  const absB = trigBlock(`${name}_absB`, TrigonometryBlockOperations.Abs);
  const sign = trigBlock(`${name}_sign`, TrigonometryBlockOperations.Sign);
  const mod = new ModBlock(`${name}_mod`);
  const result = new MultiplyBlock(name);
  link(absA.output, mod.left);
  link(absB.output, mod.right);
  link(sign.output, result.left);
  link(mod.output, result.right);
  return {
    blocks: [absA, absB, sign, mod, result],
    inputs: { a: absA.input, b: absB.input },
    fanIn: { a: [sign.input] },
    outputs: { out: result.output },
  };
};

/**
 * A 3D noise block's realisation. With Coordinates unwired it exposes a `uv` input instead, which
 * the compiler feeds the mesh or screen UV like any unwired UV: the noise then shows its pattern
 * at once, as Voronoi does, where a constant coordinate would give one flat value.
 */
function noiseCoordinates(
  name: string,
  block: NodeMaterialBlock,
  seed: NodeMaterialConnectionPoint,
  unwired: boolean,
  inputs: Record<string, NodeMaterialConnectionPoint>,
  outputs: Record<string, NodeMaterialConnectionPoint>,
): BlockRealization {
  if (!unwired) return single(block, { coordinates: seed, ...inputs }, outputs);
  // (u, v, 1): what wiring the UV node into Coordinates gives, by the vector widening rule.
  const flat = new VectorMergerBlock(`${name}_uv`);
  const depth = createConstantBlock(`${name}_uvDepth`, "float", [1]);
  depth.output.connectTo(flat.z);
  flat.xyzOut.connectTo(seed);
  return { blocks: [flat, depth, block], inputs: { uv: flat.xyIn, ...inputs }, outputs };
}

/** Babylon has no fwidth block; compose it from the derivative pair. */
const fwidthAdapter: BlockAdapter = ({ name }) => {
  const derivative = new DerivativeBlock(name);
  const absX = new TrigonometryBlock(`${name}_absX`);
  absX.operation = TrigonometryBlockOperations.Abs;
  const absY = new TrigonometryBlock(`${name}_absY`);
  absY.operation = TrigonometryBlockOperations.Abs;
  const sum = new AddBlock(`${name}_sum`);
  derivative.dx.connectTo(absX.input);
  derivative.dy.connectTo(absY.input);
  absX.output.connectTo(sum.left);
  absY.output.connectTo(sum.right);
  return {
    blocks: [derivative, absX, absY, sum],
    inputs: { value: derivative.input },
    outputs: { out: sum.output },
  };
};

/** log2(x) is the natural log scaled by 1/ln(2). */
const log2Adapter: BlockAdapter = ({ name }) => {
  const log = new TrigonometryBlock(name);
  log.operation = TrigonometryBlockOperations.Log;
  const scale = new ScaleBlock(`${name}_scale`);
  const factor = createConstantBlock(`${name}_factor`, "float", [Math.LOG2E]);
  log.output.connectTo(scale.input);
  factor.output.connectTo(scale.factor);
  return {
    blocks: [log, scale, factor],
    inputs: { value: log.input },
    outputs: { out: scale.output },
  };
};

const inverseSqrtAdapter: BlockAdapter = ({ name }) => {
  const sqrt = new TrigonometryBlock(name);
  sqrt.operation = TrigonometryBlockOperations.Sqrt;
  const reciprocal = new ReciprocalBlock(`${name}_reciprocal`);
  sqrt.output.connectTo(reciprocal.input);
  return {
    blocks: [sqrt, reciprocal],
    inputs: { value: sqrt.input },
    outputs: { out: reciprocal.output },
  };
};

const saturateAdapter: BlockAdapter = ({ name }) => {
  const clamp = new ClampBlock(name);
  clamp.minimum = 0;
  clamp.maximum = 1;
  return single(clamp, { value: clamp.value }, { out: clamp.output });
};

/** Dynamic bounds need graph inputs; Babylon ClampBlock only has properties. */
const clampAdapter: BlockAdapter = ({ name }) => {
  const lower = new MaxBlock(`${name}_lower`);
  const upper = new MinBlock(`${name}_upper`);
  lower.output.connectTo(upper.left);
  return { blocks: [lower, upper], inputs: { value: lower.left, min: lower.right, max: upper.right }, outputs: { out: upper.output } };
};

const systemInput = (
  systemValue: NodeMaterialSystemValues,
  type: NodeMaterialBlockConnectionPointTypes,
  pinId: string,
): BlockAdapter => {
  return ({ name }) => {
    const block = new InputBlock(name, undefined, type);
    block.setAsSystemValue(systemValue);
    return single(block, {}, { [pinId]: block.output });
  };
};

const attributeInput = (
  attribute: string,
  type: NodeMaterialBlockConnectionPointTypes,
  pinId: string,
): BlockAdapter => {
  return ({ name }) => {
    const block = new InputBlock(name, undefined, type);
    block.setAsAttribute(attribute);
    return single(block, {}, { [pinId]: block.output });
  };
};

const ADAPTERS: Record<string, BlockAdapter> = {
  "noise.perlin": ({ name, operation }) => {
    const block = new SimplexPerlin3DBlock(name);
    return noiseCoordinates(name, block, block.seed, operation.inputs.coordinates === undefined, {}, { out: block.output });
  },
  "noise.voronoi": ({ name }) => {
    const block = new SlateVoronoiNoiseBlock(name);
    return single(block, { uv: block.seed, offset: block.offset, density: block.density }, { out: block.output, cells: block.cells });
  },
  "noise.worley": ({ name, operation }) => {
    const block = new WorleyNoise3DBlock(name);
    return noiseCoordinates(name, block, block.seed, operation.inputs.coordinates === undefined,
      { jitter: block.jitter }, { out: block.output, f1: block.x, f2: block.y });
  },
  "math.oneMinus": ({ name }) => {
    const block = new OneMinusBlock(name);
    return single(block, { value: block.input }, { out: block.output });
  },
  "math.add": binary(AddBlock),
  "math.subtract": binary(SubtractBlock),
  "math.multiply": binary(MultiplyBlock),
  "math.divide": binary(DivideBlock),
  "math.min": binary(MinBlock),
  "math.max": binary(MaxBlock),
  "math.mod": moduloAdapter,
  "math.negate": ({ name }) => {
    const block = new NegateBlock(name);
    return single(block, { value: block.value }, { out: block.output });
  },
  "math.reciprocal": ({ name }) => {
    const block = new ReciprocalBlock(name);
    return single(block, { value: block.input }, { out: block.output });
  },
  "math.radians": trigonometry(TrigonometryBlockOperations.Radians),
  "math.degrees": trigonometry(TrigonometryBlockOperations.Degrees),
  "math.sin": trigonometry(TrigonometryBlockOperations.Sin),
  "math.cos": trigonometry(TrigonometryBlockOperations.Cos),
  "math.tan": trigonometry(TrigonometryBlockOperations.Tan),
  "math.asin": trigonometry(TrigonometryBlockOperations.ArcSin),
  "math.acos": trigonometry(TrigonometryBlockOperations.ArcCos),
  "math.atan": trigonometry(TrigonometryBlockOperations.ArcTan),
  "math.atan2": componentwise(({ name }) => {
    const block = new ArcTan2Block(name);
    // Babylon names its first atan(y, x) argument `x`.
    return single(block, { y: block.x, x: block.y }, { out: block.output });
  }),
  "math.sinDegrees": trigonometryChain(TrigonometryBlockOperations.Radians, TrigonometryBlockOperations.Sin),
  "math.cosDegrees": trigonometryChain(TrigonometryBlockOperations.Radians, TrigonometryBlockOperations.Cos),
  "math.tanDegrees": trigonometryChain(TrigonometryBlockOperations.Radians, TrigonometryBlockOperations.Tan),
  "math.asinDegrees": trigonometryChain(TrigonometryBlockOperations.ArcSin, TrigonometryBlockOperations.Degrees),
  "math.acosDegrees": trigonometryChain(TrigonometryBlockOperations.ArcCos, TrigonometryBlockOperations.Degrees),
  "math.atanDegrees": trigonometryChain(TrigonometryBlockOperations.ArcTan, TrigonometryBlockOperations.Degrees),
  "math.atan2Degrees": componentwise(({ name }) => {
    const block = new ArcTan2Block(`${name}_radians`);
    const degrees = new TrigonometryBlock(name);
    degrees.operation = TrigonometryBlockOperations.Degrees;
    block.output.connectTo(degrees.input);
    return { blocks: [block, degrees], inputs: { y: block.x, x: block.y }, outputs: { out: degrees.output } };
  }),
  "math.pow": ({ name }) => {
    const block = new PowBlock(name);
    return single(
      block,
      { base: block.value, exponent: block.power },
      { out: block.output },
    );
  },
  "math.exp": trigonometry(TrigonometryBlockOperations.Exp),
  "math.exp2": trigonometry(TrigonometryBlockOperations.Exp2),
  "math.log": trigonometry(TrigonometryBlockOperations.Log),
  "math.log2": log2Adapter,
  "math.sqrt": trigonometry(TrigonometryBlockOperations.Sqrt),
  "math.inverseSqrt": inverseSqrtAdapter,
  "math.abs": trigonometry(TrigonometryBlockOperations.Abs),
  "math.sign": trigonometry(TrigonometryBlockOperations.Sign),
  "math.floor": trigonometry(TrigonometryBlockOperations.Floor),
  "math.ceil": trigonometry(TrigonometryBlockOperations.Ceiling),
  "math.round": trigonometry(TrigonometryBlockOperations.Round),
  "math.fract": trigonometry(TrigonometryBlockOperations.Fract),
  "math.clamp": clampAdapter,
  "math.saturate": saturateAdapter,
  "math.mix": ({ name }) => {
    const block = new LerpBlock(name);
    return single(
      block,
      { a: block.left, b: block.right, alpha: block.gradient },
      { out: block.output },
    );
  },
  "math.step": componentwise(({ name }) => {
    const block = new StepBlock(name);
    return single(
      block,
      { edge: block.edge, value: block.value },
      { out: block.output },
    );
  }),
  "math.smoothstep": componentwise(({ name }) => {
    const block = new SmoothStepBlock(name);
    return single(
      block,
      { edgeA: block.edge0, edgeB: block.edge1, value: block.value },
      { out: block.output },
    );
  }),
  "math.remap": componentwise(({ name }) => {
    const block = new RemapBlock(name);
    return single(
      block,
      {
        value: block.input,
        fromMin: block.sourceMin,
        fromMax: block.sourceMax,
        toMin: block.targetMin,
        toMax: block.targetMax,
      },
      { out: block.output },
    );
  }),
  "vector.dot": dotAdapter,
  "vector.cross": binary(CrossBlock),
  "vector.distance": (context) => {
    if (context.operation.resolvedType !== "float") return binary(DistanceBlock)(context);
    const difference = binary(SubtractBlock)(context);
    const absolute = trigonometry(TrigonometryBlockOperations.Abs)({ ...context, name: `${context.name}_absolute` });
    difference.outputs.out!.connectTo(absolute.inputs.value!);
    return { blocks: [...difference.blocks, ...absolute.blocks], inputs: difference.inputs, outputs: absolute.outputs };
  },
  "vector.length": (context) => {
    if (context.operation.resolvedType === "float") return trigonometry(TrigonometryBlockOperations.Abs)(context);
    const { name } = context;
    const block = new LengthBlock(name);
    return single(block, { value: block.value }, { out: block.output });
  },
  "vector.normalize": (context) => {
    if (context.operation.resolvedType === "float") return trigonometry(TrigonometryBlockOperations.Sign)(context);
    const { name } = context;
    const block = new NormalizeBlock(name);
    return single(block, { value: block.input }, { out: block.output });
  },
  "vector.reflect": reflectAdapter,
  "vector.refract": ({ name }) => {
    const block = new RefractBlock(name);
    return single(
      block,
      { incident: block.incident, normal: block.normal, eta: block.ior },
      { out: block.output },
    );
  },
  "vector.combine": ({ name }) => {
    const block = new VectorMergerBlock(name);
    return {
      blocks: [block],
      inputs: { x: block.x, y: block.y, z: block.z, w: block.w },
      outputs: {
        xy: block.xyOut,
        xyz: block.xyzOut,
        xyzw: block.xyzw,
      },
    };
  },
  "vector.mask": ({ name, operation }): BlockRealization => {
    const split = new VectorSplitterBlock(`${name}_split`);
    const value = split.xyzw;
    const channels = vectorMaskChannels(operation.properties).map((channel) => [split.x, split.y, split.z, split.w][VECTOR_MASK_CHANNELS.indexOf(channel)]!);
    if (channels.length === 1) return { blocks: [split], inputs: { value }, outputs: { out: channels[0]! } };
    const merge = new VectorMergerBlock(`${name}_merge`);
    channels.forEach((channel, index) => channel.connectTo([merge.x, merge.y, merge.z, merge.w][index]!));
    return { blocks: [split, merge], inputs: { value }, outputs: { out: channels.length === 2 ? merge.xyOut : channels.length === 3 ? merge.xyzOut : merge.xyzw } };
  },
  "vector.swizzle": ({ name, operation }): BlockRealization => {
    const split = new VectorSplitterBlock(`${name}_split`);
    const axes = swizzleComponents(operation.properties).map((axis) => split[axis]);
    if (axes.length === 1) return { blocks: [split], inputs: { value: split.xyzw }, outputs: { out: axes[0]! } };
    const merge = new VectorMergerBlock(`${name}_merge`);
    axes.forEach((axis, index) => axis.connectTo([merge.x, merge.y, merge.z, merge.w][index]!));
    return { blocks: [split, merge], inputs: { value: split.xyzw }, outputs: { out: axes.length === 2 ? merge.xyOut : axes.length === 3 ? merge.xyzOut : merge.xyzw } };
  },
  "vector.split": ({ name }): BlockRealization => {
    const block = new VectorSplitterBlock(name);
    return {
      blocks: [block],
      inputs: { value: block.xyzw },
      outputs: { x: block.x, y: block.y, z: block.z, w: block.w },
    };
  },
  "logic.equal": conditional(ConditionalBlockConditions.Equal),
  "logic.notEqual": conditional(ConditionalBlockConditions.NotEqual),
  "logic.lessThan": conditional(ConditionalBlockConditions.LessThan),
  "logic.greaterThan": conditional(ConditionalBlockConditions.GreaterThan),
  "logic.lessOrEqual": conditional(ConditionalBlockConditions.LessOrEqual),
  "logic.greaterOrEqual": conditional(ConditionalBlockConditions.GreaterOrEqual),
  "logic.and": maskCombine(MinBlock),
  "logic.or": maskCombine(MaxBlock),
  "logic.not": componentwise(({ name }) => {
    const test = maskTest(name, true);
    return { blocks: test.blocks, inputs: { value: test.input }, outputs: { out: test.output } };
  }),
  "logic.select": selectAdapter,
  "derivative.ddx": ({ name }) => {
    const block = new DerivativeBlock(name);
    return single(block, { value: block.input }, { out: block.dx });
  },
  "derivative.ddy": ({ name }) => {
    const block = new DerivativeBlock(name);
    return single(block, { value: block.input }, { out: block.dy });
  },
  "derivative.fwidth": fwidthAdapter,
  "input.uv": ({ name, plumbing, operation }) => {
    // Channel 1 is a mesh's second UV set (glTF TEXCOORD_1); particles and glyphs have one UV set.
    const second = operation.properties.channel === 1;
    const provided = second ? plumbing.uv2 ?? plumbing.uv : plumbing.uv;
    if (provided) {
      return { blocks: [], inputs: {}, outputs: { uv: provided } };
    }
    const block = new InputBlock(
      name,
      undefined,
      NodeMaterialBlockConnectionPointTypes.Vector2,
    );
    block.setAsAttribute(second ? "uv2" : "uv");
    return single(block, {}, { uv: block.output });
  },
  "input.vertexColor": (context) => {
    const color = attributeInput("color", NodeMaterialBlockConnectionPointTypes.Color4, "color")(context);
    return colorOutputs(context.name, color.outputs.color!, color.blocks);
  },
  "input.particleColor": (context) => {
    if (!context.plumbing.particlePreview) {
      const color = attributeInput("particle_color", NodeMaterialBlockConnectionPointTypes.Color4, "color")(context);
      return colorOutputs(context.name, color.outputs.color!, color.blocks);
    }
    const block = new InputBlock(context.name); block.value = new Color4(1, 1, 1, 1);
    return colorOutputs(context.name, block.output, [block]);
  },
  "input.time": ({ name }) => {
    const block = new GameTimeInputBlock(name);
    return single(block, {}, { time: block.output });
  },
  "input.waterSurface": ({ name, plumbing }) => {
    const block = new WaterSurfaceBlock(name);
    // With a Water Waves node the water mesh uploads no displaced vertices: Wave Height and Simulation Time follow that node.
    plumbing.waterWaves?.height.connectTo(block.gpuWaveHeight);
    plumbing.waterWaves?.time.connectTo(block.gpuTime);
    return single(block, {}, Object.fromEntries(block.outputs.map((output) => [output.name, output])));
  },
  "input.waterWaves": ({ plumbing }) => {
    // The compiler creates the one block, at the rest world position, before any node is realized.
    const block = plumbing.waterWaves;
    if (!block) throw new Error("Water Waves is only available in a Surface material");
    return { blocks: [], inputs: {}, outputs: { offset: block.offset, height: block.height, normal: block.normal, crestFoam: block.crestFoam, subsurface: block.subsurface, time: block.time } };
  },
  // The water nodes read the graph's Water Waves block per pixel where there is one: Wave Height and Crest Foam, and its
  // Normal for an unconnected Normal pin.
  "input.waterColors": ({ name }) => {
    const block = new WaterColorsBlock(name);
    return { blocks: [block], inputs: {}, outputs: { shallowColor: block.shallowColor, deepColor: block.deepColor, foamColor: block.foamColor, opacity: block.opacity, sceneLight: block.sceneLight } };
  },
  "input.waterFoam": ({ name, plumbing }) => {
    const block = new WaterFoamBlock(name);
    plumbing.worldPosition?.connectTo(block.worldPosition);
    plumbing.waterWaves?.height.connectTo(block.waveHeight);
    plumbing.waterWaves?.crestFoam.connectTo(block.crestFoam);
    plumbing.waterWaves?.edgeTurbulence.connectTo(block.edgeTurbulence);
    return { blocks: [block], inputs: {}, outputs: { foam: block.foam, crestFoam: block.crest, shoreFoam: block.shore, contactFoam: block.contact } };
  },
  "input.waterDepthFade": ({ name, plumbing }) => {
    const block = new WaterDepthFadeBlock(name);
    plumbing.worldPosition?.connectTo(block.worldPosition);
    plumbing.cameraPosition?.connectTo(block.cameraPosition);
    plumbing.view?.connectTo(block.view);
    plumbing.waterWaves?.height.connectTo(block.waveHeight);
    plumbing.waterWaves?.normal.connectTo(block.waveNormal);
    return { blocks: [block], inputs: { distance: block.distance }, outputs: { depth: block.depth, fade: block.fade, transmittance: block.transmittance, edgeFade: block.edgeFade } };
  },
  "input.waterSceneColor": ({ name, plumbing, operation }) => {
    const block = new WaterSceneColorBlock(name);
    plumbing.worldPosition?.connectTo(block.worldPosition);
    plumbing.view?.connectTo(block.view);
    if (!operation.inputs.normal) plumbing.waterWaves?.normal.connectTo(block.waveNormal);
    return { blocks: [block], inputs: { normal: block.normal, refraction: block.refraction }, outputs: { color: block.color, available: block.available } };
  },
  "input.waterReflection": ({ name, plumbing, operation }) => {
    const block = new WaterReflectionBlock(name);
    plumbing.worldPosition?.connectTo(block.worldPosition);
    plumbing.cameraPosition?.connectTo(block.cameraPosition);
    plumbing.view?.connectTo(block.view);
    plumbing.viewProjection?.connectTo(block.viewProjection);
    if (!operation.inputs.normal) plumbing.waterWaves?.normal.connectTo(block.waveNormal);
    plumbing.waterWaves?.height.connectTo(block.waveHeight);
    return { blocks: [block], inputs: { normal: block.normal, roughness: block.roughness }, outputs: { color: block.color, fresnel: block.fresnel, shadingNormal: block.shadingNormal, shadingRoughness: block.shadingRoughness } };
  },
  "input.cameraPosition": ({ name, plumbing }) => {
    const relative: BlockRealization = plumbing.cameraPosition
      ? { blocks: [], inputs: {}, outputs: { position: plumbing.cameraPosition } }
      : systemInput(
      NodeMaterialSystemValues.CameraPosition,
      NodeMaterialBlockConnectionPointTypes.Vector3,
      "position",
    )({ name, plumbing, operation: undefined as never });
    if (!plumbing.worldOrigin) return relative;
    const absolute = new AddBlock(`${name}_absolute`);
    relative.outputs.position!.connectTo(absolute.left);
    plumbing.worldOrigin.connectTo(absolute.right);
    return { blocks: [...relative.blocks, absolute], inputs: {}, outputs: { position: absolute.output } };
  },
  "input.screenSize": ({ name }) => {
    const block = new ScreenSizeBlock(name);
    return single(block, {}, { size: block.xy });
  },
  "input.screenUv": ({ name, plumbing }) => {
    // A post-process reads the fullscreen pass position the compiler derives; any other material divides the
    // pixel's coordinate by the screen size. Both run 0 to 1 from the bottom left, on WebGL2 and WebGPU alike.
    if (plumbing.screenUv) return { blocks: [], inputs: {}, outputs: { uv: plumbing.screenUv } };
    const pixel = new FragCoordBlock(`${name}_pixel`);
    const size = new ScreenSizeBlock(`${name}_size`);
    const uv = new DivideBlock(name);
    pixel.xy.connectTo(uv.left);
    size.xy.connectTo(uv.right);
    return { blocks: [pixel, size, uv], inputs: {}, outputs: { uv: uv.output } };
  },
  "input.sceneColor": ({ name }) => {
    const block = new CurrentScreenBlock(name);
    return single(block, { uv: block.uv }, { color: block.rgba, rgb: block.rgb, a: block.a });
  },
  "input.mirrorReflection": ({ name, plumbing }) => {
    // A Mirror surface's reflection at its own screen position; black on any other mesh.
    if (!plumbing.worldPosition) throw new Error("Mirror Reflection is only available in a Surface material");
    const block = new MirrorReflectionBlock(name);
    plumbing.worldPosition.connectTo(block.worldPosition);
    return single(block, { offset: block.offset }, { color: block.color });
  },
  "input.environmentSample": ({ name }) => {
    const block = new EnvironmentSampleBlock(name);
    return single(block, { direction: block.direction, roughness: block.roughness }, { color: block.color });
  },
  "texture.transformUv": ({ name }) => {
    // Tiling, then Rotation around the UV origin, then Offset.
    const scale = new MultiplyBlock(name);
    const rotate = new Rotate2dBlock(`${name}_rotation`);
    const offset = new AddBlock(`${name}_offset`);
    // Multiply's output takes its type from the UV it is given; Rotate 2D's input is Vector2.
    scale.output.connectTo(rotate.input, true);
    rotate.output.connectTo(offset.left);
    return {
      blocks: [scale, rotate, offset],
      inputs: {
        uv: scale.left,
        tiling: scale.right,
        rotation: rotate.angle,
        offset: offset.right,
      },
      outputs: { out: offset.output },
    };
  },
  "texture.panner": ({ name, operation }) => {
    const block = new PannerBlock(name);
    const blocks: NodeMaterialBlock[] = [block];
    if (!operation.inputs.time) {
      // Unwired, Time is the game's own clock, as the Time node gives it.
      const time = new GameTimeInputBlock(`${name}_time`);
      time.output.connectTo(block.time);
      blocks.push(time);
    }
    return { blocks, inputs: { uv: block.uv, speed: block.speed, time: block.time }, outputs: { out: block.output } };
  },
  "texture.rotator": ({ name }) => {
    // Rotation around Center: move Center to the origin, rotate, move back.
    const offset = new SubtractBlock(`${name}_offset`);
    const rotate = new Rotate2dBlock(`${name}_rotation`);
    // Subtract's output takes its type from the UV it is given; Rotate 2D's input is Vector2.
    link(offset.output, rotate.input);
    const result = new AddBlock(name);
    rotate.output.connectTo(result.left);
    return {
      blocks: [offset, rotate, result],
      inputs: { uv: offset.left, center: offset.right, angle: rotate.angle },
      fanIn: { center: [result.right] },
      outputs: { out: result.output },
    };
  },
  "texture.flipbook": flipbookAdapter,
  "texture.triplanar": (context) => {
    const { name, operation, plumbing } = context;
    if (!plumbing.worldPosition || !plumbing.worldNormal) throw new Error("Triplanar is only available in a Surface material");
    const block = new TriPlanarBlock(name);
    block.convertToLinearSpace = operation.properties.colorSpace !== "data";
    // The absolute world position, so the pattern stays put when the render origin moves.
    const position = ADAPTERS["input.worldPosition"]!({ ...context, name: `${name}_position` });
    const scaled = new ScaleBlock(`${name}_scaled`);
    position.outputs.position!.connectTo(scaled.input);
    scaled.output.connectTo(block.position);
    plumbing.worldNormal.connectTo(block.normal);
    return {
      blocks: [...position.blocks, scaled, block],
      inputs: { texture: block.source, scale: scaled.factor, sharpness: block.sharpness },
      outputs: { rgba: block.rgba, rgb: block.rgb, a: block.a },
    };
  },
  "shading.normalBlend": ({ name }) => {
    const block = new NormalBlendBlock(name);
    return single(block, { a: block.normalMap0, b: block.normalMap1 }, { out: block.output });
  },
  "color.luminance": ({ name }) => {
    // The weights Desaturate turns a color gray by, so the two nodes agree.
    const weights = createConstantBlock(`${name}_weights`, "vec3", [0.3, 0.59, 0.11]);
    const block = new DotBlock(name);
    weights.output.connectTo(block.right);
    return { blocks: [block, weights], inputs: { color: block.left }, outputs: { out: block.output } };
  },
  "color.contrast": ({ name }) => {
    // (Color - 0.5) * Contrast + 0.5: mid gray stays, everything else moves away from or toward it.
    const middle = createConstantBlock(`${name}_middle`, "vec3", [0.5, 0.5, 0.5]);
    const centered = new SubtractBlock(`${name}_centered`);
    middle.output.connectTo(centered.right);
    const scaled = new ScaleBlock(`${name}_scaled`);
    centered.output.connectTo(scaled.input);
    const result = new AddBlock(name);
    scaled.output.connectTo(result.left);
    middle.output.connectTo(result.right);
    return {
      blocks: [middle, centered, scaled, result],
      inputs: { color: centered.left, contrast: scaled.factor },
      outputs: { out: result.output },
    };
  },
  "color.posterize": ({ name }) => {
    const block = new PosterizeBlock(name);
    return single(block, { value: block.value, steps: block.steps }, { out: block.output });
  },
  "color.blendScreen": ({ name }) => {
    // 1 - (1 - Base)(1 - Blend).
    const inverseBase = new OneMinusBlock(`${name}_inverseBase`);
    const inverseBlend = new OneMinusBlock(`${name}_inverseBlend`);
    const product = new MultiplyBlock(`${name}_product`);
    inverseBase.output.connectTo(product.left);
    inverseBlend.output.connectTo(product.right);
    const result = new OneMinusBlock(name);
    product.output.connectTo(result.input);
    return {
      blocks: [inverseBase, inverseBlend, product, result],
      inputs: { base: inverseBase.input, blend: inverseBlend.input },
      outputs: { out: result.output },
    };
  },
  "color.blendOverlay": blendOverlayAdapter,
  "color.rgbToHsl": ({ name }) => {
    const block = new ColorConverterBlock(name);
    return single(block, { color: block.rgbIn }, { out: block.hslOut });
  },
  "color.hslToRgb": ({ name }) => {
    const block = new ColorConverterBlock(name);
    return single(block, { hsl: block.hslIn }, { out: block.rgbOut });
  },
  "color.desaturate": ({ name }) => {
    const block = new DesaturateBlock(name);
    return single(
      block,
      { color: block.color, level: block.level },
      { out: block.output },
    );
  },
  "color.gradient": ({ name, operation }) => {
    const block = new GradientBlock(name);
    const stops = [...new Map(materialGradientStops(operation.properties.stops).map((stop) => [stop.position, stop])).values()];
    if (stops.length === 1) stops.push({ position: stops[0]!.position === 1 ? 0 : 1, color: stops[0]!.color });
    // A stop's colour is picked like a Color node's, so it goes to linear space as that one does (`createConstantBlock`),
    // by the exact sRGB curve the Engine is created with (`useExactSrgbConversions`).
    block.colorSteps = stops.sort((a, b) => a.position - b.position)
      .map((stop) => new GradientBlockColorStep(stop.position, Color3.FromArray(stop.color).toLinearSpace(true)));
    return single(block, { value: block.gradient }, { out: block.output });
  },
  /**
   * Rim Fresnel: saturate(pow(saturate(Bias + 1 - |N·V|), Power)), 0 facing the camera and 1 at the
   * silhouette. Babylon's FresnelBlock is the opposite (1 facing); with bias 0 and power 1 it supplies
   * |N·V| from the shared view plumbing. The inner saturate keeps a negative Bias out of pow.
   */
  "shading.fresnel": ({ name, plumbing }) => {
    const facing = new FresnelBlock(name);
    // Babylon's block reads the normal as it is: of unit length, the term no longer follows the mesh's scale.
    const normal = new NormalizeBlock(`${name}_normal`);
    plumbing.worldNormal4?.connectTo(normal.input);
    normal.output.connectTo(facing.worldNormal);
    plumbing.viewDirection?.connectTo(facing.viewDirection);
    const facingBias = createConstantBlock(`${name}_facingBias`, "float", [0]);
    const facingPower = createConstantBlock(`${name}_facingPower`, "float", [1]);
    facingBias.output.connectTo(facing.bias);
    facingPower.output.connectTo(facing.power);
    const edge = new OneMinusBlock(`${name}_edge`);
    facing.fresnel.connectTo(edge.input);
    const biased = new AddBlock(`${name}_bias`);
    edge.output.connectTo(biased.left);
    const base = new ClampBlock(`${name}_base`);
    const rim = new ClampBlock(`${name}_rim`);
    for (const clamp of [base, rim]) {
      clamp.minimum = 0;
      clamp.maximum = 1;
    }
    biased.output.connectTo(base.value);
    const shaped = new PowBlock(`${name}_power`);
    base.output.connectTo(shaped.value);
    shaped.output.connectTo(rim.value);
    return {
      blocks: [normal, facing, facingBias, facingPower, edge, biased, base, shaped, rim],
      inputs: { bias: biased.right, power: shaped.power },
      outputs: { out: rim.output },
    };
  },
  "shading.normalMap": ({ name, plumbing, operation }) => {
    const block = new PerturbNormalBlock(name);
    plumbing.worldPosition?.connectTo(block.worldPosition);
    // Without tangents Babylon's block builds its frame around the normal as it is: of unit length, the map's
    // strength no longer follows the mesh's scale.
    const normal = new NormalizeBlock(`${name}_normal`);
    plumbing.worldNormal4?.connectTo(normal.input);
    normal.output.connectTo(block.worldNormal);
    if (!operation.inputs.uv) plumbing.uv?.connectTo(block.uv);
    // Babylon emits a Vector4 normal; the graph pin is a Vector3.
    const split = new VectorSplitterBlock(`${name}_xyz`);
    block.output.connectTo(split.xyzw);
    return {
      blocks: [normal, block, split],
      inputs: { packed: block.normalMapColor, uv: block.uv, strength: block.strength },
      outputs: { normal: split.xyzOut },
    };
  },
};

/**
 * Texture nodes need the resolved asset, so they are built outside the plain
 * adapter table.
 */
function textureSampleAdapter(lod: boolean): BlockAdapter {
  return ({ name, operation }) => {
    const block = new QualityTextureBlock(name, true);
    block.convertToLinearSpace = operation.properties.colorSpace !== "data";
    const inputs: Record<string, NodeMaterialConnectionPoint> = {
      uv: block.uv,
      texture: block.source,
    };
    if (lod) inputs.lod = block.lod;
    const outputs: Record<string, NodeMaterialConnectionPoint> = {
      rgba: block.rgba,
      rgb: block.rgb,
      r: block.r,
      g: block.g,
      b: block.b,
      a: block.a,
    };
    const blocks: NodeMaterialBlock[] = [block];
    if (!operation.inputs.texture) {
      const source = new ImageSourceBlock(`${name}_texture`);
      source.source.connectTo(block.source);
      outputs.textureOut = source.source;
      blocks.push(source);
    }
    return { blocks, inputs, outputs };
  };
}

ADAPTERS["texture.sample"] = textureSampleAdapter(false);
ADAPTERS["texture.sampleLod"] = textureSampleAdapter(true);

/** World-space geometry comes from the compiler's transform chain. */
ADAPTERS["input.worldPosition"] = ({ name, plumbing }) => {
  if (!plumbing.worldPosition) {
    const block = attributeVector(name, "position", 3);
    return single(block, {}, { position: block.output });
  }
  // The plumbed world position is a Vector4; the graph pin is a Vector3.
  const split = new VectorSplitterBlock(`${name}_xyz`);
  plumbing.worldPosition.connectTo(split.xyzw);
  if (plumbing.worldOrigin) {
    const absolute = new AddBlock(`${name}_absolute`);
    split.xyzOut.connectTo(absolute.left);
    plumbing.worldOrigin.connectTo(absolute.right);
    return { blocks: [split, absolute], inputs: {}, outputs: { position: absolute.output } };
  }
  return { blocks: [split], inputs: {}, outputs: { position: split.xyzOut } };
};

ADAPTERS["input.vertexPosition"] = ({ name, plumbing }) => {
  if (plumbing.position) return { blocks: [], inputs: {}, outputs: { position: plumbing.position } };
  const block = attributeVector(name, "position", 3);
  return single(block, {}, { position: block.output });
};
ADAPTERS["input.vertexNormal"] = ({ name, plumbing }) => {
  if (plumbing.localNormal) return { blocks: [], inputs: {}, outputs: { normal: plumbing.localNormal } };
  const block = attributeVector(name, "normal", 3);
  return single(block, {}, { normal: block.output });
};

/** The surface's world normal at unit length, whatever the mesh's scale and wherever it is read. */
ADAPTERS["input.worldNormal"] = ({ name, plumbing }) => {
  const unit = new NormalizeBlock(name);
  if (plumbing.worldNormal) {
    plumbing.worldNormal.connectTo(unit.input);
    return single(unit, {}, { normal: unit.output });
  }
  const block = attributeVector(`${name}_attribute`, "normal", 3);
  block.output.connectTo(unit.input);
  return { blocks: [block, unit], inputs: {}, outputs: { normal: unit.output } };
};

/** The mesh's own origin in the scene: the world matrix applied to the local origin, the same for every pixel. */
ADAPTERS["input.objectPosition"] = ({ name, plumbing }) => {
  if (!plumbing.world) throw new Error("Object Position is only available in a Surface material");
  const origin = createConstantBlock(`${name}_origin`, "vec3", [0, 0, 0]);
  const world = new TransformBlock(name);
  origin.output.connectTo(world.vector);
  plumbing.world.connectTo(world.transform);
  if (!plumbing.worldOrigin) return { blocks: [origin, world], inputs: {}, outputs: { position: world.xyz } };
  const absolute = new AddBlock(`${name}_absolute`);
  world.xyz.connectTo(absolute.left);
  plumbing.worldOrigin.connectTo(absolute.right);
  return { blocks: [origin, world, absolute], inputs: {}, outputs: { position: absolute.output } };
};

ADAPTERS["landscape.uv"] = (context) => {
  const position = ADAPTERS["input.worldPosition"]!(context);
  const split = new VectorSplitterBlock(`${context.name}_split`);
  position.outputs.position!.connectTo(split.xyzIn);
  const merge = new VectorMergerBlock(`${context.name}_xz`);
  split.x.connectTo(merge.x); split.z.connectTo(merge.y);
  const scale = new ScaleBlock(context.name);
  merge.xyOut.connectTo(scale.input);
  return { blocks: [...position.blocks, split, merge, scale], inputs: { scale: scale.factor }, outputs: { uv: scale.output } };
};
ADAPTERS["landscape.height"] = (context) => {
  const position = ADAPTERS["input.worldPosition"]!(context);
  const split = new VectorSplitterBlock(context.name);
  position.outputs.position!.connectTo(split.xyzIn);
  return { blocks: [...position.blocks, split], inputs: {}, outputs: { height: split.y } };
};
ADAPTERS["landscape.slope"] = (context) => {
  const normal = ADAPTERS["input.worldNormal"]!({ ...context, name: `${context.name}_unit` });
  const split = new VectorSplitterBlock(`${context.name}_split`);
  normal.outputs.normal!.connectTo(split.xyzIn);
  const abs = new TrigonometryBlock(`${context.name}_abs`);
  abs.operation = TrigonometryBlockOperations.Abs;
  split.y.connectTo(abs.input);
  const one = new InputBlock(`${context.name}_one`); one.value = 1;
  const slope = new SubtractBlock(context.name);
  one.output.connectTo(slope.left); abs.output.connectTo(slope.right);
  return { blocks: [...normal.blocks, split, abs, one, slope], inputs: {}, outputs: { slope: slope.output } };
};
ADAPTERS["landscape.layers"] = ({ name }) => {
  const color = new InputBlock(`${name}_weights`, undefined, NodeMaterialBlockConnectionPointTypes.Color4);
  color.setAsAttribute("color");
  const split = new VectorSplitterBlock(name); color.output.connectTo(split.xyzw);
  return { blocks: [color, split], inputs: {}, outputs: { layer1: split.x, layer2: split.y, layer3: split.z, layer4: split.w } };
};

ADAPTERS["input.worldTangent"] = ({ name, plumbing }) => {
  if (plumbing.worldTangent) return { blocks: [], inputs: {}, outputs: { tangent: plumbing.worldTangent } };
  const blocks: NodeMaterialBlock[] = [];
  let tangent = plumbing.localTangent;
  if (!tangent) {
    const attribute = attributeVector(name, "tangent", 4);
    blocks.push(attribute);
    tangent = attribute.output;
  }
  const split = new VectorSplitterBlock(`${name}_xyz`);
  const direction = new VectorMergerBlock(`${name}_direction`);
  const world = new TransformBlock(`${name}_world`);
  const normal = new NormalizeBlock(`${name}_unit`);
  tangent.connectTo(split.xyzw);
  split.xyzOut.connectTo(direction.xyzIn);
  direction.xyzw.connectTo(world.vector);
  plumbing.world?.connectTo(world.transform);
  world.xyz.connectTo(normal.input);
  blocks.push(split, direction, world, normal);
  return { blocks, inputs: {}, outputs: { tangent: normal.output } };
};

ADAPTERS["input.viewDirection"] = ({ plumbing }) => {
  if (!plumbing.viewDirection) {
    throw new Error("View Direction requires surface plumbing");
  }
  return {
    blocks: [],
    inputs: {},
    outputs: { direction: plumbing.viewDirection },
  };
};

ADAPTERS["input.sceneDepth"] = ({ name, plumbing }) => {
  if (plumbing.logicalSceneBuffers) {
    const block = new LogicalSceneTextureBlock(name, "sceneDepth");
    return single(block, { uv: block.uv }, { depth: block.r });
  }
  const block = new SceneDepthBlock(name);
  block.useNonLinearDepth = false;
  block.storeCameraSpaceZ = false;
  return single(block, { uv: block.uv }, { depth: block.depth });
};

ADAPTERS["input.sceneNormal"] = ({ name, plumbing }) => {
  if (plumbing.logicalSceneBuffers) {
    const block = new LogicalSceneTextureBlock(name, "sceneNormal");
    return single(block, { uv: block.uv }, { normal: block.rgb });
  }
  const prepass = new PrePassTextureBlock(name);
  const sample = new TextureBlock(`${name}_sample`, true);
  prepass.worldNormal.connectTo(sample.source);
  return {
    blocks: [prepass, sample],
    inputs: { uv: sample.uv },
    outputs: { normal: sample.rgb },
  };
};

ADAPTERS["custom.glsl"] = ({ name, operation }) => {
  const pins = customGlslInterface(operation.properties);
  const primary = pins.outputs[0]!;
  const additional = pins.outputs.slice(1);
  const functionName = customGlslFunctionName(operation.id);
  const helper = `${functionName}_body`;
  const block = new CustomBlock(name);
  const blockType = { float: "Float", vec2: "Vector2", vec3: "Vector3", vec4: "Vector4", texture: "sampler2D" };
  const glslType = (type: MaterialValueType) => type === "texture" ? "sampler2D" : type;
  const parameters = [...pins.inputs.map((pin) => `${glslType(pin.type)} ${pin.name}`), ...additional.map((pin) => `out ${pin.type} ${pin.name}`)];
  const wrapperParameters = [...pins.inputs.map((pin, i) => `${glslType(pin.type)} input${i}`), ...pins.outputs.map((pin, i) => `out ${pin.type} output${i}`)];
  block.options = {
    name,
    target: "Neutral",
    functionName,
    inParameters: pins.inputs.map((pin, i) => ({ name: `input${i}`, type: blockType[pin.type] })),
    outParameters: pins.outputs.map((pin, i) => ({ name: `output${i}`, type: blockType[pin.type] })),
    code: [
      `${primary.type} ${helper}(${parameters.join(", ")}) {`,
      ...additional.map((pin) => `${pin.name} = ${pin.type}(0.0);`),
      `// CUSTOM_BODY_${functionName}`,
      String(operation.properties.body ?? ""),
      `}`,
      `void ${functionName}(${wrapperParameters.join(", ")}) {`,
      `output0 = ${helper}(${[...pins.inputs.map((_, i) => `input${i}`), ...additional.map((_, i) => `output${i + 1}`)].join(", ")});`,
      `}`,
    ],
  };
  return {
    blocks: [block],
    inputs: Object.fromEntries(pins.inputs.map((pin, i) => [pin.id, block.inputs[i]!])),
    outputs: Object.fromEntries(pins.outputs.map((pin, i) => [pin.id, block.outputs[i]!])),
  };
};

export function blockAdapterFor(nodeType: string): BlockAdapter | undefined {
  return ADAPTERS[nodeType];
}
