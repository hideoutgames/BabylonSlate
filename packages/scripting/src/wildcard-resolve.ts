import { isAssignable, pinTypeEquals, type PinType } from "./types";

export type WildcardPin = { id: string; type: PinType };
export type WildcardNode = { id: string; pins: WildcardPin[] };
export type WildcardEdge = {
  sourceNodeId: string;
  sourcePinId: string;
  targetNodeId: string;
  targetPinId: string;
};
export type WildcardGraph = {
  nodes: WildcardNode[];
  edges: WildcardEdge[];
};

export type WildcardConflict = {
  nodeId: string;
  pinId: string;
  relatedNodeId?: string;
  relatedPinId?: string;
  message: string;
};

export type WildcardResolveResult = {
  resolved: Map<string, PinType>;
  display: Map<string, PinType>;
  conflicts: WildcardConflict[];
};

export function pinTypeKey(nodeId: string, pinId: string): string {
  return `${nodeId}\0${pinId}`;
}

function varKey(nodeId: string, group: string): string {
  return `${nodeId}\0${group}`;
}

function isResolving(
  type: PinType,
): type is Extract<PinType, { kind: "resolvingWildcard" }> {
  return type.kind === "resolvingWildcard";
}

function isBoxed(type: PinType): boolean {
  return type.kind === "boxedWildcard";
}

function groupOf(type: PinType): string {
  return isResolving(type) ? (type.group ?? "T") : "T";
}

function substitute(
  type: PinType,
  nodeId: string,
  subst: Map<string, PinType>,
  conflicted: Set<string>,
): PinType {
  if (isResolving(type)) {
    const key = varKey(nodeId, groupOf(type));
    if (conflicted.has(key)) return type;
    return subst.get(key) ?? type;
  }
  if (type.kind === "array") {
    return {
      kind: "array",
      element: substitute(type.element, nodeId, subst, conflicted),
    };
  }
  if (type.kind === "map") {
    return {
      kind: "map",
      key: substitute(type.key, nodeId, subst, conflicted),
      value: substitute(type.value, nodeId, subst, conflicted),
    };
  }
  if (type.kind === "delegate") {
    return {
      kind: "delegate",
      inputs: type.inputs.map((entry) =>
        substitute(entry, nodeId, subst, conflicted),
      ),
      outputs: type.outputs.map((entry) =>
        substitute(entry, nodeId, subst, conflicted),
      ),
    };
  }
  return type;
}

function bind(
  nodeId: string,
  group: string,
  type: PinType,
  subst: Map<string, PinType>,
  conflicted: Set<string>,
  conflicts: WildcardConflict[],
  via: { pinId: string; relatedNodeId?: string; relatedPinId?: string },
  hard: boolean,
): boolean {
  if (isResolving(type) || isBoxed(type)) return false;
  const key = varKey(nodeId, group);
  if (conflicted.has(key)) return false;
  const existing = subst.get(key);
  if (!existing) {
    subst.set(key, type);
    return true;
  }
  if (pinTypeEquals(existing, type)) return false;
  if (isAssignable(type, existing)) return false;
  if (!hard) return false;
  subst.delete(key);
  conflicted.add(key);
  conflicts.push({
    nodeId,
    pinId: via.pinId,
    relatedNodeId: via.relatedNodeId,
    relatedPinId: via.relatedPinId,
    message: `Incompatible wildcard resolution: ${existing.kind} vs ${type.kind}`,
  });
  return true;
}

function bindFromTemplate(
  template: PinType,
  templateNode: string,
  observed: PinType,
  subst: Map<string, PinType>,
  conflicted: Set<string>,
  conflicts: WildcardConflict[],
  via: { pinId: string; relatedNodeId?: string; relatedPinId?: string },
  hard: boolean,
): boolean {
  if (isResolving(template)) {
    if (isResolving(observed) || isBoxed(observed)) return false;
    return bind(
      templateNode,
      groupOf(template),
      observed,
      subst,
      conflicted,
      conflicts,
      via,
      hard,
    );
  }
  if (isBoxed(template) || isBoxed(observed)) return false;
  if (template.kind === "array" && observed.kind === "array") {
    return bindFromTemplate(
      template.element,
      templateNode,
      observed.element,
      subst,
      conflicted,
      conflicts,
      via,
      hard,
    );
  }
  if (template.kind === "map" && observed.kind === "map") {
    const keyChanged = bindFromTemplate(
      template.key,
      templateNode,
      observed.key,
      subst,
      conflicted,
      conflicts,
      via,
      hard,
    );
    const valueChanged = bindFromTemplate(
      template.value,
      templateNode,
      observed.value,
      subst,
      conflicted,
      conflicts,
      via,
      hard,
    );
    return keyChanged || valueChanged;
  }
  if (template.kind === "delegate" && observed.kind === "delegate") {
    const nIn = Math.min(template.inputs.length, observed.inputs.length);
    const nOut = Math.min(template.outputs.length, observed.outputs.length);
    let changed = false;
    for (let i = 0; i < nIn; i++) {
      changed =
        bindFromTemplate(
          template.inputs[i]!,
          templateNode,
          observed.inputs[i]!,
          subst,
          conflicted,
          conflicts,
          via,
          hard,
        ) || changed;
    }
    for (let i = 0; i < nOut; i++) {
      changed =
        bindFromTemplate(
          template.outputs[i]!,
          templateNode,
          observed.outputs[i]!,
          subst,
          conflicted,
          conflicts,
          via,
          hard,
        ) || changed;
    }
    return changed;
  }
  return false;
}

function findPin(
  nodes: Map<string, Map<string, PinType>>,
  nodeId: string,
  pinId: string,
): PinType | undefined {
  return nodes.get(nodeId)?.get(pinId);
}

export function resolveWildcardPinTypes(
  graph: WildcardGraph,
): WildcardResolveResult {
  const pinTypes = new Map<string, Map<string, PinType>>();
  for (const node of graph.nodes) {
    const pins = new Map<string, PinType>();
    for (const pin of node.pins) {
      pins.set(pin.id, pin.type);
    }
    pinTypes.set(node.id, pins);
  }

  const subst = new Map<string, PinType>();
  const conflicted = new Set<string>();
  const conflicts: WildcardConflict[] = [];

  let changed = true;
  let guard = 0;
  while (changed && guard < 64) {
    changed = false;
    guard += 1;
    for (const edge of graph.edges) {
      const sourceType = findPin(
        pinTypes,
        edge.sourceNodeId,
        edge.sourcePinId,
      );
      const targetType = findPin(
        pinTypes,
        edge.targetNodeId,
        edge.targetPinId,
      );
      if (!sourceType || !targetType) continue;
      const sourceObserved = substitute(
        sourceType,
        edge.sourceNodeId,
        subst,
        conflicted,
      );
      changed =
        bindFromTemplate(
          targetType,
          edge.targetNodeId,
          sourceObserved,
          subst,
          conflicted,
          conflicts,
          {
            pinId: edge.targetPinId,
            relatedNodeId: edge.sourceNodeId,
            relatedPinId: edge.sourcePinId,
          },
          true,
        ) || changed;
    }
    if (changed) continue;
    for (const edge of graph.edges) {
      const sourceType = findPin(
        pinTypes,
        edge.sourceNodeId,
        edge.sourcePinId,
      );
      const targetType = findPin(
        pinTypes,
        edge.targetNodeId,
        edge.targetPinId,
      );
      if (!sourceType || !targetType) continue;
      const targetObserved = substitute(
        targetType,
        edge.targetNodeId,
        subst,
        conflicted,
      );
      changed =
        bindFromTemplate(
          sourceType,
          edge.sourceNodeId,
          targetObserved,
          subst,
          conflicted,
          conflicts,
          {
            pinId: edge.sourcePinId,
            relatedNodeId: edge.targetNodeId,
            relatedPinId: edge.targetPinId,
          },
          false,
        ) || changed;
    }
  }

  const resolved = new Map<string, PinType>();
  const display = new Map<string, PinType>();

  const peerOf = new Map<string, { nodeId: string; pinId: string }>();
  for (const edge of graph.edges) {
    const sourceKey = pinTypeKey(edge.sourceNodeId, edge.sourcePinId);
    const targetKey = pinTypeKey(edge.targetNodeId, edge.targetPinId);
    if (!peerOf.has(sourceKey)) {
      peerOf.set(sourceKey, {
        nodeId: edge.targetNodeId,
        pinId: edge.targetPinId,
      });
    }
    if (!peerOf.has(targetKey)) {
      peerOf.set(targetKey, {
        nodeId: edge.sourceNodeId,
        pinId: edge.sourcePinId,
      });
    }
  }

  for (const node of graph.nodes) {
    for (const pin of node.pins) {
      const key = pinTypeKey(node.id, pin.id);
      const resolvedType = substitute(pin.type, node.id, subst, conflicted);
      resolved.set(key, resolvedType);
      let displayType = resolvedType;
      if (isBoxed(pin.type)) {
        const peer = peerOf.get(key);
        if (peer) {
          const peerDeclared = findPin(pinTypes, peer.nodeId, peer.pinId);
          if (peerDeclared) {
            displayType = substitute(
              peerDeclared,
              peer.nodeId,
              subst,
              conflicted,
            );
          }
        }
      }
      display.set(key, displayType);
    }
  }

  return { resolved, display, conflicts };
}
