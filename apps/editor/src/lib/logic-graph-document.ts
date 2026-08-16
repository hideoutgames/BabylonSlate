import {
  isFunctionLibraryClass,
  type GraphClassMemberPin,
  type SerializedGraph,
} from "@babylonslate/core";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSerializedGraph(value: unknown): value is SerializedGraph {
  if (!isRecord(value)) return false;
  return Array.isArray(value.nodes) && Array.isArray(value.edges);
}

/** Logic graph stored on a Class document or UserInterface `payload.logic`. */
export function serializedGraphFromDocument(
  kind: string,
  content: unknown,
): SerializedGraph | null {
  if (kind === "graph") {
    return isSerializedGraph(content) ? content : null;
  }
  if (kind === "ui" && isRecord(content)) {
    return isSerializedGraph(content.logic) ? content.logic : null;
  }
  return null;
}

/** Write a logic graph back onto a Class body or UserInterface payload. */
export function replaceSerializedGraphInDocument(
  kind: string,
  content: unknown,
  next: SerializedGraph,
): unknown {
  if (kind === "graph") return next;
  if (kind === "ui" && isRecord(content)) {
    return { ...content, logic: next };
  }
  return next;
}

export type FunctionLibraryPaletteEntry = {
  classId: string;
  parentClass?: string | null;
  functions: Array<{ name: string; pins?: GraphClassMemberPin[] }>;
};

function functionsFromMembers(
  members: SerializedGraph["members"],
): FunctionLibraryPaletteEntry["functions"] {
  return (members ?? [])
    .filter((member) => member.kind === "function" && member.name)
    .map((member) => ({
      name: member.name,
      pins: member.pins ?? [],
    }));
}

function functionsFromHeaderPayload(
  payload: Record<string, unknown> | undefined,
): FunctionLibraryPaletteEntry["functions"] {
  const raw = payload?.functions;
  if (!Array.isArray(raw)) return [];
  const functions: FunctionLibraryPaletteEntry["functions"] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const name = (entry as { name?: unknown }).name;
    if (typeof name !== "string" || !name) continue;
    functions.push({
      name,
      pins: normalizeHeaderPins((entry as { pins?: unknown }).pins),
    });
  }
  return functions;
}

function normalizeHeaderPins(value: unknown): GraphClassMemberPin[] {
  if (!Array.isArray(value)) return [];
  const pins: GraphClassMemberPin[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const name = (row as { name?: unknown }).name;
    if (typeof name !== "string" || !name) continue;
    const typeClassId = (row as { typeClassId?: unknown }).typeClassId;
    const pin: GraphClassMemberPin = {
      name,
      typeId:
        typeof (row as { typeId?: unknown }).typeId === "string"
          ? (row as { typeId: string }).typeId
          : "float",
      direction:
        (row as { direction?: unknown }).direction === "out" ? "out" : "in",
    };
    if (typeof typeClassId === "string" && typeClassId.trim()) {
      pin.typeClassId = typeClassId.trim();
    }
    pins.push(pin);
  }
  return pins;
}

/** Closed FunctionLibrary assets use header.payload.functions; open docs prefer members. */
export function collectFunctionLibrariesForPalette(options: {
  assets: ReadonlyArray<{
    path: string;
    header: {
      type: string;
      name: string;
      parentClass?: string | null;
      payload?: Record<string, unknown>;
    };
  }>;
  openDocuments: ReadonlyArray<{
    ref: { kind: string; path: string };
    content: unknown;
  }>;
  parentOf: (id: string) => string | null | undefined;
  classIdForPath: (path: string) => string;
}): FunctionLibraryPaletteEntry[] {
  const openByClassId = new Map<string, SerializedGraph>();
  for (const doc of options.openDocuments) {
    if (doc.ref.kind !== "graph") continue;
    const graph = serializedGraphFromDocument(doc.ref.kind, doc.content);
    if (!graph) continue;
    openByClassId.set(options.classIdForPath(doc.ref.path), graph);
  }

  const libraries: FunctionLibraryPaletteEntry[] = [];
  const seen = new Set<string>();
  const consider = (
    classId: string,
    parentClass: string | null | undefined,
    headerFunctions: FunctionLibraryPaletteEntry["functions"],
  ) => {
    if (seen.has(classId)) return;
    if (
      !isFunctionLibraryClass(classId, options.parentOf) &&
      !isFunctionLibraryClass(parentClass, options.parentOf)
    ) {
      return;
    }
    seen.add(classId);
    const open = openByClassId.get(classId);
    libraries.push({
      classId,
      parentClass,
      functions: open ? functionsFromMembers(open.members) : headerFunctions,
    });
  };

  for (const asset of options.assets) {
    if (asset.header.type !== "Class" && asset.header.type !== "Graph") {
      continue;
    }
    consider(
      options.classIdForPath(asset.path),
      asset.header.parentClass,
      functionsFromHeaderPayload(asset.header.payload),
    );
  }

  for (const [classId, graph] of openByClassId) {
    consider(
      classId,
      options.parentOf(classId) ?? null,
      functionsFromMembers(graph.members),
    );
  }

  return libraries;
}

export type LogicGraphCommit =
  | { kind: "graph"; graph: SerializedGraph }
  | { kind: "ui"; payload: Record<string, unknown> };

/** Persist a logic graph as a Class body or UserInterface payload. */
export function commitLogicGraph(
  kind: string,
  content: unknown,
  next: SerializedGraph,
): LogicGraphCommit {
  if (kind === "ui") {
    const payload = replaceSerializedGraphInDocument("ui", content, next);
    if (isRecord(payload)) {
      return { kind: "ui", payload };
    }
  }
  return { kind: "graph", graph: next };
}
