import { PARTICLE_PARAMETER_NODE_TYPE } from "./catalog";
import {
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

/** `base`, else `base 2`, `base 3`…: the first name no parameter holds. */
export function uniqueParticleParameterName(
  parameters: readonly ParticleGraphParameter[],
  base = "Parameter",
): string {
  const taken = new Set(parameters.map((parameter) => parameter.name));
  if (!taken.has(base)) return base;
  for (let index = 2; ; index += 1) {
    const name = `${base} ${index}`;
    if (!taken.has(name)) return name;
  }
}

/**
 * Name, type and default of a Parameter node's parameter as the canvas carries them, so a
 * node pasted where its parameter is not declared (after a cut, or into another graph)
 * brings it back.
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
 * Parameters live while a Parameter node reads them. After an edit from `previous` to
 * `next`:
 * - a Parameter node without a parameter (an Add Node type entry) gets a new one of its type;
 * - a node whose parameter is not declared but whose `snapshots` entry (by node id) names one
 *   reads the declared parameter of that name and type, else declares it again;
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
  const nodes = next.nodes.map((node) => {
    if (node.type !== PARTICLE_PARAMETER_NODE_TYPE) return node;
    const parameterId = parameterIdOf(node);
    let parameter: ParticleGraphParameter | undefined;
    if (!parameterId) {
      const type = nodeValueType(node);
      parameter = {
        id: options.newId(),
        name: uniqueParticleParameterName(parameters),
        type,
        defaultValue: particleParameterStartValue(type),
      };
      parameters.push(parameter);
    } else if (!parameters.some((entry) => entry.id === parameterId)) {
      const snapshot = options.snapshots?.get(node.id);
      if (!snapshot) return node;
      parameter = parameters.find(
        (entry) => entry.name === snapshot.name && entry.type === snapshot.type,
      );
      if (!parameter) {
        parameter = {
          id: parameterId,
          name: uniqueParticleParameterName(parameters, snapshot.name),
          type: snapshot.type,
          defaultValue: [...snapshot.defaultValue],
        };
        parameters.push(parameter);
      }
    } else {
      return node;
    }
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
 * Replace one parameter (matched by id) and retype the Parameter nodes that read it.
 * `defaultValue` is resized to `type`.
 */
export function withParticleParameter(
  doc: ParticleGraphDocument,
  parameter: ParticleGraphParameter,
): ParticleGraphDocument {
  const fitted = { ...parameter, defaultValue: resizeParticleValue(parameter.defaultValue, parameter.type) };
  return withNodes(
    doc,
    doc.parameters.map((entry) => (entry.id === parameter.id ? fitted : entry)),
    doc.nodes,
  );
}

/**
 * Point a Parameter node at another declared parameter; the old one is dropped once no node
 * reads it. Null when the node is not a Parameter node or `parameterId` is not declared.
 */
export function bindParticleParameterNode(
  doc: ParticleGraphDocument,
  nodeId: string,
  parameterId: string,
): ParticleGraphDocument | null {
  const parameter = doc.parameters.find((entry) => entry.id === parameterId);
  const node = doc.nodes.find((entry) => entry.id === nodeId);
  if (!parameter || node?.type !== PARTICLE_PARAMETER_NODE_TYPE) return null;
  const nodes = doc.nodes.map((entry) =>
    entry.id === nodeId
      ? { ...entry, properties: { ...entry.properties, parameterId, valueType: parameter.type } }
      : entry,
  );
  return withNodes(doc, withoutUnread(doc, doc.parameters, nodes), nodes);
}
