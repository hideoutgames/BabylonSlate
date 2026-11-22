import { createPinTypeResolver, type PinTypeResolver } from "@haptic/core";
import {
  isNamedRerouteDeclarationType,
  isNamedRerouteUsageType,
  materialNodeDefinition,
  namedRerouteDeclarationId,
  type MaterialNodeDefinition,
  type MaterialPinDefinition,
} from "./catalog";
import type {
  MaterialFunctionDocument,
  MaterialGraphEdge,
  MaterialGraphNode,
} from "./document";
import { resolveGenericType, type MaterialValueType } from "./types";
import { customGlslDefinition } from "./custom-glsl";
import { swizzleDefinition, vectorMaskDefinition } from "./vector-mask";
import { MATERIAL_GLOBAL_PARAMETER_NODE_TYPE, materialGlobalParameterDefinition } from "./global-parameter";

export interface ResolverGraph {
  nodes: MaterialGraphNode[];
  edges: MaterialGraphEdge[];
}

export interface TypeResolverOptions {
  functions?: Record<string, MaterialFunctionDocument>;
  /** Interface of the function this graph is the body of, if any. */
  functionInterface?: MaterialFunctionDocument;
}

/** Pin types of one Material graph, with the node and incoming-edge lookups lowering reuses. */
export interface TypeResolver
  extends PinTypeResolver<MaterialGraphNode, MaterialGraphEdge, MaterialNodeDefinition, MaterialValueType> {
  /**
   * The type a Named Reroute declaration, or a usage of one, carries: its declaration's wired source
   * type. Null when the declaration is unwired, missing or part of a reroute loop; the pins then
   * resolve as Float.
   */
  namedRerouteType(nodeId: string): MaterialValueType | null;
}

/** Call node pins mirror the callee's declared interface. */
export function callDefinition(
  base: MaterialNodeDefinition,
  fn: MaterialFunctionDocument,
): MaterialNodeDefinition {
  return {
    ...base,
    title: fn.name,
    inputs: fn.inputs.map((pin) => ({
      id: pin.id,
      name: pin.name,
      type: { kind: pin.type },
      // A Texture input has no value to fall back on: a default kept from an earlier numeric type is not one.
      ...(pin.defaultValue && pin.type !== "texture" ? { defaultValue: pin.defaultValue } : {}),
    })),
    outputs: fn.outputs.map((pin) => ({
      id: pin.id,
      name: pin.name,
      type: { kind: pin.type },
    })),
  };
}

/** Function Input / Output pins mirror the function's declared interface. */
export function plumbingDefinition(
  base: MaterialNodeDefinition,
  type: "function.input" | "function.output",
  fn: MaterialFunctionDocument,
): MaterialNodeDefinition {
  const pins = (type === "function.input" ? fn.inputs : fn.outputs).map(
    (pin) => ({
      id: pin.id,
      name: pin.name,
      type: { kind: pin.type } as const,
      ...(pin.defaultValue ? { defaultValue: pin.defaultValue } : {}),
    }),
  );
  return type === "function.input"
    ? { ...base, inputs: [], outputs: pins }
    : { ...base, inputs: pins, outputs: [] };
}

/**
 * A Named Reroute's pins at the type it carries: the declaration's input and the usage's output take
 * `type`, or stay `wildcard` when it is not known.
 */
export function namedRerouteDefinition(
  base: MaterialNodeDefinition,
  type: MaterialValueType | null,
): MaterialNodeDefinition {
  if (!type) return base;
  const typed = (pins: readonly MaterialPinDefinition[]) => pins.map((pin) => ({ ...pin, type: { kind: type } }));
  return { ...base, inputs: typed(base.inputs), outputs: typed(base.outputs) };
}

/**
 * Lazy type resolution over one graph (`createPinTypeResolver`). Generic nodes resolve from the types actually
 * wired in, so a chain of generic nodes propagates a vector width all the way down instead of collapsing to Float
 * at the first hop. A wildcard pin reads as Float.
 */
export function createTypeResolver(
  graph: ResolverGraph,
  options: TypeResolverOptions = {},
): TypeResolver {
  const functions = options.functions ?? {};
  const rerouteTypes = new Map<string, MaterialValueType | null>();
  // Declarations being resolved: a usage reached again inside its own chain is a loop that
  // validation reports, so it resolves as unknown instead of recursing.
  const reroutesInProgress = new Set<string>();

  const definition = (node: MaterialGraphNode): MaterialNodeDefinition | undefined => {
    let definition = materialNodeDefinition(node.type);
    if (!definition) return undefined;
    if (node.type === "custom.glsl") definition = customGlslDefinition(node, definition);
    if (node.type === "vector.mask") definition = vectorMaskDefinition(node, definition);
    if (node.type === "vector.swizzle") definition = swizzleDefinition(node, definition);
    if (node.type === MATERIAL_GLOBAL_PARAMETER_NODE_TYPE) definition = materialGlobalParameterDefinition(node, definition);
    // Unknown reroute types are Float, as the plan reads them.
    if (isNamedRerouteDeclarationType(node.type) || isNamedRerouteUsageType(node.type)) {
      definition = namedRerouteDefinition(definition, namedRerouteType(node.id) ?? "float");
    }
    if (node.type === "function.call") {
      const guid = node.properties.functionGuid;
      const fn = typeof guid === "string" ? functions[guid] : undefined;
      if (fn) definition = callDefinition(definition, fn);
    } else if (
      (node.type === "function.input" || node.type === "function.output") &&
      options.functionInterface
    ) {
      definition = plumbingDefinition(definition, node.type, options.functionInterface);
    }
    return definition;
  };

  const core = createPinTypeResolver({
    nodes: graph.nodes,
    edges: graph.edges,
    definition,
    // A node resolves only through its generic inputs.
    group: (entry: MaterialNodeDefinition) => (entry.inputs.some((pin) => pin.type.kind === "generic") ? true : null),
    resolve: (connected: readonly MaterialValueType[]) => {
      const resolution = resolveGenericType(connected);
      return resolution.ok ? resolution.type : "conflict";
    },
    wildcard: "float",
  });

  function declarationType(declarationId: string): MaterialValueType | null {
    const cached = rerouteTypes.get(declarationId);
    if (cached !== undefined) return cached;
    const node = core.node(declarationId);
    if (!node || !isNamedRerouteDeclarationType(node.type) || reroutesInProgress.has(declarationId)) return null;
    reroutesInProgress.add(declarationId);
    const edge = core.incoming(declarationId, "in");
    const type = edge ? core.outputType(edge.sourceNodeId, edge.sourcePinId) : null;
    reroutesInProgress.delete(declarationId);
    rerouteTypes.set(declarationId, type);
    return type;
  }

  function namedRerouteType(nodeId: string): MaterialValueType | null {
    const node = core.node(nodeId);
    if (!node) return null;
    if (isNamedRerouteDeclarationType(node.type)) return declarationType(nodeId);
    if (isNamedRerouteUsageType(node.type)) return declarationType(namedRerouteDeclarationId(node));
    return null;
  }

  return { ...core, namedRerouteType };
}
