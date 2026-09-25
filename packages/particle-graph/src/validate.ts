import { PARTICLE_CPU_CAPACITY_BUDGET } from "@babylonslate/core";
import {
  PARTICLE_OUTPUT_NODE_TYPE,
  PARTICLE_UNSUPPORTED_V1_TYPES,
  particleNodeDefinitionFor,
  type ParticleNodeDefinition,
  type ParticlePinDefinition,
} from "./catalog";
import type {
  ParticleGraphDocument,
  ParticleGraphEdge,
  ParticleGraphNode,
} from "./document";
import { readParticlePinDefault } from "./pin-defaults";
import { createParticleTypeResolver, particleGenericGroup } from "./resolve";
import { particleTypeLabel, particleTypesAreAssignable } from "./types";

export type ParticleDiagnosticSeverity = "error" | "warning";

export interface ParticleGraphDiagnostic {
  /** `particle.*`; render adds `particle.compile.*` for Babylon build throws. */
  code: string;
  message: string;
  severity: ParticleDiagnosticSeverity;
  nodeId?: string;
  pinId?: string;
  edgeId?: string;
}

export interface ParticleGraphValidationContext {
  /**
   * Material domain by asset guid (`"particle"` for particle Materials); null
   * when the Material is not in the project. Omitted: only an unset Material
   * is reported.
   */
  materialDomain?: (guid: string) => string | null;
}

interface GraphLike {
  nodes: readonly ParticleGraphNode[];
  edges: readonly ParticleGraphEdge[];
}

/** Depth-first cycle search over all edges. */
export function findParticleGraphCycle(graph: GraphLike): string[] | null {
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

/**
 * Node ids on the Particle spine, Create → … → Emitter Output (the update
 * queue order). Walks the first Emitter Output's Particle input back; a
 * broken spine returns the part that still reaches the output.
 */
export function particleSpine(graph: GraphLike): string[] {
  const output = graph.nodes.find((node) => node.type === PARTICLE_OUTPUT_NODE_TYPE);
  if (!output) return [];
  const ids = new Set(graph.nodes.map((node) => node.id));
  const chain = [output.id];
  let current = output.id;
  for (;;) {
    const edge = graph.edges.find(
      (candidate) => candidate.targetNodeId === current && candidate.targetPinId === "particle",
    );
    if (!edge || !ids.has(edge.sourceNodeId) || chain.includes(edge.sourceNodeId)) break;
    chain.push(edge.sourceNodeId);
    current = edge.sourceNodeId;
  }
  return chain.reverse();
}

/** Shapes that emit radially unless both direction pins are set. */
const RADIAL_SHAPES = new Set(["shape.sphere", "shape.cone", "shape.cylinder"]);
/** Update closures that move particles; without one nothing moves. */
const MOTION_UPDATES = new Set(["update.position", "update.basicPosition"]);

function pinById(
  pins: readonly ParticlePinDefinition[],
  id: string,
): ParticlePinDefinition | undefined {
  return pins.find((pin) => pin.id === id);
}

/**
 * The first ancestor (including `startNodeId`) that must not feed a value
 * read outside a particle evaluation: a particle attribute, a Per Particle
 * Random, or a vector system source.
 */
function particleContextHazard(
  graph: GraphLike,
  definitions: ReadonlyMap<string, ParticleNodeDefinition>,
  startNodeId: string,
  includeSystemVectors: boolean,
): { nodeId: string; title: string; kind: "particle" | "system" } | null {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  const stack = [startNodeId];
  while (stack.length > 0) {
    const nodeId = stack.pop()!;
    if (seen.has(nodeId)) continue;
    seen.add(nodeId);
    const node = nodesById.get(nodeId);
    const definition = definitions.get(nodeId);
    if (node && definition) {
      if (definition.perParticleSource) return { nodeId, title: definition.title, kind: "particle" };
      if (node.type === "random.range" && node.properties.lock !== "everyRead") {
        return { nodeId, title: definition.title, kind: "particle" };
      }
      if (includeSystemVectors && definition.systemVectorSource) {
        return { nodeId, title: definition.title, kind: "system" };
      }
    }
    for (const edge of graph.edges) {
      if (edge.targetNodeId === nodeId) stack.push(edge.sourceNodeId);
    }
  }
  return null;
}

/** Wired, or (for value pins) given an authored default. A Particle pin needs a wire. */
function isPinSet(
  graph: GraphLike,
  node: ParticleGraphNode,
  pinId: string,
  particle = false,
): boolean {
  return (
    graph.edges.some((edge) => edge.targetNodeId === node.id && edge.targetPinId === pinId) ||
    (!particle && readParticlePinDefault(node.properties, pinId) !== undefined)
  );
}

function validateGraph(graph: GraphLike): {
  diagnostics: ParticleGraphDiagnostic[];
  definitions: Map<string, ParticleNodeDefinition>;
} {
  const diagnostics: ParticleGraphDiagnostic[] = [];
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const definitions = new Map<string, ParticleNodeDefinition>();

  for (const node of graph.nodes) {
    const definition = particleNodeDefinitionFor(node);
    if (definition) {
      definitions.set(node.id, definition);
      continue;
    }
    const feature = PARTICLE_UNSUPPORTED_V1_TYPES[node.type];
    diagnostics.push(
      feature
        ? {
            code: "particle.unsupportedNode",
            message: `"${feature}" is not available in Particle Graph v1`,
            severity: "error",
            nodeId: node.id,
          }
        : {
            code: "particle.unknownNode",
            message: `Node type "${node.type}" is not in the Particle Graph catalog`,
            severity: "error",
            nodeId: node.id,
          },
    );
  }

  for (const edge of graph.edges) {
    const source = nodesById.get(edge.sourceNodeId);
    const target = nodesById.get(edge.targetNodeId);
    if (!source || !target) {
      diagnostics.push({
        code: "particle.danglingEdge",
        message: "Connection points at a node that is no longer in the graph",
        severity: "error",
        edgeId: edge.id,
        ...(source ?? target ? { nodeId: (source ?? target)!.id } : {}),
      });
      continue;
    }
    const sourceDefinition = definitions.get(source.id);
    const targetDefinition = definitions.get(target.id);
    if (sourceDefinition && !pinById(sourceDefinition.outputs, edge.sourcePinId)) {
      diagnostics.push({
        code: "particle.unknownPin",
        message: `"${sourceDefinition.title}" has no output pin "${edge.sourcePinId}"`,
        severity: "error",
        edgeId: edge.id,
        nodeId: source.id,
        pinId: edge.sourcePinId,
      });
    }
    if (targetDefinition && !pinById(targetDefinition.inputs, edge.targetPinId)) {
      diagnostics.push({
        code: "particle.unknownPin",
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
      const title = definitions.get(edge.targetNodeId)?.title ?? edge.targetNodeId;
      diagnostics.push({
        code: "particle.duplicateConnection",
        message: `Input "${edge.targetPinId}" on "${title}" already has a connection`,
        severity: "error",
        edgeId: edge.id,
        nodeId: edge.targetNodeId,
        pinId: edge.targetPinId,
      });
    }
    seenTargets.add(key);
  }

  const cycle = findParticleGraphCycle(graph);
  if (cycle) {
    diagnostics.push({
      code: "particle.cycle",
      message: `Nodes form a loop: ${cycle.join(" → ")}`,
      severity: "error",
      nodeId: cycle[0],
    });
  } else {
    const resolver = createParticleTypeResolver(graph);
    for (const nodeId of resolver.conflicts()) {
      diagnostics.push({
        code: "particle.genericConflict",
        message: `"${definitions.get(nodeId)?.title ?? nodeId}" has inputs of different vector types; use Split and Combine to convert`,
        severity: "error",
        nodeId,
      });
    }
    for (const edge of graph.edges) {
      const sourceDefinition = definitions.get(edge.sourceNodeId);
      const targetDefinition = definitions.get(edge.targetNodeId);
      if (!sourceDefinition || !targetDefinition) continue;
      const targetPin = pinById(targetDefinition.inputs, edge.targetPinId);
      if (!targetPin || !pinById(sourceDefinition.outputs, edge.sourcePinId)) continue;
      const from = resolver.outputType(edge.sourceNodeId, edge.sourcePinId);
      const to = resolver.inputType(edge.targetNodeId, edge.targetPinId);
      if (!from) continue;
      const group = targetPin.type.kind === "generic" ? particleGenericGroup(targetDefinition) : null;
      // A generic group accepts Float (as a splat) and its listed types; conflicts are reported above.
      const ok = group
        ? from !== "particle" && (from === "float" || group.accepts.includes(from))
        : to === null || particleTypesAreAssignable(from, to);
      if (ok) continue;
      const targetLabel = group || !to ? `"${targetPin.name}"` : `${particleTypeLabel(to)} "${targetPin.name}"`;
      diagnostics.push({
        code: "particle.typeMismatch",
        message: `${particleTypeLabel(from)} from "${sourceDefinition.title}" cannot connect to ${targetLabel} on "${targetDefinition.title}"`,
        severity: "error",
        edgeId: edge.id,
        nodeId: edge.targetNodeId,
        pinId: edge.targetPinId,
      });
    }
  }

  for (const node of graph.nodes) {
    const definition = definitions.get(node.id);
    if (!definition) continue;
    for (const pin of definition.inputs) {
      if (!pin.required || isPinSet(graph, node, pin.id, pin.type.kind === "particle")) continue;
      diagnostics.push({
        code: "particle.missingInput",
        message: `"${definition.title}" needs a connection on "${pin.name}"`,
        severity: "error",
        nodeId: node.id,
        pinId: pin.id,
      });
    }
  }

  return { diagnostics, definitions };
}

function validateSpine(
  graph: GraphLike,
  definitions: ReadonlyMap<string, ParticleNodeDefinition>,
): ParticleGraphDiagnostic[] {
  const diagnostics: ParticleGraphDiagnostic[] = [];
  const outputs = graph.nodes.filter((node) => node.type === PARTICLE_OUTPUT_NODE_TYPE);
  if (outputs.length === 0) {
    diagnostics.push({
      code: "particle.noOutput",
      message: "Particle Graph needs an Emitter Output node",
      severity: "error",
    });
  }
  for (const extra of outputs.slice(1)) {
    diagnostics.push({
      code: "particle.multipleOutputs",
      message: "A Particle Graph can only have one Emitter Output",
      severity: "error",
      nodeId: extra.id,
    });
  }

  const usedParticleOutputs = new Set<string>();
  for (const edge of graph.edges) {
    const definition = definitions.get(edge.sourceNodeId);
    const pin = definition ? pinById(definition.outputs, edge.sourcePinId) : undefined;
    if (pin?.type.kind !== "particle") continue;
    const key = `${edge.sourceNodeId}:${edge.sourcePinId}`;
    if (usedParticleOutputs.has(key)) {
      diagnostics.push({
        code: "particle.spineFanOut",
        message: `"${definition!.title}" already feeds a node; a Particle output takes one connection, and a second branch never reaches Emitter Output`,
        severity: "error",
        edgeId: edge.id,
        nodeId: edge.sourceNodeId,
        pinId: edge.sourcePinId,
      });
    }
    usedParticleOutputs.add(key);
  }

  const output = outputs[0];
  if (!output) return diagnostics;
  const spine = particleSpine(graph);
  const onSpine = new Set(spine);

  const emitRate = graph.edges.find(
    (edge) => edge.targetNodeId === output.id && edge.targetPinId === "emitRate",
  );
  const hazard = emitRate
    ? particleContextHazard(graph, definitions, emitRate.sourceNodeId, true)
    : null;
  if (hazard) {
    diagnostics.push({
      code: "particle.perParticleInEmitRate",
      message:
        hazard.kind === "particle"
          ? `Emit Rate is read without a particle, so "${hazard.title}" gives no value and the emitter may never spawn`
          : `Emit Rate is first read before the emitter runs, so "${hazard.title}" gives no value and the build fails`,
      severity: "error",
      nodeId: output.id,
      pinId: "emitRate",
    });
  }

  let sawContextUpdate = false;
  const shapes: string[] = [];
  let moves = false;
  for (const nodeId of spine) {
    const node = graph.nodes.find((entry) => entry.id === nodeId)!;
    const definition = definitions.get(nodeId);
    if (!definition) continue;
    if (definition.role === "shape") shapes.push(nodeId);
    if (MOTION_UPDATES.has(node.type)) moves = true;
    if (definition.role !== "update") continue;
    if (node.type === "force.attractor" && !sawContextUpdate) {
      for (const pinId of ["position", "strength"]) {
        const edge = graph.edges.find(
          (entry) => entry.targetNodeId === nodeId && entry.targetPinId === pinId,
        );
        const found = edge ? particleContextHazard(graph, definitions, edge.sourceNodeId, false) : null;
        if (!found) continue;
        diagnostics.push({
          code: "particle.attractorParticleInput",
          message: `"${found.title}" reads the previous particle here: the Attractor runs first, before any update sets the particle. Place it after another update`,
          severity: "warning",
          nodeId,
          pinId,
        });
      }
    }
    sawContextUpdate = true;
  }
  for (const nodeId of shapes.slice(0, -1)) {
    diagnostics.push({
      code: "particle.multipleShapes",
      message: `"${definitions.get(nodeId)?.title}" is overridden by a later Shape on the spine`,
      severity: "warning",
      nodeId,
    });
  }
  const first = spine[0] ? definitions.get(spine[0]) : undefined;
  if (first?.role === "create" && !moves) {
    diagnostics.push({
      code: "particle.noMotion",
      message: "Particles never move: add Apply Velocity or Update Position to the spine",
      severity: "warning",
      nodeId: output.id,
    });
  }

  for (const node of graph.nodes) {
    const definition = definitions.get(node.id);
    if (!definition || definition.role === "output") continue;
    if (definition.role !== "create" && definition.role !== "shape" && definition.role !== "update") continue;
    if (onSpine.has(node.id)) continue;
    diagnostics.push({
      code: "particle.unreachable",
      message: `"${definition.title}" does not reach Emitter Output and has no effect`,
      severity: "warning",
      nodeId: node.id,
    });
  }

  for (const node of graph.nodes) {
    if (!RADIAL_SHAPES.has(node.type)) continue;
    const first = isPinSet(graph, node, "direction1");
    const second = isPinSet(graph, node, "direction2");
    if (first === second) continue;
    diagnostics.push({
      code: "particle.shapeDirectionPair",
      message: `"${definitions.get(node.id)?.title ?? node.type}" emits radially until both Direction 1 and Direction 2 are set`,
      severity: "warning",
      nodeId: node.id,
      pinId: first ? "direction2" : "direction1",
    });
  }
  return diagnostics;
}

function validateSettings(
  doc: ParticleGraphDocument,
  context: ParticleGraphValidationContext,
): ParticleGraphDiagnostic[] {
  const diagnostics: ParticleGraphDiagnostic[] = [];
  if (doc.settings.capacity > PARTICLE_CPU_CAPACITY_BUDGET) {
    diagnostics.push({
      code: "particle.cpuBudget",
      message: `Particle Graphs simulate on the CPU; a capacity above ${PARTICLE_CPU_CAPACITY_BUDGET} costs more on iPad`,
      severity: "warning",
    });
  }
  const guid = doc.materialGuid;
  const domain = guid && context.materialDomain ? context.materialDomain(guid) : undefined;
  if (!guid || domain === null) {
    diagnostics.push({
      code: "particle.missingMaterial",
      message: guid
        ? `Material "${guid}" is not in this project; the emitter will not render`
        : "Pick a particle Material; the emitter will not render without one",
      severity: "warning",
    });
  } else if (domain !== undefined && domain !== "particle") {
    diagnostics.push({
      code: "particle.materialDomain",
      message: "The Material is not a particle Material; the emitter will not render",
      severity: "warning",
    });
  }
  return diagnostics;
}

/** Errors block lowering; warnings do not. */
export function validateParticleGraphDocument(
  doc: ParticleGraphDocument,
  context: ParticleGraphValidationContext = {},
): ParticleGraphDiagnostic[] {
  const { diagnostics, definitions } = validateGraph(doc);
  diagnostics.push(...validateSpine(doc, definitions));
  diagnostics.push(...validateSettings(doc, context));
  return diagnostics;
}
