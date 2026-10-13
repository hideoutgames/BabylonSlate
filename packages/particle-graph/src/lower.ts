import {
  PARTICLE_OUTPUT_NODE_TYPE,
  isParticleSpineRole,
  particleNodeValueType,
  type ParticlePinDefinition,
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
import {
  particleConversionFor,
  resizeParticleValue,
  type ParticleConversion,
  type ParticleNumericType,
  type ParticleValueType,
} from "./types";
import {
  checkParticleGraphDocument,
  indexParticleIncomingEdges,
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
  /**
   * The graph node id: the anchor for build diagnostics and focus. A bound on a
   * wired `clampWired` pin is its own Maximum / Minimum / Clamp operation, with
   * the id `<node id>/<pin id>`.
   */
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
  hash: string;
}

export type ParticleGraphLowerResult =
  | { ok: true; plan: ParticleBuildPlan; diagnostics: ParticleGraphDiagnostic[] }
  | { ok: false; diagnostics: ParticleGraphDiagnostic[] };

export type ParticleGraphLowerContext = ParticleGraphValidationContext;

/**
 * Routes a wired value into a `clampWired` pin (Lifetime) through Maximum,
 * Minimum or Clamp against the pin's range, so the bound is part of the plan
 * and a wired 0 never reaches Babylon's `1 / lifeTime`.
 */
function boundedOperation(
  node: ParticleGraphNode,
  pin: ParticlePinDefinition,
  type: ParticleNumericType,
  value: ParticleOperand,
): ParticleOperation | null {
  const bound = (limit: number): ParticleOperand => ({ kind: "constant", type: "float", value: [limit] });
  const operation = (nodeType: string, inputs: Record<string, ParticleOperand>): ParticleOperation =>
    ({ id: `${node.id}/${pin.id}`, nodeType, resolvedType: type, inputs, properties: {} });
  const { min, max } = pin;
  if (min !== undefined && max !== undefined) {
    return operation("math.clamp", { value, min: bound(min), max: bound(max) });
  }
  if (min !== undefined) return operation("math.max", { a: value, b: bound(min) });
  if (max !== undefined) return operation("math.min", { a: value, b: bound(max) });
  return null;
}

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
  const { diagnostics, resolver } = checkParticleGraphDocument(doc, context);
  if (!resolver || diagnostics.some((entry) => entry.severity === "error")) {
    return { ok: false, diagnostics };
  }
  const nodesById = new Map(doc.nodes.map((node) => [node.id, node]));
  const incoming = indexParticleIncomingEdges(doc);
  const operations: ParticleOperation[] = [];
  const emitted = new Map<string, ParticleOperation>();

  const emit = (node: ParticleGraphNode): ParticleOperation => {
    const existing = emitted.get(node.id);
    if (existing) return existing;
    const definition = resolver.definitionOf(node.id)!;
    const inputs: Record<string, ParticleOperand> = {};
    for (const pin of definition.inputs) {
      const edge = incoming(node.id, pin.id);
      const source = edge ? nodesById.get(edge.sourceNodeId) : undefined;
      if (edge && source) {
        emit(source);
        const from = resolver.outputType(source.id, edge.sourcePinId);
        const to = resolver.inputType(node.id, pin.id);
        const conversion = from && to ? particleConversionFor(from, to) : null;
        const wired: ParticleOperand = {
          kind: "operation",
          operationId: source.id,
          pinId: edge.sourcePinId,
          ...(conversion ? { conversion } : {}),
        };
        const bounded =
          pin.clampWired && to && to !== "particle"
            ? boundedOperation(node, pin, to, wired)
            : null;
        if (bounded) operations.push(bounded);
        inputs[pin.id] = bounded
          ? { kind: "operation", operationId: bounded.id, pinId: "out" }
          : wired;
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
      hash: hashParticlePlan(doc.settings, operations),
    },
  };
}

const NO_CONTEXT: ParticleGraphLowerContext = {};
const lowerings = new WeakMap<
  ParticleGraphDocument,
  WeakMap<ParticleGraphLowerContext, ParticleGraphLowerResult>
>();

/**
 * `lowerParticleGraphDocument` remembered per document object and context, for the
 * editor, the preview and the service that all lower the same document on each edit.
 * Documents are replaced, never edited in place, and callers must not change the result.
 */
export function lowerParticleGraphDocumentCached(
  doc: ParticleGraphDocument,
  context: ParticleGraphLowerContext = NO_CONTEXT,
): ParticleGraphLowerResult {
  let byContext = lowerings.get(doc);
  if (!byContext) lowerings.set(doc, (byContext = new WeakMap()));
  let result = byContext.get(context);
  if (!result) byContext.set(context, (result = lowerParticleGraphDocument(doc, context)));
  return result;
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
  const result = lowerParticleGraphDocumentCached(doc, context);
  if (result.ok) return result.plan.hash;
  return `invalid:${fnv1a(
    JSON.stringify({
      settings: particleSettingsFingerprint(doc.settings),
      nodes: doc.nodes.map((node) => ({ id: node.id, type: node.type, properties: node.properties })),
      edges: doc.edges,
    }),
  )}`;
}
