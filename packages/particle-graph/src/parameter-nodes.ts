import { PARTICLE_PARAMETER_NODE_TYPE } from "./catalog";
import {
  PARTICLE_PARAMETER_NAME_MAX,
  newParticleNodeProperties,
  normalizeParticleParameterName,
  syncParameterNodeTypes,
  type ParticleGraphDocument,
  type ParticleGraphNode,
  type ParticleGraphParameter,
} from "./document";
import { isParticleNumericType, resizeParticleValue, type ParticleNumericType } from "./types";

/** The Constant node type of each value type. */
export const PARTICLE_CONSTANT_NODE_TYPES: Readonly<Record<ParticleNumericType, string>> = {
  float: "const.float",
  vec2: "const.vec2",
  vec3: "const.vec3",
  color: "const.color",
};

/** A Constant node type's value type, or null for every other node type. */
export function particleConstantValueType(type: string): ParticleNumericType | null {
  for (const [valueType, constantType] of Object.entries(PARTICLE_CONSTANT_NODE_TYPES)) {
    if (constantType === type) return valueType as ParticleNumericType;
  }
  return null;
}

/** The starting value of a new parameter of `type`: the Constant node's starting value. */
export function particleParameterStartValue(type: ParticleNumericType): number[] {
  return [...(newParticleNodeProperties(PARTICLE_CONSTANT_NODE_TYPES[type]).value as number[])];
}

/**
 * `name` when no other parameter holds it, else its stem (a trailing `_N` removed) with the
 * first free `_1`, `_2`…, shortened so it stays within `PARTICLE_PARAMETER_NAME_MAX`.
 * `exceptId` is the parameter being renamed, whose own name does not count as taken.
 */
export function uniqueParticleParameterName(
  parameters: readonly ParticleGraphParameter[],
  name = "Parameter",
  exceptId?: string,
): string {
  const taken = new Set(
    parameters.filter((parameter) => parameter.id !== exceptId).map((parameter) => parameter.name),
  );
  if (!taken.has(name)) return name;
  const stem = name.replace(/_\d+$/, "") || name;
  for (let index = 1; ; index += 1) {
    const suffix = `_${index}`;
    const candidate = `${stem.slice(0, PARTICLE_PARAMETER_NAME_MAX - suffix.length).trimEnd()}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Name, type and default of a Parameter node's parameter as the canvas carries them, so a
 * pasted node brings its parameter: declared again where it is missing (after a cut, or in
 * another graph), copied where another node already reads it.
 */
export interface ParticleParameterSnapshot {
  name: string;
  type: ParticleNumericType;
  defaultValue: number[];
}

/** A snapshot read from canvas node data, or null when it is malformed. */
export function particleParameterSnapshot(value: unknown): ParticleParameterSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const name = normalizeParticleParameterName(record.name);
  const type = typeof record.type === "string" && isParticleNumericType(record.type) ? record.type : null;
  if (!name || !type) return null;
  const defaultValue = Array.isArray(record.defaultValue) ? record.defaultValue : [];
  return { name, type, defaultValue: resizeParticleValue(defaultValue, type) };
}

function parameterIdOf(node: ParticleGraphNode): string {
  return typeof node.properties.parameterId === "string" ? node.properties.parameterId : "";
}

function readParameterIds(nodes: readonly ParticleGraphNode[]): Set<string> {
  return new Set(
    nodes.filter((node) => node.type === PARTICLE_PARAMETER_NODE_TYPE).map(parameterIdOf),
  );
}

function nodeValueType(node: ParticleGraphNode): ParticleNumericType {
  const type = node.properties.valueType;
  return typeof type === "string" && isParticleNumericType(type) ? type : "float";
}

function withNodes(
  doc: ParticleGraphDocument,
  parameters: ParticleGraphParameter[],
  nodes: ParticleGraphNode[],
): ParticleGraphDocument {
  return { ...doc, parameters, nodes: syncParameterNodeTypes(nodes, parameters) };
}

/**
 * One Parameter node per parameter, and parameters live while their node does. After an
 * edit from `previous` to `next`:
 * - a Parameter node without a parameter (an Add Node type entry) gets a new one of its type;
 * - a node reading a parameter another node already reads (a copy, a duplicate or a paste)
 *   gets a new parameter copied from its `snapshots` entry, else from that parameter, under a
 *   free name. The node that read it before the edit keeps it, else the first in order;
 * - a node whose parameter is not declared but has a snapshot declares it again under its id
 *   and a free name; without one it stays in error;
 * - each parameter `previous` read that no node reads any more is dropped.
 * Parameters `previous` declared without a reader stay.
 */
export function reconcileParticleParameters(
  previous: ParticleGraphDocument,
  next: ParticleGraphDocument,
  options: {
    newId: () => string;
    snapshots?: ReadonlyMap<string, ParticleParameterSnapshot>;
  },
): ParticleGraphDocument {
  const parameters = [...next.parameters];
  const declared = (id: string) => parameters.find((parameter) => parameter.id === id);
  const earlier = new Set(previous.nodes.map((node) => node.id));
  const owners = new Map<string, string>();
  for (const node of [
    ...next.nodes.filter((entry) => earlier.has(entry.id)),
    ...next.nodes.filter((entry) => !earlier.has(entry.id)),
  ]) {
    const parameterId = node.type === PARTICLE_PARAMETER_NODE_TYPE ? parameterIdOf(node) : "";
    if (parameterId && declared(parameterId) && !owners.has(parameterId)) owners.set(parameterId, node.id);
  }
  const declare = (id: string, source: ParticleParameterSnapshot): ParticleGraphParameter => {
    const parameter = {
      id,
      name: uniqueParticleParameterName(parameters, source.name),
      type: source.type,
      defaultValue: resizeParticleValue(source.defaultValue, source.type),
    };
    parameters.push(parameter);
    return parameter;
  };
  const nodes = next.nodes.map((node) => {
    if (node.type !== PARTICLE_PARAMETER_NODE_TYPE) return node;
    const parameterId = parameterIdOf(node);
    const existing = parameterId ? declared(parameterId) : undefined;
    const snapshot = options.snapshots?.get(node.id);
    let parameter: ParticleGraphParameter;
    if (!parameterId) {
      const type = nodeValueType(node);
      parameter = declare(options.newId(), { name: "Parameter", type, defaultValue: particleParameterStartValue(type) });
    } else if (existing) {
      if (owners.get(parameterId) === node.id) return node;
      parameter = declare(options.newId(), snapshot ?? existing);
    } else if (snapshot) {
      parameter = declare(parameterId, snapshot);
    } else {
      return node;
    }
    owners.set(parameter.id, node.id);
    return {
      ...node,
      properties: { ...node.properties, parameterId: parameter.id, valueType: parameter.type },
    };
  });
  return withNodes(next, withoutUnread(previous, parameters, nodes), nodes);
}

/** `parameters` without those `previous` read and `nodes` no longer read. */
function withoutUnread(
  previous: ParticleGraphDocument,
  parameters: readonly ParticleGraphParameter[],
  nodes: readonly ParticleGraphNode[],
): ParticleGraphParameter[] {
  const before = readParameterIds(previous.nodes);
  const after = readParameterIds(nodes);
  return parameters.filter((parameter) => !before.has(parameter.id) || after.has(parameter.id));
}

/**
 * **Convert to Parameter**: the Constant node becomes a Parameter node of a new parameter
 * that holds its value. Its id, position and wires stay. Null for any other node.
 */
export function convertParticleConstantToParameter(
  doc: ParticleGraphDocument,
  nodeId: string,
  newId: () => string,
): ParticleGraphDocument | null {
  const node = doc.nodes.find((entry) => entry.id === nodeId);
  const type = node ? particleConstantValueType(node.type) : null;
  if (!node || !type) return null;
  const value = Array.isArray(node.properties.value) ? node.properties.value : [];
  const parameter: ParticleGraphParameter = {
    id: newId(),
    name: uniqueParticleParameterName(doc.parameters),
    type,
    defaultValue: resizeParticleValue(value, type),
  };
  return withNodes(
    doc,
    [...doc.parameters, parameter],
    doc.nodes.map((entry) =>
      entry.id === nodeId
        ? {
            ...entry,
            type: PARTICLE_PARAMETER_NODE_TYPE,
            properties: { parameterId: parameter.id, valueType: type },
          }
        : entry,
    ),
  );
}

/**
 * **Convert to Constant**: the Parameter node becomes a Constant node holding its
 * parameter's default (the type's starting value when the parameter is gone). Its id,
 * position and wires stay; the parameter is dropped once no node reads it. Null for any
 * other node.
 */
export function convertParticleParameterToConstant(
  doc: ParticleGraphDocument,
  nodeId: string,
): ParticleGraphDocument | null {
  const node = doc.nodes.find((entry) => entry.id === nodeId);
  if (!node || node.type !== PARTICLE_PARAMETER_NODE_TYPE) return null;
  const parameter = doc.parameters.find((entry) => entry.id === parameterIdOf(node));
  const type = parameter?.type ?? nodeValueType(node);
  const value = parameter
    ? resizeParticleValue(parameter.defaultValue, type)
    : particleParameterStartValue(type);
  const nodes = doc.nodes.map((entry) =>
    entry.id === nodeId
      ? { ...entry, type: PARTICLE_CONSTANT_NODE_TYPES[type], properties: { value } }
      : entry,
  );
  return withNodes(doc, withoutUnread(doc, doc.parameters, nodes), nodes);
}

/**
 * Replace one parameter (matched by id) and retype its Parameter node. A name another
 * parameter holds gets a `_N` suffix; `defaultValue` is resized to `type`.
 */
export function withParticleParameter(
  doc: ParticleGraphDocument,
  parameter: ParticleGraphParameter,
): ParticleGraphDocument {
  const fitted = {
    ...parameter,
    name: uniqueParticleParameterName(doc.parameters, parameter.name, parameter.id),
    defaultValue: resizeParticleValue(parameter.defaultValue, parameter.type),
  };
  return withNodes(
    doc,
    doc.parameters.map((entry) => (entry.id === parameter.id ? fitted : entry)),
    doc.nodes,
  );
}
