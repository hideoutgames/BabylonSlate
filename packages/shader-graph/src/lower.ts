import {
  materialNodeDefinition,
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
import { createTypeResolver, type TypeResolver } from "./resolve";
import { componentCount, conversionFor, type MaterialConversion, type MaterialValueType } from "./types";
import {
  validateMaterialDocument,
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
      convert?: MaterialConversion;
    }
  | {
      kind: "constant";
      type: MaterialValueType;
      value: number[];
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

export interface MaterialTextureBinding {
  operationId: string;
  textureGuid: string;
}

export interface MaterialCostFeatures {
  operations: number;
  textureSamples: number;
  /** Sum of catalog cost weights. Relative ALU work, not milliseconds. */
  weight: number;
  usesDerivatives: boolean;
  usesSceneDepth: boolean;
  usesSceneNormal: boolean;
  customBlocks: number;
  inlinedFunctions: number;
}

export interface MaterialBuildPlan {
  domain: MaterialDomain;
  shadingModel: MaterialDocument["shadingModel"];
  blendMode: MaterialDocument["blendMode"];
  twoSided: boolean;
  alphaCutoff: number;
  /** Topologically ordered: every operand refers to an earlier operation. */
  operations: MaterialOperation[];
  /** Terminal channel operands, keyed by output pin id. */
  outputs: Record<string, MaterialOperand | null>;
  textures: MaterialTextureBinding[];
  cost: MaterialCostFeatures;
  dependencies: { textures: string[]; functions: string[] };
  /** Scene buffers a post-process plan samples. Surface plans are all false. */
  bufferRequirements: MaterialBufferRequirements;
  /** Stable content hash. Node positions and names are deliberately excluded. */
  hash: string;
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
  /** Operands supplied by the caller for this function's declared inputs. */
  inputBindings: Map<string, MaterialOperand>;
}

/** Widen a literal to the component count of `type`, splatting a scalar. */
function constantComponents(
  type: MaterialValueType,
  value: readonly number[] | undefined,
): number[] {
  const width = Math.max(1, componentCount(type));
  const source = value ?? [0];
  const components: number[] = [];
  for (let index = 0; index < width; index++) {
    components.push(source[index] ?? source[0] ?? 0);
  }
  return components;
}

function constantOperand(
  type: MaterialValueType,
  value: readonly number[] | undefined,
): MaterialOperand {
  return { kind: "constant", type, value: constantComponents(type, value) };
}

function pinDefault(
  pin: MaterialPinDefinition,
  type: MaterialValueType,
): MaterialOperand {
  return constantOperand(type, pin.defaultValue);
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
    operand.convert ? `:${operand.convert.kind}:${operand.convert.to}` : ""
  }`;
}

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function compileFingerprint(document: MaterialDocument): string {
  return JSON.stringify({
    domain: document.domain,
    shadingModel: document.shadingModel,
    blendMode: document.blendMode,
    twoSided: document.twoSided,
    alphaCutoff: document.alphaCutoff,
    nodes: document.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      properties: node.properties,
    })),
    edges: document.edges,
  });
}

/**
 * Preview/compile cache key. Node positions are excluded so layout drags do
 * not rebuild GPU materials. Invalid graphs still get a stable key.
 */
export function materialCompileKey(
  document: MaterialDocument,
  context?: MaterialLowerContext,
): string {
  const result = lowerMaterialDocument(document, context);
  if (result.ok) return result.plan.hash;
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
  const diagnostics = validateMaterialDocument(doc, context);
  if (diagnostics.some((row) => row.severity === "error")) {
    return { ok: false, diagnostics };
  }

  const functions = context.functions ?? {};
  const operations: MaterialOperation[] = [];
  const emitted = new Map<string, MaterialOperation>();
  const emitting = new Set<string>();
  const textures: MaterialTextureBinding[] = [];
  const usedFunctions = new Set<string>();

  const rootFrame: Frame = {
    graph: doc,
    resolver: createTypeResolver(doc, { functions }),
    prefix: "",
    callPath: [],
    inputBindings: new Map(),
  };

  /** Frames for call nodes, memoized so one call inlines its body once. */
  const callFrames = new Map<string, Frame>();

  function frameForCall(frame: Frame, callNode: MaterialGraphNode): Frame | null {
    const key = `${frame.prefix}${callNode.id}`;
    const cached = callFrames.get(key);
    if (cached) return cached;
    const guid = callNode.properties.functionGuid;
    const fn = typeof guid === "string" ? functions[guid] : undefined;
    if (!fn) return null;
    usedFunctions.add(guid as string);
    const bindings = new Map<string, MaterialOperand>();
    for (const pin of fn.inputs) {
      bindings.set(pin.id, operandForInput(frame, callNode, pin.id));
    }
    const child: Frame = {
      graph: fn,
      resolver: createTypeResolver(fn, { functions, functionInterface: fn }),
      prefix: `${key}/`,
      callPath: [...frame.callPath, callNode.id],
      functionGuid: guid as string,
      functionInterface: fn,
      inputBindings: bindings,
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
    const edge = frame.graph.edges.find(
      (candidate) =>
        candidate.targetNodeId === node.id && candidate.targetPinId === pinId,
    );
    if (!edge) {
      return pin ? pinDefault(pin, targetType) : constantOperand(targetType, undefined);
    }
    const produced = operandForOutput(frame, edge.sourceNodeId, edge.sourcePinId);
    if (!produced) {
      return pin ? pinDefault(pin, targetType) : constantOperand(targetType, undefined);
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
      return constantOperand(targetType, operand.value);
    }
    return { ...operand, convert: conversion };
  }

  /** Resolve a producing pin into an operand, inlining calls and plumbing. */
  function operandForOutput(
    frame: Frame,
    nodeId: string,
    pinId: string,
  ): MaterialOperand | null {
    const node = frame.graph.nodes.find((entry) => entry.id === nodeId);
    if (!node) return null;

    if (node.type === "function.input") {
      const bound = frame.inputBindings.get(pinId);
      if (bound) return bound;
      const declared = frame.functionInterface?.inputs.find(
        (entry) => entry.id === pinId,
      );
      return constantOperand(declared?.type ?? "float", declared?.defaultValue);
    }

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
    for (const pin of definition.inputs) {
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
      properties.value = constantComponents(
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
    emitted.set(id, operation);
    operations.push(operation);

    const textureGuid = node.properties.textureGuid;
    if (typeof textureGuid === "string" && textureGuid !== "") {
      textures.push({ operationId: id, textureGuid });
    }
    return operation;
  }

  const terminalType = terminalNodeTypeFor(doc.domain);
  const terminal = doc.nodes.find((node) => node.type === terminalType);
  const terminalDefinition = materialNodeDefinition(terminalType);
  const outputs: Record<string, MaterialOperand | null> = {};
  if (terminal && terminalDefinition) {
    for (const pin of terminalDefinition.inputs) {
      const wired = doc.edges.some(
        (edge) =>
          edge.targetNodeId === terminal.id && edge.targetPinId === pin.id,
      );
      if (!wired && !pin.defaultValue) {
        outputs[pin.id] = null;
        continue;
      }
      outputs[pin.id] = operandForInput(rootFrame, terminal, pin.id);
    }
  }

  const cost = costOf(operations);
  const header = [
    doc.domain,
    doc.shadingModel,
    doc.blendMode,
    doc.twoSided ? "two-sided" : "one-sided",
    doc.alphaCutoff.toFixed(4),
  ].join("|");

  return {
    ok: true,
    diagnostics,
    plan: {
      domain: doc.domain,
      shadingModel: doc.shadingModel,
      blendMode: doc.blendMode,
      twoSided: doc.twoSided,
      alphaCutoff: doc.alphaCutoff,
      operations,
      outputs,
      textures,
      cost,
      dependencies: {
        textures: [...new Set(textures.map((entry) => entry.textureGuid))].sort(),
        functions: [...usedFunctions].sort(),
      },
      bufferRequirements: bufferRequirementsOf(operations),
      hash: hashPlan(operations, outputs, header),
    },
  };
}

function costOf(operations: readonly MaterialOperation[]): MaterialCostFeatures {
  let weight = 0;
  let textureSamples = 0;
  let usesDerivatives = false;
  let usesSceneDepth = false;
  let usesSceneNormal = false;
  let customBlocks = 0;
  let inlinedFunctions = 0;
  const functionGuids = new Set<string>();
  for (const operation of operations) {
    const definition = materialNodeDefinition(operation.nodeType);
    weight += definition?.cost ?? 1;
    textureSamples += definition?.samples ?? 0;
    if (definition?.requires?.includes("derivatives")) usesDerivatives = true;
    if (definition?.requires?.includes("sceneDepth")) usesSceneDepth = true;
    if (definition?.requires?.includes("sceneNormal")) usesSceneNormal = true;
    if (operation.nodeType === "custom.glsl") customBlocks += 1;
    if (operation.source.functionGuid) {
      functionGuids.add(operation.source.functionGuid);
    }
  }
  inlinedFunctions = functionGuids.size;
  return {
    operations: operations.length,
    textureSamples,
    weight,
    usesDerivatives,
    usesSceneDepth,
    usesSceneNormal,
    customBlocks,
    inlinedFunctions,
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
