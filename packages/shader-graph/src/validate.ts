import {
  materialNodeDefinition,
  nodeIsLegalInDomain,
  terminalNodeTypeFor,
  type MaterialCapability,
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
import { createTypeResolver } from "./resolve";
import {
  materialTypeLabel,
  typesAreAssignable,
  type MaterialValueType,
} from "./types";

export type MaterialDiagnosticSeverity = "error" | "warning";

export interface MaterialDiagnostic {
  code: string;
  message: string;
  severity: MaterialDiagnosticSeverity;
  /** Graph node the message anchors to. Function bodies use `call/inner`. */
  nodeId?: string;
  pinId?: string;
  edgeId?: string;
}

export type MaterialCapabilities = Partial<Record<MaterialCapability, boolean>>;

export interface MaterialValidationContext {
  /** Material Function documents by asset guid. */
  functions?: Record<string, MaterialFunctionDocument>;
  /** Registry lookup so a deleted texture is reported at the node. */
  textureExists?: (guid: string) => boolean;
  capabilities?: MaterialCapabilities;
  /** Surface the iPad fill-rate warning (project baseline setting). */
  warnPostProcessCost?: boolean;
}

const DEFAULT_CAPABILITIES: Required<MaterialCapabilities> = {
  derivatives: true,
  textureLod: true,
  sceneDepth: true,
  vertexTexture: false,
  customGlsl: true,
};

export const CUSTOM_GLSL_BODY_MAX = 4096;

export function customGlslBody(node: MaterialGraphNode): string {
  const body = node.properties.body;
  if (typeof body === "string") return body;
  const legacy = node.properties.glsl;
  return typeof legacy === "string" ? legacy : "";
}

/**
 * Custom GLSL is an expression over `a` and `b` only. The compiler generates
 * the function signature; the body must not declare uniforms, samplers,
 * preprocessor directives, or statements.
 */
export function validateCustomGlslBody(
  body: string,
): MaterialDiagnostic | null {
  const trimmed = body.trim();
  if (trimmed === "") {
    return {
      code: "material.customGlsl",
      message: "Custom GLSL needs a non-empty expression over A and B",
      severity: "error",
    };
  }
  if (body.length > CUSTOM_GLSL_BODY_MAX) {
    return {
      code: "material.customGlsl",
      message: `Custom GLSL expressions are limited to ${CUSTOM_GLSL_BODY_MAX} characters`,
      severity: "error",
    };
  }
  if (/[#;{}]/.test(body) || /\b(uniform|sampler|void|return|out)\b/.test(body)) {
    return {
      code: "material.customGlsl",
      message:
        "Custom GLSL must be a single expression: no statements, uniforms, samplers, or preprocessor directives",
      severity: "error",
    };
  }
  if (/\bgl_/.test(body)) {
    return {
      code: "material.customGlsl",
      message: "Custom GLSL cannot read built-in GLSL globals such as gl_FragColor",
      severity: "error",
    };
  }
  if (/(^|[^=!<>])=(?!=)/.test(body)) {
    return {
      code: "material.customGlsl",
      message: "Custom GLSL cannot assign; write an expression that produces the result",
      severity: "error",
    };
  }
  return null;
}

function pinById(
  pins: readonly MaterialPinDefinition[],
  id: string,
): MaterialPinDefinition | undefined {
  return pins.find((pin) => pin.id === id);
}

interface GraphLike {
  nodes: MaterialGraphNode[];
  edges: MaterialGraphEdge[];
}

/** Depth-first cycle search over data edges. */
export function findGraphCycle(graph: GraphLike): string[] | null {
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = outgoing.get(edge.sourceNodeId) ?? [];
    list.push(edge.targetNodeId);
    outgoing.set(edge.sourceNodeId, list);
  }
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];

  const visit = (nodeId: string): string[] | null => {
    const current = state.get(nodeId);
    if (current === "done") return null;
    if (current === "visiting") {
      const start = stack.indexOf(nodeId);
      return stack.slice(start >= 0 ? start : 0);
    }
    state.set(nodeId, "visiting");
    stack.push(nodeId);
    for (const next of outgoing.get(nodeId) ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(nodeId, "done");
    return null;
  };

  for (const node of graph.nodes) {
    const cycle = visit(node.id);
    if (cycle) return cycle;
  }
  return null;
}

/** Function guids reachable from a graph, or the recursion chain that fails. */
export function collectFunctionDependencies(
  graph: GraphLike,
  functions: Record<string, MaterialFunctionDocument>,
  visiting: readonly string[] = [],
): { guids: string[]; recursion: string[] | null; missing: string[] } {
  const guids: string[] = [];
  const missing: string[] = [];
  let recursion: string[] | null = null;
  for (const node of graph.nodes) {
    if (node.type !== "function.call") continue;
    const guid = node.properties.functionGuid;
    if (typeof guid !== "string" || guid === "") continue;
    if (visiting.includes(guid)) {
      recursion ??= [...visiting, guid];
      continue;
    }
    const fn = functions[guid];
    if (!fn) {
      missing.push(guid);
      continue;
    }
    guids.push(guid);
    const nested = collectFunctionDependencies(fn, functions, [
      ...visiting,
      guid,
    ]);
    guids.push(...nested.guids);
    missing.push(...nested.missing);
    recursion ??= nested.recursion;
  }
  return { guids: [...new Set(guids)], recursion, missing: [...new Set(missing)] };
}

interface ValidateGraphOptions extends MaterialValidationContext {
  domain: MaterialDomain;
  /** Function graphs use their interface pins instead of a terminal node. */
  functionInterface?: MaterialFunctionDocument;
}

function definitionForNode(
  node: MaterialGraphNode,
  options: ValidateGraphOptions,
): MaterialNodeDefinition | undefined {
  if (node.type === "function.call") {
    return functionCallDefinition(node, options.functions ?? {});
  }
  if (node.type === "function.input" || node.type === "function.output") {
    return functionPlumbingDefinition(node.type, options.functionInterface);
  }
  return materialNodeDefinition(node.type);
}

/** Call node pins mirror the target function's declared interface. */
export function functionCallDefinition(
  node: MaterialGraphNode,
  functions: Record<string, MaterialFunctionDocument>,
): MaterialNodeDefinition | undefined {
  const base = materialNodeDefinition("function.call");
  if (!base) return undefined;
  const guid = node.properties.functionGuid;
  const fn = typeof guid === "string" ? functions[guid] : undefined;
  if (!fn) return base;
  return {
    ...base,
    title: fn.name,
    inputs: fn.inputs.map((pin) => ({
      id: pin.id,
      name: pin.name,
      type: { kind: pin.type },
      ...(pin.defaultValue ? { defaultValue: pin.defaultValue } : {}),
    })),
    outputs: fn.outputs.map((pin) => ({
      id: pin.id,
      name: pin.name,
      type: { kind: pin.type },
    })),
  };
}

export function functionPlumbingDefinition(
  type: "function.input" | "function.output",
  fn: MaterialFunctionDocument | undefined,
): MaterialNodeDefinition | undefined {
  const base = materialNodeDefinition(type);
  if (!base || !fn) return base;
  if (type === "function.input") {
    return {
      ...base,
      inputs: [],
      outputs: fn.inputs.map((pin) => ({
        id: pin.id,
        name: pin.name,
        type: { kind: pin.type },
      })),
    };
  }
  return {
    ...base,
    inputs: fn.outputs.map((pin) => ({
      id: pin.id,
      name: pin.name,
      type: { kind: pin.type },
    })),
    outputs: [],
  };
}

function validateGraph(
  graph: GraphLike,
  options: ValidateGraphOptions,
): MaterialDiagnostic[] {
  const diagnostics: MaterialDiagnostic[] = [];
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const definitions = new Map<string, MaterialNodeDefinition>();
  const capabilities = { ...DEFAULT_CAPABILITIES, ...options.capabilities };

  for (const node of graph.nodes) {
    const definition = definitionForNode(node, options);
    if (!definition) {
      diagnostics.push({
        code: "material.unknownNode",
        message: `Node type "${node.type}" is not in the material catalog`,
        severity: "error",
        nodeId: node.id,
      });
      continue;
    }
    definitions.set(node.id, definition);

    if (
      node.type !== "function.call" &&
      node.type !== "function.input" &&
      node.type !== "function.output" &&
      !nodeIsLegalInDomain(node.type, options.domain)
    ) {
      diagnostics.push({
        code: "material.domainMismatch",
        message: `"${definition.title}" cannot be used in a ${
          options.domain === "surface" ? "surface" : "post-process"
        } material`,
        severity: "error",
        nodeId: node.id,
      });
    }

    for (const capability of definition.requires ?? []) {
      if (capabilities[capability] === false) {
        diagnostics.push({
          code: "material.capability",
          message:
            capability === "customGlsl"
              ? "Custom GLSL is GLSL/WebGL only and cannot run on WebGPU"
              : `"${definition.title}" needs ${capability} support, which this device does not report`,
          severity: "error",
          nodeId: node.id,
        });
      }
    }

    if (node.type === "custom.glsl") {
      const custom = validateCustomGlslBody(customGlslBody(node));
      if (custom) {
        diagnostics.push({ ...custom, nodeId: node.id });
      }
    }

    if (node.type === "function.call") {
      const guid = node.properties.functionGuid;
      if (typeof guid !== "string" || guid === "") {
        diagnostics.push({
          code: "material.function.missing",
          message: "Material Function node has no function selected",
          severity: "error",
          nodeId: node.id,
        });
      } else if (options.functions && !options.functions[guid]) {
        diagnostics.push({
          code: "material.function.missing",
          message: `Material Function "${guid}" is not in this project`,
          severity: "error",
          nodeId: node.id,
        });
      }
    }

    const textureGuid = node.properties.textureGuid;
    if (
      typeof textureGuid === "string" &&
      textureGuid !== "" &&
      options.textureExists &&
      !options.textureExists(textureGuid)
    ) {
      diagnostics.push({
        code: "material.missingTexture",
        message: `Texture "${textureGuid}" is not in this project`,
        severity: "error",
        nodeId: node.id,
      });
    }
  }

  for (const edge of graph.edges) {
    const source = nodesById.get(edge.sourceNodeId);
    const target = nodesById.get(edge.targetNodeId);
    if (!source || !target) {
      diagnostics.push({
        code: "material.danglingEdge",
        message: "Connection points at a node that is no longer in the graph",
        severity: "error",
        edgeId: edge.id,
        nodeId: source?.id ?? target?.id,
      });
      continue;
    }
    const sourceDefinition = definitions.get(source.id);
    const targetDefinition = definitions.get(target.id);
    if (!sourceDefinition || !targetDefinition) continue;
    if (!pinById(sourceDefinition.outputs, edge.sourcePinId)) {
      diagnostics.push({
        code: "material.unknownPin",
        message: `"${sourceDefinition.title}" has no output pin "${edge.sourcePinId}"`,
        severity: "error",
        edgeId: edge.id,
        nodeId: source.id,
        pinId: edge.sourcePinId,
      });
    }
    if (!pinById(targetDefinition.inputs, edge.targetPinId)) {
      diagnostics.push({
        code: "material.unknownPin",
        message: `"${targetDefinition.title}" has no input pin "${edge.targetPinId}"`,
        severity: "error",
        edgeId: edge.id,
        nodeId: target.id,
        pinId: edge.targetPinId,
      });
    }
  }

  const seenTargets = new Set<string>();
  for (const edge of graph.edges) {
    const key = `${edge.targetNodeId}:${edge.targetPinId}`;
    if (seenTargets.has(key)) {
      const target = nodesById.get(edge.targetNodeId);
      diagnostics.push({
        code: "material.duplicateConnection",
        message: `Input "${edge.targetPinId}" on "${
          definitions.get(edge.targetNodeId)?.title ?? target?.type ?? "node"
        }" already has a connection`,
        severity: "error",
        edgeId: edge.id,
        nodeId: edge.targetNodeId,
        pinId: edge.targetPinId,
      });
    }
    seenTargets.add(key);
  }

  const cycle = findGraphCycle(graph);
  if (cycle) {
    diagnostics.push({
      code: "material.cycle",
      message: `Nodes form a loop: ${cycle.join(" → ")}`,
      severity: "error",
      nodeId: cycle[0],
    });
  }

  // Generic resolution and type checks only make sense on an acyclic graph.
  if (!cycle) {
    const resolver = createTypeResolver(graph, {
      functions: options.functions,
      functionInterface: options.functionInterface,
    });

    for (const nodeId of resolver.conflicts()) {
      diagnostics.push({
        code: "material.genericConflict",
        message: `"${
          definitions.get(nodeId)?.title ?? nodeId
        }" received values of different widths; insert a Combine or Split node`,
        severity: "error",
        nodeId,
      });
    }

    for (const edge of graph.edges) {
      const source = nodesById.get(edge.sourceNodeId);
      const target = nodesById.get(edge.targetNodeId);
      if (!source || !target) continue;
      const sourceDefinition = definitions.get(source.id);
      const targetDefinition = definitions.get(target.id);
      if (!sourceDefinition || !targetDefinition) continue;
      if (!pinById(sourceDefinition.outputs, edge.sourcePinId)) continue;
      if (!pinById(targetDefinition.inputs, edge.targetPinId)) continue;
      const from: MaterialValueType | null = resolver.outputType(
        source.id,
        edge.sourcePinId,
      );
      const to: MaterialValueType | null = resolver.inputType(
        target.id,
        edge.targetPinId,
      );
      if (!from || !to) continue;
      if (typesAreAssignable(from, to)) continue;
      diagnostics.push({
        code: "material.typeMismatch",
        message: `${materialTypeLabel(from)} from "${
          sourceDefinition.title
        }" cannot connect to ${materialTypeLabel(to)} on "${
          targetDefinition.title
        }"`,
        severity: "error",
        edgeId: edge.id,
        nodeId: target.id,
        pinId: edge.targetPinId,
      });
    }
  }

  for (const node of graph.nodes) {
    const definition = definitions.get(node.id);
    if (!definition) continue;
    for (const pin of definition.inputs) {
      const required = pin.required ?? pin.type.kind === "texture";
      if (!required) continue;
      const wired = graph.edges.some(
        (edge) => edge.targetNodeId === node.id && edge.targetPinId === pin.id,
      );
      if (wired || pin.defaultValue) continue;
      if (pin.type.kind === "texture") {
        const guid = node.properties.textureGuid;
        if (typeof guid === "string" && guid !== "") continue;
      }
      diagnostics.push({
        code: "material.missingInput",
        message: `"${definition.title}" needs a value on "${pin.name}"`,
        severity: "error",
        nodeId: node.id,
        pinId: pin.id,
      });
    }
  }

  return diagnostics;
}

export function validateMaterialDocument(
  doc: MaterialDocument,
  context: MaterialValidationContext = {},
): MaterialDiagnostic[] {
  const diagnostics = validateGraph(doc, { ...context, domain: doc.domain });
  const terminalType = terminalNodeTypeFor(doc.domain);
  const terminals = doc.nodes.filter((node) => node.type === terminalType);
  if (terminals.length === 0) {
    diagnostics.push({
      code: "material.noOutput",
      message: `Material needs a ${
        doc.domain === "surface" ? "Material Output" : "Post Process Output"
      } node`,
      severity: "error",
    });
  } else if (terminals.length > 1) {
    for (const extra of terminals.slice(1)) {
      diagnostics.push({
        code: "material.multipleOutputs",
        message: "A material can only have one output node",
        severity: "error",
        nodeId: extra.id,
      });
    }
  }

  const functions = context.functions ?? {};
  const dependencies = collectFunctionDependencies(doc, functions);
  if (dependencies.recursion) {
    diagnostics.push({
      code: "material.function.recursive",
      message: `Material Functions call each other in a loop: ${dependencies.recursion.join(
        " → ",
      )}`,
      severity: "error",
    });
  }

  if (doc.domain === "postProcess" && context.warnPostProcessCost) {
    diagnostics.push({
      code: "material.postProcessCost",
      message:
        "Post-process materials run a full-screen pass and are off by default on the iPad baseline",
      severity: "warning",
    });
  }

  return diagnostics;
}

export function validateMaterialFunctionDocument(
  fn: MaterialFunctionDocument,
  context: MaterialValidationContext = {},
): MaterialDiagnostic[] {
  const diagnostics = validateGraph(fn, {
    ...context,
    // Functions must stay domain-neutral so either material kind can call them.
    domain: "surface",
    functionInterface: fn,
  });

  if (fn.outputs.length === 0) {
    diagnostics.push({
      code: "material.function.noOutputs",
      message: "Material Function needs at least one output",
      severity: "error",
    });
  }

  const outputNode = fn.nodes.find((node) => node.type === "function.output");
  for (const pin of fn.outputs) {
    const wired =
      outputNode &&
      fn.edges.some(
        (edge) =>
          edge.targetNodeId === outputNode.id && edge.targetPinId === pin.id,
      );
    if (wired) continue;
    diagnostics.push({
      code: "material.function.unboundOutput",
      message: `Output "${pin.name}" has nothing wired into it`,
      severity: "error",
      nodeId: outputNode?.id,
      pinId: pin.id,
    });
  }

  const seen = new Set<string>();
  for (const pin of [...fn.inputs, ...fn.outputs]) {
    if (seen.has(pin.id)) {
      diagnostics.push({
        code: "material.function.duplicatePin",
        message: `Two pins share the id "${pin.id}"`,
        severity: "error",
        pinId: pin.id,
      });
    }
    seen.add(pin.id);
  }

  const dependencies = collectFunctionDependencies(
    fn,
    context.functions ?? {},
  );
  if (dependencies.recursion) {
    diagnostics.push({
      code: "material.function.recursive",
      message: `Material Functions call each other in a loop: ${dependencies.recursion.join(
        " → ",
      )}`,
      severity: "error",
    });
  }

  return diagnostics;
}
