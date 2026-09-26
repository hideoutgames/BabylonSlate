import {
  PARTICLE_OUTPUT_NODE_TYPE,
  isParticleSpineRole,
  particleNodeDefinition,
  particleNodeValueType,
} from "./catalog";
import type {
  ParticleGraphDocument,
  ParticleGraphNode,
  ParticleGraphSettings,
} from "./document";
import {
  canonicalParticleGradientStops,
  particleGradientStops,
} from "./gradient";
import { fnv1a, hashParticlePlan, particleSettingsFingerprint } from "./hash";
import { clampParticlePinValue, resolveParticlePinDefault } from "./pin-defaults";
import { createParticleTypeResolver } from "./resolve";
import {
  particleConversionFor,
  resizeParticleValue,
  type ParticleConversion,
  type ParticleNumericType,
  type ParticleValueType,
} from "./types";
import {
  particleSpine,
  validateParticleGraphDocument,
  type ParticleGraphDiagnostic,
  type ParticleGraphValidationContext,
} from "./validate";

export type ParticleOperand =
  | {
      kind: "operation";
      operationId: string;
      pinId: string;
      /** Float wired into a vector or color input; render realizes the splat. */
      conversion?: ParticleConversion;
    }
  | {
      kind: "constant";
      type: ParticleNumericType;
      /** Already sized to `type` and clamped to the pin range. */
      value: number[];
    };

export interface ParticleOperation {
  /** The graph node id: the anchor for build diagnostics and focus. */
  id: string;
  nodeType: string;
  /** Generic or `valueType` result; `"particle"` on the spine; null on Emitter Output. */
  resolvedType: ParticleValueType | null;
  /** Only pins that are wired or have a default; unset pins stay unconnected in Babylon. */
  inputs: Record<string, ParticleOperand>;
  /** Normalized properties without `default:*` keys; Gradient stops are canonical. */
  properties: Record<string, unknown>;
}

export interface ParticleBuildPlan {
  settings: ParticleGraphSettings;
  /** Topological: every operand references an earlier operation. Emitter Output is last. */
  operations: ParticleOperation[];
  /** Operation ids Create → … → Emitter Output, which is the update-queue order. */
  spine: string[];
  /** Not part of the hash: a Material change rebinds without rebuilding. */
  materialGuid: string | null;
  dependencies: { materials: string[] };
  cost: {
    operations: number;
    /** Distinct value operations feeding update inputs (evaluated per particle per frame). */
    perParticleUpdateOperations: number;
  };
  hash: string;
}

export type ParticleGraphLowerResult =
  | { ok: true; plan: ParticleBuildPlan; diagnostics: ParticleGraphDiagnostic[] }
  | { ok: false; diagnostics: ParticleGraphDiagnostic[] };

export type ParticleGraphLowerContext = ParticleGraphValidationContext;

function planProperties(node: ParticleGraphNode): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node.properties)) {
    if (!key.startsWith("default:")) properties[key] = value;
  }
  if (node.type === "gradient.sample") {
    const valueType = particleNodeValueType(node.type, node.properties) ?? "color";
    properties.stops = canonicalParticleGradientStops(
      particleGradientStops(node.properties.stops, valueType),
    );
  }
  return properties;
}

/**
 * Lower a Particle Graph into a Babylon-free build plan: a post-order walk from
 * Emitter Output over inputs in catalog pin order, so the order never depends
 * on the node array and stray nodes never enter the plan.
 */
export function lowerParticleGraphDocument(
  doc: ParticleGraphDocument,
  context: ParticleGraphLowerContext = {},
): ParticleGraphLowerResult {
  const diagnostics = validateParticleGraphDocument(doc, context);
  if (diagnostics.some((entry) => entry.severity === "error")) {
    return { ok: false, diagnostics };
  }
  const resolver = createParticleTypeResolver(doc);
  const nodesById = new Map(doc.nodes.map((node) => [node.id, node]));
  const operations: ParticleOperation[] = [];
  const emitted = new Map<string, ParticleOperation>();

  const emit = (node: ParticleGraphNode): ParticleOperation => {
    const existing = emitted.get(node.id);
    if (existing) return existing;
    const definition = resolver.definitionOf(node.id)!;
    const inputs: Record<string, ParticleOperand> = {};
    for (const pin of definition.inputs) {
      const edge = doc.edges.find(
        (candidate) => candidate.targetNodeId === node.id && candidate.targetPinId === pin.id,
      );
      const source = edge ? nodesById.get(edge.sourceNodeId) : undefined;
      if (edge && source) {
        emit(source);
        const from = resolver.outputType(source.id, edge.sourcePinId);
        const to = resolver.inputType(node.id, pin.id);
        const conversion = from && to ? particleConversionFor(from, to) : null;
        inputs[pin.id] = {
          kind: "operation",
          operationId: source.id,
          pinId: edge.sourcePinId,
          ...(conversion ? { conversion } : {}),
        };
        continue;
      }
      const value = pin.type.kind === "particle" ? undefined : resolveParticlePinDefault(node, pin);
      if (!value) continue;
      const resolved = resolver.inputType(node.id, pin.id);
      const type: ParticleNumericType = resolved && resolved !== "particle" ? resolved : "float";
      inputs[pin.id] = {
        kind: "constant",
        type,
        value: clampParticlePinValue(resizeParticleValue(value, type), pin),
      };
    }
    const generic = resolver.genericOf(node.id);
    const resolvedType: ParticleValueType | null = definition.terminal
      ? null
      : isParticleSpineRole(definition.role)
        ? "particle"
        : generic && generic !== "conflict"
          ? generic
          : (particleNodeValueType(node.type, node.properties) ??
            (definition.outputs[0]?.type.kind === "generic"
              ? "float"
              : ((definition.outputs[0]?.type.kind as ParticleValueType | undefined) ?? null)));
    const operation: ParticleOperation = {
      id: node.id,
      nodeType: node.type,
      resolvedType,
      inputs,
      properties: planProperties(node),
    };
    emitted.set(node.id, operation);
    operations.push(operation);
    return operation;
  };

  const output = doc.nodes.find((node) => node.type === PARTICLE_OUTPUT_NODE_TYPE)!;
  emit(output);

  return {
    ok: true,
    diagnostics,
    plan: {
      settings: { ...doc.settings },
      operations,
      spine: particleSpine(doc),
      materialGuid: doc.materialGuid,
      dependencies: { materials: doc.materialGuid ? [doc.materialGuid] : [] },
      cost: {
        operations: operations.length,
        perParticleUpdateOperations: perParticleUpdateOperations(operations, emitted),
      },
      hash: hashParticlePlan(doc.settings, operations),
    },
  };
}

function perParticleUpdateOperations(
  operations: readonly ParticleOperation[],
  byId: ReadonlyMap<string, ParticleOperation>,
): number {
  const counted = new Set<string>();
  const visit = (operationId: string) => {
    const operation = byId.get(operationId);
    if (!operation || operation.resolvedType === "particle" || counted.has(operationId)) return;
    counted.add(operationId);
    for (const operand of Object.values(operation.inputs)) {
      if (operand.kind === "operation") visit(operand.operationId);
    }
  };
  for (const operation of operations) {
    if (particleNodeDefinition(operation.nodeType)?.role !== "update") continue;
    for (const operand of Object.values(operation.inputs)) {
      if (operand.kind === "operation") visit(operand.operationId);
    }
  }
  return counted.size;
}

/**
 * Preview and slot rebuild key. Node positions, the name and the Material are
 * excluded, so dragging a node never rebuilds; an invalid graph still gets a
 * stable key.
 */
export function particleGraphCompileKey(
  doc: ParticleGraphDocument,
  context?: ParticleGraphLowerContext,
): string {
  const result = lowerParticleGraphDocument(doc, context);
  if (result.ok) return result.plan.hash;
  return `invalid:${fnv1a(
    JSON.stringify({
      settings: particleSettingsFingerprint(doc.settings),
      nodes: doc.nodes.map((node) => ({ id: node.id, type: node.type, properties: node.properties })),
      edges: doc.edges,
    }),
  )}`;
}
