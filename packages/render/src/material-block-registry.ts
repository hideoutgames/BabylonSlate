import {
  AddBlock,
  ArcTan2Block,
  ClampBlock,
  Color3,
  Color4,
  ConditionalBlock,
  ConditionalBlockConditions,
  CrossBlock,
  CurrentScreenBlock,
  DerivativeBlock,
  DesaturateBlock,
  DistanceBlock,
  DivideBlock,
  DotBlock,
  FresnelBlock,
  GradientBlock,
  InputBlock,
  LengthBlock,
  LerpBlock,
  MaxBlock,
  MinBlock,
  ModBlock,
  MultiplyBlock,
  NegateBlock,
  NodeMaterialBlockConnectionPointTypes,
  NodeMaterialSystemValues,
  NormalizeBlock,
  PerturbNormalBlock,
  PowBlock,
  ReciprocalBlock,
  ReflectBlock,
  RefractBlock,
  RemapBlock,
  ScaleBlock,
  ScreenSizeBlock,
  SmoothStepBlock,
  StepBlock,
  SubtractBlock,
  TextureBlock,
  TrigonometryBlock,
  TrigonometryBlockOperations,
  Vector2,
  Vector3,
  Vector4,
  VectorMergerBlock,
  VectorSplitterBlock,
  type NodeMaterialBlock,
  type NodeMaterialConnectionPoint,
} from "@babylonjs/core";
import { CustomBlock } from "@babylonjs/core/Materials/Node/Blocks/customBlock";
import { SceneDepthBlock } from "@babylonjs/core/Materials/Node/Blocks/Dual/sceneDepthBlock";
import { PrePassTextureBlock } from "@babylonjs/core/Materials/Node/Blocks/Input/prePassTextureBlock";
import { ParticleTextureBlock } from "@babylonjs/core/Materials/Node/Blocks/Particle/particleTextureBlock";
import type {
  MaterialOperation,
  MaterialValueType,
} from "@babylonslate/shader-graph";

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
  outputs: Record<string, NodeMaterialConnectionPoint>;
}

/**
 * Connection points the compiler owns rather than the graph: world-space
 * geometry for surface materials and the screen UV of the fullscreen pass for
 * post-process materials.
 */
export interface MaterialPlumbing {
  worldPosition?: NodeMaterialConnectionPoint;
  view?: NodeMaterialConnectionPoint;
  /** Vector 3 for graph pins. */
  worldNormal?: NodeMaterialConnectionPoint;
  /** Vector 4 for Babylon blocks that register a Vector 4 normal. */
  worldNormal4?: NodeMaterialConnectionPoint;
  worldTangent?: NodeMaterialConnectionPoint;
  cameraPosition?: NodeMaterialConnectionPoint;
  viewDirection?: NodeMaterialConnectionPoint;
  uv?: NodeMaterialConnectionPoint;
  screenUv?: NodeMaterialConnectionPoint;
  /** Clip-space transform vector input; connected after World Position Offset. */
  clipPosition?: NodeMaterialConnectionPoint;
}

export interface BlockAdapterContext {
  operation: MaterialOperation;
  /** Unique, stable block name prefix derived from the operation id. */
  name: string;
  /** Texture asset guid to a live Babylon texture, or null when unavailable. */
  resolveTexture?: (guid: string) => unknown | null;
  plumbing: MaterialPlumbing;
}

export type BlockAdapter = (context: BlockAdapterContext) => BlockRealization;

export function babylonTypeFor(
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
export function babylonValueFor(
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

function constantInput(
  name: string,
  type: MaterialValueType,
  components: readonly number[],
  asColor = false,
): InputBlock {
  // Colors go through Color3/Color4 so the merged Babylon type matches the
  // pins that PBR and fragment output expect.
  const babylonType = asColor
    ? type === "vec3"
      ? NodeMaterialBlockConnectionPointTypes.Color3
      : NodeMaterialBlockConnectionPointTypes.Color4
    : babylonTypeFor(type);
  const block = new InputBlock(name, undefined, babylonType);
  block.value = babylonValueFor(type, components, asColor);
  return block;
}

export function createConstantBlock(
  name: string,
  type: MaterialValueType,
  components: readonly number[],
  asColor = false,
): InputBlock {
  return constantInput(name, type, components, asColor);
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

function conditional(condition: ConditionalBlockConditions): BlockAdapter {
  return ({ name }) => {
    const block = new ConditionalBlock(name);
    block.condition = condition;
    const trueValue = constantInput(`${name}_true`, "float", [1]);
    const falseValue = constantInput(`${name}_false`, "float", [0]);
    trueValue.output.connectTo(block.true);
    falseValue.output.connectTo(block.false);
    return {
      blocks: [block, trueValue, falseValue],
      inputs: { a: block.a, b: block.b },
      outputs: { out: block.output },
    };
  };
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
  const factor = constantInput(`${name}_factor`, "float", [Math.LOG2E]);
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

/** Clamp exposes min/max as block properties, not pins. */
const clampAdapter: BlockAdapter = ({ name, operation }) => {
  const clamp = new ClampBlock(name);
  const min = operation.inputs.min;
  const max = operation.inputs.max;
  clamp.minimum =
    min?.kind === "constant" ? (min.value[0] ?? 0) : 0;
  clamp.maximum =
    max?.kind === "constant" ? (max.value[0] ?? 1) : 1;
  return single(clamp, { value: clamp.value }, { out: clamp.output });
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
  "math.add": binary(AddBlock),
  "math.subtract": binary(SubtractBlock),
  "math.multiply": binary(MultiplyBlock),
  "math.divide": binary(DivideBlock),
  "math.min": binary(MinBlock),
  "math.max": binary(MaxBlock),
  "math.mod": binary(ModBlock),
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
  "math.atan2": ({ name }) => {
    const block = new ArcTan2Block(name);
    return single(block, { y: block.y, x: block.x }, { out: block.output });
  },
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
  "math.step": ({ name }) => {
    const block = new StepBlock(name);
    return single(
      block,
      { edge: block.edge, value: block.value },
      { out: block.output },
    );
  },
  "math.smoothstep": ({ name }) => {
    const block = new SmoothStepBlock(name);
    return single(
      block,
      { edgeA: block.edge0, edgeB: block.edge1, value: block.value },
      { out: block.output },
    );
  },
  "math.remap": ({ name }) => {
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
  },
  "vector.dot": binary(DotBlock),
  "vector.cross": binary(CrossBlock),
  "vector.distance": binary(DistanceBlock),
  "vector.length": ({ name }) => {
    const block = new LengthBlock(name);
    return single(block, { value: block.value }, { out: block.output });
  },
  "vector.normalize": ({ name }) => {
    const block = new NormalizeBlock(name);
    return single(block, { value: block.input }, { out: block.output });
  },
  "vector.reflect": ({ name }) => {
    const block = new ReflectBlock(name);
    return single(
      block,
      { incident: block.incident, normal: block.normal },
      { out: block.output },
    );
  },
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
  "vector.split": ({ name, operation }) => {
    const block = new VectorSplitterBlock(name);
    // VectorSplitter exposes one input per width; pick the one that matches
    // so a Vector 2 is not offered to a Vector 4 connector.
    const value =
      operation.resolvedType === "vec2"
        ? block.xyIn
        : operation.resolvedType === "vec3"
          ? block.xyzIn
          : block.xyzw;
    return {
      blocks: [block],
      inputs: { value },
      outputs: { x: block.x, y: block.y, z: block.z, w: block.w },
    };
  },
  "logic.equal": conditional(ConditionalBlockConditions.Equal),
  "logic.notEqual": conditional(ConditionalBlockConditions.NotEqual),
  "logic.lessThan": conditional(ConditionalBlockConditions.LessThan),
  "logic.greaterThan": conditional(ConditionalBlockConditions.GreaterThan),
  "logic.select": ({ name }) => {
    const block = new ConditionalBlock(name);
    block.condition = ConditionalBlockConditions.GreaterThan;
    const threshold = constantInput(`${name}_threshold`, "float", [0.5]);
    threshold.output.connectTo(block.b);
    return {
      blocks: [block, threshold],
      inputs: {
        condition: block.a,
        whenTrue: block.true,
        whenFalse: block.false,
      },
      outputs: { out: block.output },
    };
  },
  "derivative.ddx": ({ name }) => {
    const block = new DerivativeBlock(name);
    return single(block, { value: block.input }, { out: block.dx });
  },
  "derivative.ddy": ({ name }) => {
    const block = new DerivativeBlock(name);
    return single(block, { value: block.input }, { out: block.dy });
  },
  "derivative.fwidth": fwidthAdapter,
  "input.uv": ({ name, plumbing }) => {
    if (plumbing.uv) {
      return { blocks: [], inputs: {}, outputs: { uv: plumbing.uv } };
    }
    const block = new InputBlock(
      name,
      undefined,
      NodeMaterialBlockConnectionPointTypes.Vector2,
    );
    block.setAsAttribute("uv");
    return single(block, {}, { uv: block.output });
  },
  "input.vertexColor": attributeInput(
    "color",
    NodeMaterialBlockConnectionPointTypes.Color4,
    "color",
  ),
  "input.particleColor": attributeInput(
    "particle_color",
    NodeMaterialBlockConnectionPointTypes.Color4,
    "color",
  ),
  "input.particleTexture": ({ name }) => {
    const block = new ParticleTextureBlock(name);
    return {
      blocks: [block],
      inputs: { uv: block.uv },
      outputs: { rgba: block.rgba, rgb: block.rgb, a: block.a },
    };
  },
  "input.time": ({ name }) => {
    const block = new InputBlock(
      name,
      undefined,
      NodeMaterialBlockConnectionPointTypes.Float,
    );
    // Babylon advances this uniform per frame, matching the runtime clock.
    block.animationType = 1;
    return single(block, {}, { time: block.output });
  },
  "input.cameraPosition": ({ name, plumbing }) => {
    if (plumbing.cameraPosition) {
      return { blocks: [], inputs: {}, outputs: { position: plumbing.cameraPosition } };
    }
    return systemInput(
      NodeMaterialSystemValues.CameraPosition,
      NodeMaterialBlockConnectionPointTypes.Vector3,
      "position",
    )({ name, plumbing, operation: undefined as never });
  },
  "input.screenSize": ({ name }) => {
    const block = new ScreenSizeBlock(name);
    return single(block, {}, { size: block.xy });
  },
  "input.screenUv": ({ plumbing }) => {
    // The compiler derives this from the fullscreen pass position.
    if (!plumbing.screenUv) {
      throw new Error("Screen UV is only available in a post-process material");
    }
    return { blocks: [], inputs: {}, outputs: { uv: plumbing.screenUv } };
  },
  "input.sceneColor": ({ name }) => {
    const block = new CurrentScreenBlock(name);
    return single(block, { uv: block.uv }, { color: block.rgba });
  },
  "texture.transformUv": ({ name }) => {
    const scale = new MultiplyBlock(name);
    const offset = new AddBlock(`${name}_offset`);
    scale.output.connectTo(offset.left);
    return {
      blocks: [scale, offset],
      inputs: {
        uv: scale.left,
        tiling: scale.right,
        offset: offset.right,
      },
      outputs: { out: offset.output },
    };
  },
  "color.desaturate": ({ name }) => {
    const block = new DesaturateBlock(name);
    return single(
      block,
      { color: block.color, level: block.level },
      { out: block.output },
    );
  },
  "color.gradient": ({ name }) => {
    const block = new GradientBlock(name);
    return single(block, { value: block.gradient }, { out: block.output });
  },
  "shading.fresnel": ({ name, plumbing }) => {
    const block = new FresnelBlock(name);
    plumbing.worldNormal4?.connectTo(block.worldNormal);
    plumbing.viewDirection?.connectTo(block.viewDirection);
    return single(
      block,
      { bias: block.bias, power: block.power },
      { out: block.fresnel },
    );
  },
  "shading.normalMap": ({ name, plumbing }) => {
    const block = new PerturbNormalBlock(name);
    plumbing.worldPosition?.connectTo(block.worldPosition);
    plumbing.worldNormal4?.connectTo(block.worldNormal);
    plumbing.uv?.connectTo(block.uv);
    // Babylon emits a Vector 4 normal; the graph pin is a Vector 3.
    const split = new VectorSplitterBlock(`${name}_xyz`);
    block.output.connectTo(split.xyzw);
    return {
      blocks: [block, split],
      inputs: { packed: block.normalMapColor },
      outputs: { normal: split.xyzOut },
    };
  },
};

/**
 * Texture nodes need the resolved asset, so they are built outside the plain
 * adapter table.
 */
function textureSampleAdapter(lod: boolean): BlockAdapter {
  return ({ name }) => {
    const block = new TextureBlock(name, true);
    const inputs: Record<string, NodeMaterialConnectionPoint> = {
      uv: block.uv,
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
    return { blocks: [block], inputs, outputs };
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
  // The plumbed world position is a Vector 4; the graph pin is a Vector 3.
  const split = new VectorSplitterBlock(`${name}_xyz`);
  plumbing.worldPosition.connectTo(split.xyzw);
  return { blocks: [split], inputs: {}, outputs: { position: split.xyzOut } };
};

ADAPTERS["input.worldNormal"] = ({ name, plumbing }) => {
  if (plumbing.worldNormal) {
    return { blocks: [], inputs: {}, outputs: { normal: plumbing.worldNormal } };
  }
  const block = attributeVector(name, "normal", 3);
  return single(block, {}, { normal: block.output });
};

ADAPTERS["input.worldTangent"] = ({ name, plumbing }) => {
  if (plumbing.worldTangent) {
    return { blocks: [], inputs: {}, outputs: { tangent: plumbing.worldTangent } };
  }
  const block = attributeVector(name, "tangent", 3);
  return single(block, {}, { tangent: block.output });
};

ADAPTERS["input.viewDirection"] = ({ name, plumbing }) => {
  if (plumbing.viewDirection) {
    return {
      blocks: [],
      inputs: {},
      outputs: { direction: plumbing.viewDirection },
    };
  }
  const block = new InputBlock(
    name,
    undefined,
    NodeMaterialBlockConnectionPointTypes.Vector3,
  );
  block.setAsSystemValue(NodeMaterialSystemValues.CameraPosition);
  return single(block, {}, { direction: block.output });
};

ADAPTERS["input.sceneDepth"] = ({ name }) => {
  const block = new SceneDepthBlock(name);
  block.useNonLinearDepth = false;
  block.storeCameraSpaceZ = false;
  return single(block, { uv: block.uv }, { depth: block.depth });
};

ADAPTERS["input.sceneNormal"] = ({ name }) => {
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
  const raw =
    typeof operation.properties.body === "string"
      ? operation.properties.body.trim()
      : "";
  const expression = raw === "" ? "a" : raw;
  const functionName = `custom_glsl_${name}`.replace(/[^A-Za-z0-9_]/g, "_");
  const block = new CustomBlock(name);
  block.options = {
    name,
    target: "Neutral",
    functionName,
    inParameters: [
      { name: "a", type: "AutoDetect" },
      { name: "b", type: "AutoDetect" },
    ],
    outParameters: [
      { name: "result", type: "BasedOnInput", typeFromInput: "a" },
    ],
    inLinkedConnectionTypes: [{ input1: "a", input2: "b" }],
    code: [
      `void ${functionName}({TYPE_a} a, {TYPE_b} b, out {TYPE_result} result) {`,
      `result = ${expression};`,
      `}`,
    ],
  };
  return {
    blocks: [block],
    inputs: { a: block.inputs[0]!, b: block.inputs[1]! },
    outputs: { out: block.outputs[0]! },
  };
};

export function blockAdapterFor(nodeType: string): BlockAdapter | undefined {
  return ADAPTERS[nodeType];
}

export function hasBlockAdapter(nodeType: string): boolean {
  return nodeType in ADAPTERS || nodeType.startsWith("const.") ||
    nodeType.startsWith("param.");
}
