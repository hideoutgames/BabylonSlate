import { nameNewMaterialParameters } from "./parameter-authoring";
import {
  defaultNamedRerouteColor,
  nameNewNamedReroutes,
  namedRerouteColor,
  namedRerouteColorCss,
  namedRerouteDeclarations,
  uniqueNamedRerouteName,
} from "./named-reroute";
import { globalParameterNodeTitle, type GlobalParameterCatalog, type SerializedGraph } from "@haptic/core";
import {
  NAMED_REROUTE_DECLARATION_TYPE,
  NAMED_REROUTE_USAGE_TYPE,
  isNamedRerouteDeclarationType,
  isNamedRerouteUsageType,
  materialNodeDefinition,
  materialPaletteEntries,
  namedRerouteDeclarationId,
  namedRerouteName,
  type MaterialDomain,
  type MaterialPinDefinition,
} from "./catalog";
import {
  normalizeMaterialDocument,
  type MaterialDocument,
  type MaterialFunctionDocument,
  type MaterialGraphEdge,
  type MaterialGraphNode,
} from "./document";
import { isNumericType, typesAreAssignable, type MaterialValueType } from "./types";
import { isMaterialParameterNode, materialParameterName } from "./parameters";
import { customGlslDefinition, newCustomGlslProperties } from "./custom-glsl";
import { callDefinition, createTypeResolver, namedRerouteDefinition, plumbingDefinition } from "./resolve";
import { swizzleDefinition, vectorMaskDefinition } from "./vector-mask";
import { MATERIAL_GLOBAL_PARAMETER_NODE_TYPE, materialGlobalParameterDefinition } from "./global-parameter";

/** Pin shape the shared graph shell renders and connects. */
export interface MaterialGraphPin {
  typeLabel?: string;
  group?: string;
  id: string;
  name: string;
  kind: "data";
  direction: "in" | "out";
  /**
   * `wildcard: true` marks a wired Named Reroute declaration's input: it shows the type wired in and
   * still accepts any other (`materialPinsAreCompatible`).
   */
  type: { kind: string; wildcard?: true };
  defaultValue?: number[];
  colorHint?: boolean;
}

export interface MaterialPinContext {
  properties?: Record<string, unknown>;
  functions?: Record<string, MaterialFunctionDocument>;
  /** Interface used to hydrate `function.input` / `function.output` nodes. */
  functionInterface?: MaterialFunctionDocument;
  /** Selected function for a `function.call` node. */
  functionGuid?: string;
  /** The project's Global Parameter Collections, which title Global Parameter nodes. */
  globalParameters?: Readonly<GlobalParameterCatalog>;
  /** The type a Named Reroute carries (`TypeResolver.namedRerouteType`); unset leaves its pin a wildcard. */
  namedRerouteType?: MaterialValueType | null;
  /** The node's graph, so a Named Reroute usage is titled by its declaration's name. */
  graphNodes?: readonly Pick<MaterialGraphNode, "id" | "type" | "properties">[];
}

function toPin(
  pin: MaterialPinDefinition,
  direction: "in" | "out",
): MaterialGraphPin {
  return {
    id: pin.id,
    name: pin.name,
    kind: "data",
    direction,
    type: { kind: pin.type.kind },
    ...(pin.defaultValue ? { defaultValue: pin.defaultValue } : {}),
    ...(pin.colorHint ? { colorHint: true } : {}),
  };
}

export function pinsForMaterialNode(
  type: string,
  context: MaterialPinContext = {},
): MaterialGraphPin[] {
  let definition = materialNodeDefinition(type);
  if (type === "function.call") {
    const fn = context.functionGuid
      ? context.functions?.[context.functionGuid]
      : undefined;
    if (!fn || !definition) return [];
    definition = callDefinition(definition, fn);
  } else if (type === "function.input" || type === "function.output") {
    const fn = context.functionInterface;
    if (!fn || !definition) return [];
    definition = plumbingDefinition(definition, type, fn);
  }
  if (definition && type === "vector.mask") definition = vectorMaskDefinition({ id: "", type, position: { x: 0, y: 0 }, properties: context.properties ?? {} }, definition);
  if (definition && type === "vector.swizzle") definition = swizzleDefinition({ id: "", type, position: { x: 0, y: 0 }, properties: context.properties ?? {} }, definition);
  if (definition && type === MATERIAL_GLOBAL_PARAMETER_NODE_TYPE) definition = materialGlobalParameterDefinition({ properties: context.properties ?? {} }, definition);
  if (definition && type === "custom.glsl" && context.properties) {
    definition = customGlslDefinition({ id: "", type, position: { x: 0, y: 0 }, properties: context.properties }, definition);
  }
  const rerouteType = context.namedRerouteType ?? null;
  if (definition && (isNamedRerouteDeclarationType(type) || isNamedRerouteUsageType(type))) {
    definition = namedRerouteDefinition(definition, rerouteType);
  }
  if (!definition) return [];
  const pins = [
    ...definition.inputs.map((pin) => toPin(pin, "in")),
    ...definition.outputs.map((pin) => toPin(pin, "out")),
  ];
  if (rerouteType && isNamedRerouteDeclarationType(type)) for (const pin of pins) pin.type = { kind: rerouteType, wildcard: true };
  return pins;
}

export interface MaterialPaletteNode {
  defaultData?: Record<string, unknown>;
  id: string;
  /** The node type the row adds when `id` is not one (Named Reroute rows). */
  nodeType?: string;
  title: string;
  /** The added node's title when the row names an action or a declaration. */
  nodeTitle?: string;
  category: string;
  searchAliases?: readonly string[];
  pins: MaterialGraphPin[];
  /** CSS colour of the row's chip: a Named Reroute's colour. */
  headerColor?: string;
}

/** The nodes Add Node offers: the palette without the output node, which every Material already has exactly one of. */
export function materialAddNodePalette(domain: MaterialDomain): MaterialPaletteNode[] {
  return materialPaletteNodes(domain).filter((node) => !materialNodeDefinition(node.id)?.terminal);
}

export function materialPaletteNodes(
  domain: MaterialDomain,
): MaterialPaletteNode[] {
  return materialPaletteEntries(domain).map((definition) => ({
    id: definition.type,
    title: definition.title,
    category: definition.category,
    searchAliases: definition.searchAliases,
    pins: pinsForMaterialNode(definition.type, { properties: newNodeDefaults(definition.type) }),
    defaultData: { ...newNodeDefaults(definition.type), __material: true },
  }));
}

const EDITOR_NODE_KEYS = new Set([
  "__pins",
  "__material",
  "__nodeType",
  "__category",
  "__pure",
  "__latent",
  "__editorOnly",
  "__headerColor",
  "title",
]);

function propertiesFromNodeData(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!EDITOR_NODE_KEYS.has(key)) properties[key] = value;
  }
  return properties;
}

function newNodeDefaults(type: string): Record<string, unknown> {
  if (type === "custom.glsl") return newCustomGlslProperties();
  return {};
}

export function materialGraphToSerialized(
  doc: MaterialDocument | MaterialFunctionDocument,
): SerializedGraph {
  return {
    nodes: doc.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      position: node.position,
      data: { ...node.properties },
    })),
    edges: doc.edges.map((edge) => ({
      id: edge.id,
      source: edge.sourceNodeId,
      target: edge.targetNodeId,
      sourceHandle: edge.sourcePinId,
      targetHandle: edge.targetPinId,
    })),
  };
}

/**
 * Fold canvas edits back into the document. Everything the canvas does not own
 * (domain, blend mode, preview settings) comes from `previous`.
 */
export function serializedToMaterialGraph(
  graph: SerializedGraph,
  previous?: MaterialDocument,
): MaterialDocument {
  const base = previous ?? normalizeMaterialDocument({});
  const nodes = graph.nodes.map((node) => ({
    id: node.id,
    type: node.type,
    position: node.position,
    properties: propertiesFromNodeData(node.data),
  }));
  return normalizeMaterialDocument({
    ...base,
    // Added, pasted and duplicated parameters and Named Reroutes get a free name (`_N` when theirs is taken).
    nodes: previous ? nameNewNamedReroutes(previous.nodes, nameNewMaterialParameters(previous.nodes, nodes)) : nodes,
    edges: graph.edges.map((edge) => ({
      id: edge.id,
      sourceNodeId: edge.source,
      targetNodeId: edge.target,
      sourcePinId: edge.sourceHandle,
      targetPinId: edge.targetHandle,
    })),
  });
}

export function serializedToMaterialFunctionGraph(
  graph: SerializedGraph,
  previous: MaterialFunctionDocument,
): MaterialFunctionDocument {
  return {
    ...previous,
    nodes: nameNewNamedReroutes(previous.nodes, nameNewMaterialParameters(previous.nodes, graph.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      position: node.position,
      properties: propertiesFromNodeData(node.data),
    })))),
    edges: graph.edges.flatMap((edge) =>
      edge.sourceHandle && edge.targetHandle
        ? [{
            id: edge.id,
            sourceNodeId: edge.source,
            targetNodeId: edge.target,
            sourcePinId: edge.sourceHandle,
            targetPinId: edge.targetHandle,
          }]
        : [],
    ),
  };
}

/** The title of a Named Reroute usage whose declaration is gone. */
const MISSING_REROUTE_TITLE = "Missing Reroute";

/**
 * The title a node shows on the canvas: a parameter's or Named Reroute's name (a usage's
 * declaration's, from `graphNodes`), a Global Parameter's selection, a Material Function call's
 * function name, else its definition's title as its properties shape it (Swizzle (ZX), Component
 * Mask (XZ)). `definition` is the node's resolved definition when the caller already has it.
 */
export function materialNodeTitle(
  node: { type: string; properties: Record<string, unknown> },
  context: Pick<MaterialPinContext, "functions" | "globalParameters" | "graphNodes"> = {},
  definition = createTypeResolver(
    { nodes: [{ id: "node", position: { x: 0, y: 0 }, ...node }], edges: [] },
    { functions: context.functions },
  ).definitionOf("node"),
): string {
  if (isMaterialParameterNode(node.type)) return materialParameterName(node) || definition?.title || node.type;
  if (isNamedRerouteDeclarationType(node.type)) return namedRerouteName(node) || definition?.title || node.type;
  if (isNamedRerouteUsageType(node.type) && context.graphNodes) {
    const declarationId = namedRerouteDeclarationId(node);
    const declaration = context.graphNodes.find((entry) => entry.id === declarationId && isNamedRerouteDeclarationType(entry.type));
    return declaration ? namedRerouteName(declaration) || definition?.title || node.type : MISSING_REROUTE_TITLE;
  }
  if (node.type === MATERIAL_GLOBAL_PARAMETER_NODE_TYPE) return globalParameterNodeTitle(node.properties, context.globalParameters);
  const functionGuid = node.type === "function.call" && typeof node.properties.functionGuid === "string" ? node.properties.functionGuid : undefined;
  return (functionGuid ? context.functions?.[functionGuid]?.name : undefined) ?? definition?.title ?? node.type;
}

/** Inject catalog pins and titles so the canvas can draw and connect nodes. */
function pinTypeLabel(kind: string): string {
  return kind === "float" ? "Float" : kind === "texture" ? "Texture" : /^vec[234]$/.test(kind) ? `V${kind.slice(-1)}` : "Numeric";
}

/**
 * Inject catalog pins and titles so the canvas can draw and connect nodes. Named Reroutes take
 * their declaration's name as title and its colour as `__headerColor`; their pins show the type
 * the declaration carries, or a wildcard while it carries none.
 */
export function hydrateMaterialGraphForEditor(
  graph: SerializedGraph,
  context: MaterialPinContext = {},
): SerializedGraph {
  const nodes = graph.nodes.map((node) => ({ ...node, properties: propertiesFromNodeData(node.data) }));
  const resolver = createTypeResolver({
    nodes,
    edges: graph.edges.map((edge) => ({ id: edge.id, sourceNodeId: edge.source, sourcePinId: edge.sourceHandle ?? "", targetNodeId: edge.target, targetPinId: edge.targetHandle ?? "" })),
  }, context);
  const declarations = new Map<string, { name: string; headerColor: string }>();
  for (const node of nodes) {
    if (isNamedRerouteDeclarationType(node.type) && !declarations.has(node.id)) {
      declarations.set(node.id, { name: namedRerouteName(node), headerColor: namedRerouteColorCss(namedRerouteColor(node)) });
    }
  }
  return {
    ...graph,
    nodes: graph.nodes.map((node, index) => {
      const data = { ...(node.data as Record<string, unknown>) };
      const functionGuid =
        typeof data.functionGuid === "string" ? data.functionGuid : undefined;
      const declaration = isNamedRerouteDeclarationType(node.type);
      const usage = isNamedRerouteUsageType(node.type);
      const rerouteType = declaration || usage ? resolver.namedRerouteType(node.id) : null;
      const pins = pinsForMaterialNode(node.type, { ...context, functionGuid, properties: data, namedRerouteType: rerouteType });
      for (const pin of pins) {
        if (declaration || usage) {
          pin.typeLabel = rerouteType ? pinTypeLabel(rerouteType) : declaration ? "Any" : "Numeric";
          continue;
        }
        if (node.type === "output.surface") pin.group = ({ baseColor: "Surface", emissive: "Emission", opacity: "Transparency", worldPositionOffset: "Geometry" } as Record<string, string>)[pin.id];
        const resolved = pin.direction === "in" ? resolver.inputType(node.id, pin.id) : resolver.outputType(node.id, pin.id);
        if (pin.type.kind === "generic" && resolved && resolved !== "float") pin.type = { kind: resolved };
        pin.typeLabel = pinTypeLabel(resolved ?? pin.type.kind);
      }
      const definition = resolver.definitionOf(node.id);
      const reroute = declaration
        ? declarations.get(node.id)
        : usage ? declarations.get(namedRerouteDeclarationId(nodes[index]!)) : undefined;
      const title = declaration || usage
        ? (reroute ? reroute.name || definition?.title || node.type : MISSING_REROUTE_TITLE)
        : materialNodeTitle({ type: node.type, properties: data }, context, definition);
      return {
        ...node,
        data: {
          ...data,
          __pins: pins,
          __material: true,
          __nodeType: node.type,
          ...(definition ? { __category: definition.category } : {}),
          ...(reroute ? { __headerColor: reroute.headerColor } : {}),
          title,
        },
      };
    }),
  };
}

/** Add Node's row that creates a Named Reroute declaration. */
export const CREATE_NAMED_REROUTE_PALETTE_TITLE = "Create Named Reroute…";

/**
 * Add Node's Named Reroute rows for one graph: **Create Named Reroute…** first (a free name and the
 * next default colour), then one row per declaration, by name, that adds a usage of it.
 */
export function namedReroutePaletteNodes(
  graph: { nodes: MaterialGraphNode[]; edges: MaterialGraphEdge[] },
  context: Pick<MaterialPinContext, "functions" | "functionInterface"> = {},
): MaterialPaletteNode[] {
  const declarations = namedRerouteDeclarations(graph.nodes);
  const name = uniqueNamedRerouteName(graph.nodes);
  const color = defaultNamedRerouteColor(declarations.length);
  const create: MaterialPaletteNode = {
    id: NAMED_REROUTE_DECLARATION_TYPE,
    nodeType: NAMED_REROUTE_DECLARATION_TYPE,
    title: CREATE_NAMED_REROUTE_PALETTE_TITLE,
    nodeTitle: name,
    category: "Reroute",
    searchAliases: ["Named Reroute", "Declare Reroute"],
    pins: pinsForMaterialNode(NAMED_REROUTE_DECLARATION_TYPE),
    defaultData: { name, color, __material: true, __headerColor: namedRerouteColorCss(color) },
    headerColor: namedRerouteColorCss(color),
  };
  if (declarations.length === 0) return [create];
  const resolver = createTypeResolver(graph, context);
  return [
    create,
    ...declarations.map((declaration): MaterialPaletteNode => {
      const headerColor = namedRerouteColorCss(declaration.color);
      return {
        id: `${NAMED_REROUTE_USAGE_TYPE}:${declaration.nodeId}`,
        nodeType: NAMED_REROUTE_USAGE_TYPE,
        title: declaration.name,
        nodeTitle: declaration.name,
        category: "Reroute",
        searchAliases: ["Named Reroute"],
        pins: pinsForMaterialNode(NAMED_REROUTE_USAGE_TYPE, { namedRerouteType: resolver.namedRerouteType(declaration.nodeId) }),
        defaultData: { declarationId: declaration.nodeId, __material: true, __headerColor: headerColor },
        headerColor,
      };
    }),
  ];
}

type CanvasPin = { direction: "in" | "out"; type: { kind: string; wildcard?: unknown } };

/**
 * Material numeric pins accept every numeric width, including generic pins.
 * Textures only meet textures. A Named Reroute declaration's input takes any output; a usage
 * connects as its carried type, or to numeric inputs while it carries none.
 */
export function materialPinsAreCompatible(
  outgoing: CanvasPin,
  incoming: CanvasPin,
): boolean {
  const from = outgoing.type.kind;
  const to = incoming.type.kind;
  if (to === "wildcard" || incoming.type.wildcard === true) return true;
  if (from === "wildcard") return to === "generic" || isNumericType(to);
  if (from === "generic" && to === "generic") return true;
  if (from === "generic") return isNumericType(to);
  if (to === "generic") return isNumericType(from);
  if (from === "texture" || to === "texture") return from === to;
  return typesAreAssignable(
    from as MaterialValueType,
    to as MaterialValueType,
  );
}
