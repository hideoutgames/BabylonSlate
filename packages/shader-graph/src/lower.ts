import { fnv1a } from "@haptic/core";
import {
  isNamedRerouteDeclarationType,
  isNamedRerouteUsageType,
  materialNodeDefinition,
  namedRerouteDeclarationId,
  terminalNodeTypeFor,
  type MaterialDomain,
  type MaterialNodeDefinition,
  type MaterialPinDefinition,
} from "./catalog";
import type {
  MaterialDocument,
  MaterialFunctionDocument,
  MaterialGraphEdge,
  MaterialGraphNode,
} from "./document";
import { MATERIAL_GLOBAL_PARAMETER_NODE_TYPE } from "./global-parameter";
import { createTypeResolver, type TypeResolver } from "./resolve";
import { materialDefaultComponents, resolveMaterialPinDefault } from "./pin-defaults";
import { conversionFor, convertMaterialValue, type MaterialConversion, type MaterialValueType } from "./types";
import {
  checkMaterialDocument,
  type MaterialDiagnostic,
  type MaterialValidationContext,
} from "./validate";

/** Where a lowered operation came from, for diagnostics and graph focus. */
export interface MaterialOperationSource {
  /** Node id inside its own graph. */
  nodeId: string;
  /** Chain of `function.call` node ids that inlined it, outermost first. */
  callPath: string[];
  /** Function asset the node lives in, when it is not the material itself. */
  functionGuid?: string;
}

export type MaterialOperand =
  | {
      kind: "operation";
      operationId: string;
      pinId: string;
      conversions?: MaterialConversion[];
    }
  | {
      kind: "constant";
      type: MaterialValueType;
      value: number[];
      /**
       * The literal is hoisted (`hoistMaterialLiterals`): the program reads it from the Material's record, so it is a
       * bound value (`valueHash`), not code.
       */
      hoisted?: true;
    };

export interface MaterialOperation {
  /** Namespaced id, unique across inlined function bodies. */
  id: string;
  nodeType: string;
  resolvedType: MaterialValueType;
  inputs: Record<string, MaterialOperand>;
  properties: Record<string, unknown>;
  source: MaterialOperationSource;
}

/** How a Texture Sample filters the texture picked on it: smooth by default, or each texel as a hard square. */
export type MaterialTextureFilter = "linear" | "nearest";

export interface MaterialTextureBinding {
  operationId: string;
  textureGuid: string;
  /** Set only when not linear. */
  filter?: "nearest";
}

export interface MaterialCostFeatures {
  operations: number;
  textureSamples: number;
  /** Sum of catalog cost weights. Relative ALU work, not milliseconds. */
  weight: number;
  usesSceneDepth: boolean;
  usesSceneNormal: boolean;
  customBlocks: number;
}

export interface MaterialBuildPlan {
  domain: MaterialDomain;
  shadingModel: MaterialDocument["shadingModel"];
  blendMode: MaterialDocument["blendMode"];
  twoSided: boolean;
  defaultNormals: MaterialDocument["defaultNormals"];
  alphaCutoff: number;
  boundsPadding?: number;
  /** Topologically ordered: every operand refers to an earlier operation. */
  operations: MaterialOperation[];
  /** Terminal channel operands, keyed by output pin id. */
  outputs: Record<string, MaterialOperand | null>;
  textures: MaterialTextureBinding[];
  cost: MaterialCostFeatures;
  dependencies: { textures: string[] };
  /**
   * `const.*` operations whose value is hoisted into the Material's record (`hoistMaterialLiterals`), in plan order;
   * their constant operands that are hoisted carry `hoisted`.
   */
  hoistedConstants: string[];
  /**
   * The compile-time choices the compiler makes from Material Output literals (`materialOutputFlags`), part of
   * `programHash`: the literals themselves are hoisted, so Materials whose flags agree share a program.
   */
  outputFlags: MaterialOutputFlags;
  /** Scene buffers a post-process plan samples. Surface plans are all false. */
  bufferRequirements: MaterialBufferRequirements;
  /** Stable content hash. Node positions and names are deliberately excluded. */
  hash: string;
  /**
   * The graph's shape: what decides its GPU program. Operations by plan position (never node id), their wiring and
   * conversions, the literals the shader holds, the properties that change code, which samples have a texture bound,
   * and the domain, shading, blend, two-sided, normals and alpha cutoff. Two plans with one `programHash` and one
   * `valueHash` compile byte-identical shader text whatever their Materials and node ids (`shareCompiledProgram`).
   */
  programHash: string;
  /**
   * What a plan binds rather than compiles: its parameters' names and default values, its texture guids and filters,
   * its Global Parameter selections and its bounds padding. Two plans that differ only here share one program.
   */
  valueHash: string;
}

/**
 * Every choice the compiler makes from a literal's value on the Material Output. Each is true exactly where the code
 * it compiles leaves something out (or, for `environmentInfluenceZero`, compiles the environment out), so a flag flips
 * the program exactly when the compiled code differs; the literal behind a false flag is hoisted and bound.
 */
export interface MaterialOutputFlags {
  /** Emissive is a literal of zeros: no emission is added (Surface, Landscape, Decal). */
  emissiveZero: boolean;
  /** Environment Influence is the literal 1: the light block reads no influence. */
  environmentInfluenceOne: boolean;
  /** Environment Influence is 0, as a literal or a Float Constant node: the light block compiles no environment light. */
  environmentInfluenceZero: boolean;
  /** Specular is the literal 0.5, the light block's own default: it reads no specular. */
  specularDefault: boolean;
  /** World Position Offset is absent or a literal of zeros: the stock vertex stage, no offset added. */
  identityWorldPositionOffset: boolean;
}

/** `MaterialOutputFlags` of a plan's terminal operands. */
function materialOutputFlags(
  outputs: Record<string, MaterialOperand | null>, operations: readonly MaterialOperation[],
): MaterialOutputFlags {
  const literal = (pin: string, test: (value: readonly number[]) => boolean) => {
    const operand = outputs[pin];
    return operand?.kind === "constant" && test(operand.value);
  };
  const environment = outputs.environmentInfluence;
  const floatConstant = environment?.kind === "operation" && !environment.conversions?.length
    ? operations.find((operation) => operation.id === environment.operationId && operation.nodeType === "const.float")
    : undefined;
  const constantValue = floatConstant?.properties.value;
  const environmentScalar = environment?.kind === "constant"
    ? (environment.value.length === 1 ? environment.value[0] : undefined)
    : Array.isArray(constantValue) && constantValue.length === 1 ? constantValue[0] : undefined;
  const offset = outputs.worldPositionOffset ?? null;
  return {
    emissiveZero: literal("emissive", (value) => value.every((component) => component === 0)),
    environmentInfluenceOne: literal("environmentInfluence", (value) => value[0] === 1),
    environmentInfluenceZero: environmentScalar === 0,
    specularDefault: literal("specular", (value) => value[0] === 0.5),
    identityWorldPositionOffset: !offset || (offset.kind === "constant" && offset.value.every((component) => component === 0)),
  };
}

/** The Material Output literals a true flag leaves out of the code: nothing reads them, so none is hoisted. */
function elidedByFlag(pin: string, flags: MaterialOutputFlags): boolean {
  return (pin === "emissive" && flags.emissiveZero) || (pin === "environmentInfluence" && flags.environmentInfluenceOne) ||
    (pin === "specular" && flags.specularDefault) || (pin === "worldPositionOffset" && flags.identityWorldPositionOffset);
}

export interface MaterialBufferRequirements {
  sceneColor: boolean;
  sceneDepth: boolean;
  sceneNormal: boolean;
}

export type MaterialLowerResult =
  | { ok: true; plan: MaterialBuildPlan; diagnostics: MaterialDiagnostic[] }
  | { ok: false; diagnostics: MaterialDiagnostic[] };

interface Frame {
  graph: { nodes: MaterialGraphNode[]; edges: MaterialGraphEdge[] };
  resolver: TypeResolver;
  prefix: string;
  callPath: string[];
  functionGuid?: string;
  functionInterface?: MaterialFunctionDocument;
  /**
   * The caller's operand for one declared input, resolved on first read so an
   * input the body never reads emits nothing (and requires no scene buffer).
   */
  bindInput?: (pinId: string) => MaterialOperand;
}

/** Node and input-wire lookups for one graph; the first of duplicates wins, as `find` did. */
interface GraphLookup {
  node(nodeId: string): MaterialGraphNode | undefined;
  incoming(nodeId: string, pinId: string): MaterialGraphEdge | undefined;
}

function lookupGraph(graph: Frame["graph"]): GraphLookup {
  const nodes = new Map<string, MaterialGraphNode>();
  for (const node of graph.nodes) {
    if (!nodes.has(node.id)) nodes.set(node.id, node);
  }
  const incoming = new Map<string, Map<string, MaterialGraphEdge>>();
  for (const edge of graph.edges) {
    let pins = incoming.get(edge.targetNodeId);
    if (!pins) incoming.set(edge.targetNodeId, (pins = new Map()));
    if (!pins.has(edge.targetPinId)) pins.set(edge.targetPinId, edge);
  }
  return {
    node: (nodeId) => nodes.get(nodeId),
    incoming: (nodeId, pinId) => incoming.get(nodeId)?.get(pinId),
  };
}

/** Widen a literal to the component count of `type`, splatting a scalar. */
function constantOperand(
  type: MaterialValueType,
  value: readonly number[] | undefined,
): MaterialOperand {
  return { kind: "constant", type, value: materialDefaultComponents(type, value) };
}

function pinDefault(
  node: MaterialGraphNode,
  pin: MaterialPinDefinition,
  type: MaterialValueType,
): MaterialOperand {
  return constantOperand(type, resolveMaterialPinDefault(node, pin));
}

function propertyVector(
  node: MaterialGraphNode,
  type: MaterialValueType,
): number[] | undefined {
  const value = node.properties.value;
  if (Array.isArray(value)) {
    return value.map((component) =>
      typeof component === "number" && Number.isFinite(component) ? component : 0,
    );
  }
  if (typeof value === "number" && Number.isFinite(value)) return [value];
  void type;
  return undefined;
}

/** Stable, order-independent hash of the lowered plan. */
function hashPlan(
  operations: readonly MaterialOperation[],
  outputs: Record<string, MaterialOperand | null>,
  header: string,
): string {
  const parts: string[] = [header];
  for (const operation of operations) {
    const inputs = Object.keys(operation.inputs)
      .sort()
      .map((pinId) => `${pinId}=${describeOperand(operation.inputs[pinId]!)}`)
      .join(",");
    const properties = Object.keys(operation.properties)
      .sort()
      .filter((key) => key !== "__pins")
      .map((key) => `${key}:${JSON.stringify(operation.properties[key])}`)
      .join(",");
    parts.push(
      `${operation.id}|${operation.nodeType}|${operation.resolvedType}|${inputs}|${properties}`,
    );
  }
  for (const key of Object.keys(outputs).sort()) {
    parts.push(`out:${key}=${describeOperand(outputs[key])}`);
  }
  return fnv1a(parts.join("\n"));
}

function describeOperand(operand: MaterialOperand | null | undefined): string {
  if (!operand) return "none";
  if (operand.kind === "constant") {
    return `c:${operand.type}:${operand.value.join("/")}`;
  }
  return `o:${operand.operationId}:${operand.pinId}${
    operand.conversions?.map(({ from, to }) => `:${from}>${to}`).join("") ?? ""
  }`;
}

/** Properties a parameter or a texture binding reads at bind time: values, never code. */
const BOUND_PROPERTIES: ReadonlySet<string> = new Set(["textureGuid", "filter"]);
const PARAMETER_PROPERTIES: ReadonlySet<string> = new Set(["name", "value"]);
const GLOBAL_PARAMETER_PROPERTIES: ReadonlySet<string> = new Set(["collectionGuid", "parameterId"]);

/** Whether `key` of `operation` is a bound value (`valueHash`) rather than part of its code (`programHash`). */
function isBoundProperty(operation: MaterialOperation, key: string, hoisted: ReadonlySet<string>): boolean {
  if (BOUND_PROPERTIES.has(key)) return true;
  if (hoisted.has(operation.id)) return key === "value";
  if (operation.nodeType.startsWith("param.")) return PARAMETER_PROPERTIES.has(key);
  return operation.nodeType === MATERIAL_GLOBAL_PARAMETER_NODE_TYPE && GLOBAL_PARAMETER_PROPERTIES.has(key);
}

/** `programHash` and `valueHash` of a lowered plan (see `MaterialBuildPlan`). */
function hashPlanParts(
  operations: readonly MaterialOperation[],
  outputs: Record<string, MaterialOperand | null>,
  textures: readonly MaterialTextureBinding[],
  hoistedConstants: readonly string[],
  programHeader: string,
  valueHeader: string,
): { programHash: string; valueHash: string } {
  const positions = new Map(operations.map((operation, index) => [operation.id, index]));
  const hoisted = new Set(hoistedConstants);
  const operand = (value: MaterialOperand | null | undefined): string => {
    if (!value) return "none";
    if (value.kind === "constant") return value.hoisted ? `h:${value.type}` : `c:${value.type}:${value.value.join("/")}`;
    return `o:${positions.get(value.operationId) ?? "?"}:${value.pinId}${
      value.conversions?.map(({ from, to }) => `:${from}>${to}`).join("") ?? ""
    }`;
  };
  const property = (operation: MaterialOperation, key: string) => `${key}:${JSON.stringify(operation.properties[key])}`;
  const bound = new Map(textures.map((binding) => [binding.operationId, binding]));
  const program: string[] = [programHeader];
  const values: string[] = [valueHeader];
  operations.forEach((operation, index) => {
    const inputs = Object.keys(operation.inputs).sort().map((pinId) => `${pinId}=${operand(operation.inputs[pinId])}`).join(",");
    // A pin default (`default:<pin>`) is the operand that carries it, described with the inputs.
    const keys = Object.keys(operation.properties).sort().filter((key) => key !== "__pins" && !key.startsWith("default:"));
    const code = keys.filter((key) => !isBoundProperty(operation, key, hoisted)).map((key) => property(operation, key)).join(",");
    program.push(`${operation.nodeType}|${operation.resolvedType}|${inputs}|${code}|${bound.has(operation.id) ? "texture" : ""}`);
    const value = keys.filter((key) => isBoundProperty(operation, key, hoisted)).map((key) => property(operation, key));
    for (const pinId of Object.keys(operation.inputs).sort()) {
      const input = operation.inputs[pinId]!;
      if (input.kind === "constant" && input.hoisted) value.push(`${pinId}=${input.value.join("/")}`);
    }
    const binding = bound.get(operation.id);
    if (binding) value.push(`binding:${binding.textureGuid}:${binding.filter ?? "linear"}`);
    if (value.length) values.push(`${index}|${value.join(",")}`);
  });
  for (const key of Object.keys(outputs).sort()) {
    program.push(`out:${key}=${operand(outputs[key])}`);
    const output = outputs[key];
    if (output?.kind === "constant" && output.hoisted) values.push(`out:${key}=${output.value.join("/")}`);
  }
  return { programHash: fnv1a(program.join("\n")), valueHash: fnv1a(values.join("\n")) };
}

function compileFingerprint(document: MaterialDocument): string {
  return JSON.stringify({
    domain: document.domain,
    shadingModel: document.shadingModel,
    blendMode: document.blendMode,
    twoSided: document.twoSided,
    defaultNormals: document.defaultNormals,
    alphaCutoff: document.alphaCutoff,
    boundsPadding: document.boundsPadding ?? 0,
    nodes: document.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      properties: node.properties,
    })),
    edges: document.edges,
  });
}

/**
 * Preview/compile cache key, from a lowering the caller already holds for the
 * same document and context, so an edit lowers the graph once. Node positions
 * are excluded so layout drags do not rebuild GPU materials. Invalid graphs
 * still get a stable key.
 */
export function materialCompileKeyFromLowering(
  document: MaterialDocument,
  lowered: MaterialLowerResult,
): string {
  if (lowered.ok) return lowered.plan.hash;
  return `invalid:${fnv1a(compileFingerprint(document))}`;
}

export interface MaterialLowerContext extends MaterialValidationContext {
  functions?: Record<string, MaterialFunctionDocument>;
}

/**
 * Lower a validated Material document into a deterministic build plan.
 *
 * Material Functions are inlined here: Babylon has no runtime function object,
 * so the callee's operations join the caller's plan under a namespaced id that
 * still maps back to the call node for diagnostics.
 */
export function lowerMaterialDocument(
  doc: MaterialDocument,
  context: MaterialLowerContext = {},
): MaterialLowerResult {
  try {
    return lowerWithinBudget(doc, context);
  } catch (error) {
    if (!(error instanceof PlanTooLarge)) throw error;
    return {
      ok: false,
      diagnostics: [{
        code: "material.tooLarge",
        message: `The Material expands to more than ${MATERIAL_MAX_OPERATIONS} operations once its Material Functions are inlined; nested functions that each call another several times multiply quickly`,
        severity: "error",
      }],
    };
  }
}

/**
 * The most operations a plan may hold. Every call of a Material Function is inlined, so functions nested N deep
 * that each call the next twice expand to 2^N copies: the bound stops that before it exhausts memory, far above
 * any Material a shader could run.
 */
export const MATERIAL_MAX_OPERATIONS = 4096;

class PlanTooLarge extends Error {}

function lowerWithinBudget(
  doc: MaterialDocument,
  context: MaterialLowerContext,
): MaterialLowerResult {
  const { diagnostics, resolver, functionResolvers } = checkMaterialDocument(doc, context);
  if (diagnostics.some((row) => row.severity === "error")) {
    return { ok: false, diagnostics };
  }

  const functions = context.functions ?? {};
  const operations: MaterialOperation[] = [];
  const emitted = new Map<string, MaterialOperation>();
  const emitting = new Set<string>();
  /** Named Reroute usages being followed to their source, by frame prefix and node id. */
  const readingUsages = new Set<string>();
  const textures: MaterialTextureBinding[] = [];

  const rootFrame: Frame = {
    graph: doc,
    // Validation resolved this document's types against the same functions record; an error-free graph has no loop.
    resolver: resolver ?? createTypeResolver(doc, { functions }),
    prefix: "",
    callPath: [],
  };

  /** Frames for call nodes, memoized so one call inlines its body once. */
  const callFrames = new Map<string, Frame>();

  /** One lookup per graph document, shared by every frame that inlines it. */
  const lookups = new Map<Frame["graph"], GraphLookup>();
  function lookupOf(frame: Frame): GraphLookup {
    let lookup = lookups.get(frame.graph);
    if (!lookup) lookups.set(frame.graph, (lookup = lookupGraph(frame.graph)));
    return lookup;
  }

  function frameForCall(frame: Frame, callNode: MaterialGraphNode): Frame | null {
    const key = `${frame.prefix}${callNode.id}`;
    const cached = callFrames.get(key);
    if (cached) return cached;
    const guid = callNode.properties.functionGuid;
    const fn = typeof guid === "string" ? functions[guid] : undefined;
    if (!fn) return null;
    const bound = new Map<string, MaterialOperand>();
    // A body's types follow its declared interface, not the call site, so every call of one function shares a resolver.
    let bodyResolver = functionResolvers.get(guid as string);
    if (!bodyResolver) functionResolvers.set(guid as string, (bodyResolver = createTypeResolver(fn, { functions, functionInterface: fn })));
    const child: Frame = {
      graph: fn,
      resolver: bodyResolver,
      prefix: `${key}/`,
      callPath: [...frame.callPath, callNode.id],
      functionGuid: guid as string,
      functionInterface: fn,
      bindInput: (pinId) => {
        let operand = bound.get(pinId);
        if (!operand) {
          operand = operandForInput(frame, callNode, pinId);
          bound.set(pinId, operand);
        }
        return operand;
      },
    };
    callFrames.set(key, child);
    return child;
  }

  /** Resolve what feeds one input pin, following function boundaries. */
  function operandForInput(
    frame: Frame,
    node: MaterialGraphNode,
    pinId: string,
  ): MaterialOperand {
    const definition = frame.resolver.definitionOf(node.id);
    const pin = definition?.inputs.find((entry) => entry.id === pinId);
    const targetType = frame.resolver.inputType(node.id, pinId) ?? "float";
    const edge = lookupOf(frame).incoming(node.id, pinId);
    if (!edge) {
      return pin
        ? pinDefault(node, pin, targetType)
        : constantOperand(targetType, undefined);
    }
    const produced = operandForOutput(frame, edge.sourceNodeId, edge.sourcePinId);
    if (!produced) {
      return pin
        ? pinDefault(node, pin, targetType)
        : constantOperand(targetType, undefined);
    }
    return withConversion(frame, produced, edge, targetType);
  }

  function withConversion(
    frame: Frame,
    operand: MaterialOperand,
    edge: MaterialGraphEdge,
    targetType: MaterialValueType,
  ): MaterialOperand {
    const sourceType =
      frame.resolver.outputType(edge.sourceNodeId, edge.sourcePinId) ??
      (operand.kind === "constant" ? operand.type : targetType);
    const conversion = conversionFor(sourceType, targetType);
    if (!conversion) return operand;
    if (operand.kind === "constant") {
      return { kind: "constant", type: targetType, value: convertMaterialValue(operand.value, conversion) };
    }
    return { ...operand, conversions: [...(operand.conversions ?? []), conversion] };
  }

  /** Resolve a producing pin into an operand, inlining calls and plumbing. */
  function operandForOutput(
    frame: Frame,
    nodeId: string,
    pinId: string,
  ): MaterialOperand | null {
    const node = lookupOf(frame).node(nodeId);
    if (!node) return null;

    if (node.type === "function.input") {
      const declared = frame.functionInterface?.inputs.find(
        (entry) => entry.id === pinId,
      );
      if (declared && frame.bindInput) return frame.bindInput(pinId);
      return constantOperand(declared?.type ?? "float", declared?.defaultValue);
    }

    if (isNamedRerouteUsageType(node.type)) {
      // The reroute collapses: the usage is its declaration's source, unconverted, so the consumer's
      // wire converts from the real source type exactly as a direct wire would.
      const declaration = lookupOf(frame).node(namedRerouteDeclarationId(node));
      const edge = declaration && isNamedRerouteDeclarationType(declaration.type)
        ? lookupOf(frame).incoming(declaration.id, "in")
        : undefined;
      // Validation rejects a usage that reads itself, in the Material and in every called function;
      // this guard keeps lowering finite should one ever get past it.
      const key = `${frame.prefix}${node.id}`;
      if (!edge || readingUsages.has(key)) return constantOperand("float", undefined);
      readingUsages.add(key);
      try {
        return operandForOutput(frame, edge.sourceNodeId, edge.sourcePinId);
      } finally {
        readingUsages.delete(key);
      }
    }

    // A declaration has no output to read; nothing else reaches here for it.
    if (isNamedRerouteDeclarationType(node.type)) return null;

    if (node.type === "function.call") {
      const child = frameForCall(frame, node);
      if (!child) return null;
      const outputNode = child.graph.nodes.find(
        (entry) => entry.type === "function.output",
      );
      if (!outputNode) return null;
      return operandForInput(child, outputNode, pinId);
    }

    const operation = emitOperation(frame, node);
    if (!operation) return null;
    return { kind: "operation", operationId: operation.id, pinId };
  }

  function emitOperation(
    frame: Frame,
    node: MaterialGraphNode,
  ): MaterialOperation | null {
    const id = `${frame.prefix}${node.id}`;
    const existing = emitted.get(id);
    if (existing) return existing;
    if (emitting.has(id)) return null;
    const definition: MaterialNodeDefinition | undefined =
      frame.resolver.definitionOf(node.id) ?? materialNodeDefinition(node.type);
    if (!definition) return null;

    emitting.add(id);
    const inputs: Record<string, MaterialOperand> = {};
    const lookup = lookupOf(frame);
    for (const pin of definition.inputs) {
      const wired = lookup.incoming(node.id, pin.id) !== undefined;
      if (!wired && resolveMaterialPinDefault(node, pin) === undefined) {
        continue;
      }
      inputs[pin.id] = operandForInput(frame, node, pin.id);
    }
    emitting.delete(id);

    const generic = frame.resolver.genericOf(node.id);
    const resolvedType: MaterialValueType =
      generic && generic !== "conflict"
        ? generic
        : (definition.outputs[0]?.type.kind === "generic"
            ? "float"
            : ((definition.outputs[0]?.type.kind ??
                "float") as MaterialValueType));

    const properties = { ...node.properties };
    if (definition.outputs[0] && node.type.startsWith("const.")) {
      const constantType = definition.outputs[0].type.kind as MaterialValueType;
      properties.value = materialDefaultComponents(
        constantType,
        propertyVector(node, constantType),
      );
    }

    const operation: MaterialOperation = {
      id,
      nodeType: node.type,
      resolvedType,
      inputs,
      properties,
      source: {
        nodeId: node.id,
        callPath: frame.callPath,
        ...(frame.functionGuid ? { functionGuid: frame.functionGuid } : {}),
      },
    };
    if (operations.length >= MATERIAL_MAX_OPERATIONS) throw new PlanTooLarge();
    emitted.set(id, operation);
    operations.push(operation);

    // A texture assigned on the node is what it samples only while nothing is wired into its Texture pin: a wire
    // wins, and a guid left on the node from before must not load a texture nothing draws.
    const textureGuid = node.properties.textureGuid;
    if (typeof textureGuid === "string" && textureGuid !== "" && lookup.incoming(node.id, "texture") === undefined) {
      textures.push({ operationId: id, textureGuid, ...(node.properties.filter === "nearest" ? { filter: "nearest" as const } : {}) });
    }
    return operation;
  }

  const terminalType = terminalNodeTypeFor(doc.domain);
  const terminal = doc.nodes.find((node) => node.type === terminalType);
  const terminalDefinition = materialNodeDefinition(terminalType);
  const outputs: Record<string, MaterialOperand | null> = {};
  if (terminal && terminalDefinition) {
    const lookup = lookupOf(rootFrame);
    for (const pin of terminalDefinition.inputs) {
      const wired = lookup.incoming(terminal.id, pin.id) !== undefined;
      if (!wired && resolveMaterialPinDefault(terminal, pin) === undefined) {
        outputs[pin.id] = null;
        continue;
      }
      outputs[pin.id] = operandForInput(rootFrame, terminal, pin.id);
    }
  }

  const cost = costOf(operations);
  const outputFlags = materialOutputFlags(outputs, operations);
  const hoistedConstants = hoistMaterialLiterals(doc.domain, operations, outputs, cost.customBlocks, outputFlags);
  const header = [
    doc.domain,
    doc.shadingModel,
    doc.blendMode,
    doc.twoSided ? "two-sided" : "one-sided",
    doc.defaultNormals,
    String(doc.alphaCutoff),
    String(doc.boundsPadding ?? 0),
  ].join("|");

  return {
    ok: true,
    diagnostics,
    plan: {
      domain: doc.domain,
      shadingModel: doc.shadingModel,
      blendMode: doc.blendMode,
      twoSided: doc.twoSided,
      defaultNormals: doc.defaultNormals,
      alphaCutoff: doc.alphaCutoff,
      boundsPadding: doc.boundsPadding ?? 0,
      operations,
      outputs,
      textures,
      cost,
      dependencies: {
        textures: [...new Set(textures.map((entry) => entry.textureGuid))].sort(),
      },
      bufferRequirements: bufferRequirementsOf(operations),
      hash: hashPlan(operations, outputs, header),
      hoistedConstants,
      outputFlags,
      ...hashPlanParts(operations, outputs, textures, hoistedConstants, [
        doc.domain, doc.shadingModel, doc.blendMode, doc.twoSided ? "two-sided" : "one-sided", doc.defaultNormals, String(doc.alphaCutoff),
        JSON.stringify(outputFlags),
      ].join("|"), String(doc.boundsPadding ?? 0)),
    },
  };
}

/** Domains whose programs read a Material record (Material-mode programs): only they hoist literals. */
const RECORD_DOMAINS: ReadonlySet<MaterialDomain> = new Set(["surface", "landscape", "text", "decal", "ui"]);

/** Inputs whose constant value decides a program's structure (`material-block-registry.ts`), by node type. */
const STRUCTURAL_INPUTS: Readonly<Record<string, readonly string[]>> = { "logic.select": ["condition"] };

/**
 * Hoist the literals that meet a runtime value into the Material's record, so Materials that differ only in them share
 * one program; returns the hoisted `const.*` operations and marks hoisted constant operands. A literal is hoisted when
 * the operation it feeds also reads a value that is not a literal (an operation other than a `const.*` node), and every
 * literal on the Material Output is (the shading meets it with the lights, the fog and the mesh); the compile-time
 * choices the compiler made from those values are `MaterialOutputFlags`. It stays in the code when:
 * - every input of what it feeds is a literal (a constant-only subtree: the driver folds it, and folding need not agree
 *   with evaluating it at run time);
 * - it decides structure (`STRUCTURAL_INPUTS`: a Select's condition picks one conditional or one per component);
 * - a Material Output literal that a true `MaterialOutputFlags` flag leaves out of the code (an emissive of zeros, an
 *   Environment Influence of 1, the default Specular, a World Position Offset of zeros): nothing reads it;
 * - the plan is not a Material-mode program's (Particle, Post Process) or holds Custom GLSL, which never shares.
 */
function hoistMaterialLiterals(
  domain: MaterialDomain,
  operations: readonly MaterialOperation[],
  outputs: Record<string, MaterialOperand | null>,
  customBlocks: number,
  flags: MaterialOutputFlags,
): string[] {
  if (!RECORD_DOMAINS.has(domain) || customBlocks > 0) return [];
  const constants = new Map(operations.filter((operation) => operation.nodeType.startsWith("const.")).map((operation) => [operation.id, operation]));
  const literal = (operand: MaterialOperand) => operand.kind === "constant" || constants.has(operand.operationId);
  const kept = new Set<string>();
  const hoisted = new Set<string>();
  for (const [pin, operand] of Object.entries(outputs)) {
    if (!operand || elidedByFlag(pin, flags)) continue;
    if (operand.kind === "constant") operand.hoisted = true;
    else if (constants.has(operand.operationId)) hoisted.add(operand.operationId);
  }
  for (const operation of operations) {
    const structural = STRUCTURAL_INPUTS[operation.nodeType] ?? [];
    const inputs = Object.entries(operation.inputs);
    if (!inputs.some(([, operand]) => !literal(operand))) continue;
    for (const [pinId, operand] of inputs) {
      if (structural.includes(pinId)) {
        if (operand.kind === "operation") kept.add(operand.operationId);
        continue;
      }
      if (operand.kind === "constant") operand.hoisted = true;
      else if (constants.has(operand.operationId)) hoisted.add(operand.operationId);
    }
  }
  return operations.filter((operation) => hoisted.has(operation.id) && !kept.has(operation.id)).map((operation) => operation.id);
}

function costOf(operations: readonly MaterialOperation[]): MaterialCostFeatures {
  let weight = 0;
  let textureSamples = 0;
  let usesSceneDepth = false;
  let usesSceneNormal = false;
  let customBlocks = 0;
  for (const operation of operations) {
    const definition = materialNodeDefinition(operation.nodeType);
    weight += definition?.cost ?? 1;
    textureSamples += definition?.samples ?? 0;
    if (definition?.requires?.includes("sceneDepth")) usesSceneDepth = true;
    if (definition?.requires?.includes("sceneNormal")) usesSceneNormal = true;
    if (operation.nodeType === "custom.glsl") customBlocks += 1;
  }
  return {
    operations: operations.length,
    textureSamples,
    weight,
    usesSceneDepth,
    usesSceneNormal,
    customBlocks,
  };
}

function bufferRequirementsOf(
  operations: readonly MaterialOperation[],
): MaterialBufferRequirements {
  let sceneColor = false;
  let sceneDepth = false;
  let sceneNormal = false;
  for (const operation of operations) {
    if (operation.nodeType === "input.sceneColor") sceneColor = true;
    if (operation.nodeType === "input.sceneDepth") sceneDepth = true;
    if (operation.nodeType === "input.sceneNormal") sceneNormal = true;
  }
  return { sceneColor, sceneDepth, sceneNormal };
}
