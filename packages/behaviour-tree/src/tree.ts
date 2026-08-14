import { pinTypeFromJson, type PinType } from "@babylonslate/scripting";
import type {
  BehaviourTreeDocument,
  BlackboardDocument,
  BlackboardKey,
  BtAbortMode,
  BtDecorator,
  BtNode,
  BtNodeKind,
  BtService,
} from "./types";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function parseKind(value: unknown): BtNodeKind | null {
  if (value === "selector" || value === "sequence" || value === "parallel" || value === "task") {
    return value;
  }
  return null;
}

function parseAbortMode(value: unknown): BtAbortMode {
  if (value === "self" || value === "lowerPriority" || value === "both" || value === "none") {
    return value;
  }
  return "none";
}

function parseProperties(value: unknown): Record<string, unknown> {
  const row = asRecord(value);
  return row ? { ...row } : {};
}

function parseDecorator(value: unknown, index: number): BtDecorator | null {
  const row = asRecord(value);
  if (!row) return null;
  const id = typeof row.id === "string" && row.id !== "" ? row.id : `decorator-${index}`;
  const classId = typeof row.classId === "string" ? row.classId : "";
  if (classId === "") return null;
  return {
    id,
    classId,
    abortMode: parseAbortMode(row.abortMode),
    observedKeys: asStringArray(row.observedKeys),
    properties: parseProperties(row.properties),
  };
}

function parseService(value: unknown, index: number): BtService | null {
  const row = asRecord(value);
  if (!row) return null;
  const id = typeof row.id === "string" && row.id !== "" ? row.id : `service-${index}`;
  const classId = typeof row.classId === "string" ? row.classId : "";
  if (classId === "") return null;
  const intervalMs = typeof row.intervalMs === "number" && Number.isFinite(row.intervalMs)
    ? row.intervalMs
    : 250;
  const randomDeviationMs =
    typeof row.randomDeviationMs === "number" && Number.isFinite(row.randomDeviationMs)
      ? row.randomDeviationMs
      : 0;
  return {
    id,
    classId,
    intervalMs,
    randomDeviationMs,
    properties: parseProperties(row.properties),
  };
}

function parseNode(value: unknown): BtNode | null {
  const row = asRecord(value);
  if (!row) return null;
  if (typeof row.id !== "string" || row.id === "") return null;
  const kind = parseKind(row.kind);
  if (!kind) return null;
  const classId = typeof row.classId === "string" && row.classId !== "" ? row.classId : `bt.${kind}`;
  const decorators = Array.isArray(row.decorators)
    ? row.decorators
        .map((entry, index) => parseDecorator(entry, index))
        .filter((entry): entry is BtDecorator => entry !== null)
    : [];
  const services = Array.isArray(row.services)
    ? row.services
        .map((entry, index) => parseService(entry, index))
        .filter((entry): entry is BtService => entry !== null)
    : [];
  return {
    id: row.id,
    kind,
    classId,
    children: asStringArray(row.children),
    decorators,
    services,
    properties: parseProperties(row.properties),
  };
}

export function createDefaultBehaviourTree(name = "Behaviour Tree"): BehaviourTreeDocument {
  return {
    name,
    rootId: "root",
    blackboardGuid: null,
    nodes: [
      {
        id: "root",
        kind: "selector",
        classId: "bt.composite.selector",
        children: ["sequence"],
        decorators: [],
        services: [],
        properties: {},
      },
      {
        id: "sequence",
        kind: "sequence",
        classId: "bt.composite.sequence",
        children: ["task"],
        decorators: [],
        services: [],
        properties: {},
      },
      {
        id: "task",
        kind: "task",
        classId: "bt.task.succeed",
        children: [],
        decorators: [],
        services: [],
        properties: {},
      },
    ],
  };
}

export function parseBehaviourTreeDocument(value: unknown): BehaviourTreeDocument | null {
  const row = asRecord(value);
  if (!row || !Array.isArray(row.nodes)) return null;
  const nodes: BtNode[] = [];
  for (const entry of row.nodes) {
    const node = parseNode(entry);
    if (node) nodes.push(node);
  }
  if (nodes.length === 0) return null;
  const rootId =
    typeof row.rootId === "string" && row.rootId !== "" ? row.rootId : nodes[0]!.id;
  return {
    name: typeof row.name === "string" && row.name !== "" ? row.name : "Behaviour Tree",
    rootId,
    nodes,
    blackboardGuid: typeof row.blackboardGuid === "string" ? row.blackboardGuid : null,
  };
}

function parseKey(value: unknown): BlackboardKey | null {
  const row = asRecord(value);
  if (!row || typeof row.name !== "string" || row.name === "") return null;
  const type: PinType = pinTypeFromJson(row.type);
  const key: BlackboardKey = { name: row.name, type };
  if ("defaultValue" in row) key.defaultValue = row.defaultValue;
  return key;
}

export function createDefaultBlackboard(name = "Blackboard"): BlackboardDocument {
  return {
    name,
    keys: [{ name: "alert", type: { kind: "bool" } }],
  };
}

export function parseBlackboardDocument(value: unknown): BlackboardDocument | null {
  const row = asRecord(value);
  if (!row || !Array.isArray(row.keys)) return null;
  const keys: BlackboardKey[] = [];
  for (const entry of row.keys) {
    const key = parseKey(entry);
    if (key) keys.push(key);
  }
  return {
    name: typeof row.name === "string" && row.name !== "" ? row.name : "Blackboard",
    keys,
  };
}
