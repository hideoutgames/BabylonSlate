import {
  isFunctionLibraryClass,
  type GraphClassMember,
  type GraphClassMemberPin,
  type SerializedGraph,
} from "@babylonslate/core";
import { pruneEventMembersToNodes } from "./class-members";
import {
  animGraphMembersFromVariables,
  parseAnimGraphDocument,
} from "@babylonslate/anim-graph";
import {
  ENGINE_ENUMS,
  ENGINE_STRUCTS,
  mergeEngineTypeSchemas,
  type EnumMember,
  type StructField,
  type TypeSchemas,
} from "@babylonslate/scripting";
import { asEnumAsset, asStructureAsset } from "./type-asset-payload";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSerializedGraph(value: unknown): value is SerializedGraph {
  if (!isRecord(value)) return false;
  return Array.isArray(value.nodes) && Array.isArray(value.edges);
}

/** Logic graph stored on a Class document or Animation Object. */
export function serializedGraphFromDocument(
  kind: string,
  content: unknown,
): SerializedGraph | null {
  if (kind === "graph") {
    return isSerializedGraph(content) ? content : null;
  }
  if (kind === "anim-graph") {
    const parsed = parseAnimGraphDocument(content);
    if (!parsed) return null;
    return {
      ...parsed.animationObject,
      members: animGraphMembersFromVariables(parsed.variables),
    };
  }
  return null;
}

/** Write a logic graph back onto a Class body or Animation Object. */
export function replaceSerializedGraphInDocument(
  kind: string,
  content: unknown,
  next: SerializedGraph,
): unknown {
  if (kind === "graph") return next;
  if (kind === "anim-graph" && isRecord(content)) {
    return {
      ...content,
      animationObject: { nodes: next.nodes, edges: next.edges },
    };
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

function headerMemberId(entry: { id?: unknown; name: string }): string {
  return typeof entry.id === "string" && entry.id.trim()
    ? entry.id.trim()
    : entry.name;
}

/** Rebuild a lightweight SerializedGraph from closed Class header metadata. */
export function classGraphFromHeaderPayload(
  payload?: Record<string, unknown>,
): SerializedGraph {
  const members: GraphClassMember[] = [];
  const functions = payload?.functions;
  if (Array.isArray(functions)) {
    for (const entry of functions) {
      if (!entry || typeof entry !== "object") continue;
      const name = (entry as { name?: unknown }).name;
      if (typeof name !== "string" || !name) continue;
      const fn: GraphClassMember = {
        id: headerMemberId({ ...(entry as { id?: unknown }), name }),
        kind: "function",
        name,
        pins: normalizeHeaderPins((entry as { pins?: unknown }).pins),
      };
      if ((entry as { overridable?: unknown }).overridable === true) {
        fn.overridable = true;
      }
      const implementsInterface = (entry as { implementsInterface?: unknown })
        .implementsInterface;
      if (
        implementsInterface &&
        typeof implementsInterface === "object" &&
        typeof (implementsInterface as { assetGuid?: unknown }).assetGuid ===
          "string" &&
        typeof (implementsInterface as { methodName?: unknown }).methodName ===
          "string"
      ) {
        fn.implementsInterface = {
          assetGuid: (implementsInterface as { assetGuid: string }).assetGuid,
          methodName: (implementsInterface as { methodName: string }).methodName,
        };
      }
      const overrides = (entry as { overrides?: unknown }).overrides;
      if (
        overrides &&
        typeof overrides === "object" &&
        typeof (overrides as { classId?: unknown }).classId === "string" &&
        typeof (overrides as { name?: unknown }).name === "string"
      ) {
        fn.overrides = {
          classId: (overrides as { classId: string }).classId,
          name: (overrides as { name: string }).name,
        };
      }
      members.push(fn);
    }
  }
  const variables = payload?.variables;
  if (Array.isArray(variables)) {
    for (const entry of variables) {
      if (!entry || typeof entry !== "object") continue;
      const name = (entry as { name?: unknown }).name;
      if (typeof name !== "string" || !name) continue;
      const typeId = (entry as { typeId?: unknown }).typeId;
      const typeClassId = (entry as { typeClassId?: unknown }).typeClassId;
      const member: GraphClassMember = {
        id: headerMemberId({ ...(entry as { id?: unknown }), name }),
        kind: "variable",
        name,
        typeId: typeof typeId === "string" && typeId ? typeId : "float",
      };
      if (typeof typeClassId === "string" && typeClassId.trim()) {
        member.typeClassId = typeClassId.trim();
      }
      members.push(member);
    }
  }
  const events = payload?.events;
  if (Array.isArray(events)) {
    for (const entry of events) {
      if (!entry || typeof entry !== "object") continue;
      const name = (entry as { name?: unknown }).name;
      if (typeof name !== "string" || !name) continue;
      members.push({
        id: headerMemberId({ ...(entry as { id?: unknown }), name }),
        kind: "event",
        name,
        pins: normalizeHeaderPins((entry as { pins?: unknown }).pins),
      });
    }
  }
  const interfaces = payload?.interfaces;
  if (Array.isArray(interfaces)) {
    for (const entry of interfaces) {
      if (!entry || typeof entry !== "object") continue;
      const name = (entry as { name?: unknown }).name;
      if (typeof name !== "string" || !name) continue;
      const assetGuid = (entry as { assetGuid?: unknown }).assetGuid;
      members.push({
        id: headerMemberId({ ...(entry as { id?: unknown }), name }),
        kind: "interface",
        name,
        assetGuid: typeof assetGuid === "string" ? assetGuid : "",
      });
    }
  }
  const components: SerializedGraph["components"] = [];
  const rawComponents = payload?.components;
  if (Array.isArray(rawComponents)) {
    for (const entry of rawComponents) {
      if (!entry || typeof entry !== "object") continue;
      const id = (entry as { id?: unknown }).id;
      const classId = (entry as { classId?: unknown }).classId;
      if (typeof id !== "string" || !id.trim()) continue;
      if (typeof classId !== "string" || !classId.trim()) continue;
      const parentId = (entry as { parentId?: unknown }).parentId;
      const properties = (entry as { properties?: unknown }).properties;
      const transform = (entry as { transform?: unknown }).transform;
      components.push({
        id: id.trim(),
        classId: classId.trim(),
        properties:
          properties && typeof properties === "object"
            ? { ...(properties as Record<string, unknown>) }
            : {},
        parentId: typeof parentId === "string" ? parentId : null,
        ...(transform && typeof transform === "object"
          ? { transform: transform as NonNullable<SerializedGraph["components"]>[number]["transform"] }
          : {}),
      });
    }
  }
  return {
    nodes: [],
    edges: [],
    members,
    ...(components.length > 0 ? { components } : {}),
  };
}

export type ScriptInterfacePaletteEntry = {
  guid: string;
  name: string;
  methods: Array<{
    name: string;
    pins?: GraphClassMemberPin[];
  }>;
};

function methodsFromPayload(payload?: Record<string, unknown>): ScriptInterfacePaletteEntry["methods"] {
  const raw = payload?.methods;
  if (!Array.isArray(raw)) return [];
  const methods: ScriptInterfacePaletteEntry["methods"] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const name = (entry as { name?: unknown }).name;
    if (typeof name !== "string" || !name) continue;
    methods.push({
      name,
      pins: normalizeHeaderPins((entry as { pins?: unknown }).pins),
    });
  }
  return methods;
}

/** Closed ScriptInterface headers plus open documents. */
export function collectScriptInterfacesForPalette(options: {
  assets: ReadonlyArray<{
    header: {
      type: string;
      guid?: string;
      name: string;
      payload?: Record<string, unknown>;
    };
  }>;
  openDocuments: ReadonlyArray<{
    ref: { kind: string };
    content: unknown;
  }>;
}): ScriptInterfacePaletteEntry[] {
  const byGuid = new Map<string, ScriptInterfacePaletteEntry>();
  for (const asset of options.assets) {
    if (asset.header.type !== "ScriptInterface") continue;
    const guid =
      (typeof asset.header.payload?.guid === "string" &&
        asset.header.payload.guid) ||
      asset.header.guid ||
      "";
    if (!guid) continue;
    byGuid.set(guid, {
      guid,
      name:
        (typeof asset.header.payload?.name === "string" &&
          asset.header.payload.name) ||
        asset.header.name,
      methods: methodsFromPayload(asset.header.payload),
    });
  }
  for (const doc of options.openDocuments) {
    if (doc.ref.kind !== "script-interface") continue;
    if (!isRecord(doc.content)) continue;
    const guid = typeof doc.content.guid === "string" ? doc.content.guid : "";
    if (!guid) continue;
    const name =
      typeof doc.content.name === "string" && doc.content.name
        ? doc.content.name
        : "Interface";
    byGuid.set(guid, {
      guid,
      name,
      methods: methodsFromPayload(doc.content),
    });
  }
  return [...byGuid.values()];
}

/** Closed Class headers plus open documents, keyed by class id. */
export function collectClassGraphsForPalette(options: {
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
  classIdForPath: (path: string) => string;
}): Record<string, SerializedGraph> {
  const graphs: Record<string, SerializedGraph> = {};
  for (const asset of options.assets) {
    if (asset.header.type !== "Class" && asset.header.type !== "Graph") {
      continue;
    }
    const classId = options.classIdForPath(asset.path);
    const graph = classGraphFromHeaderPayload(asset.header.payload);
    graphs[classId] = graph;
    if (asset.header.name !== classId) graphs[asset.header.name] = graph;
  }
  for (const doc of options.openDocuments) {
    if (doc.ref.kind !== "graph") continue;
    const graph = serializedGraphFromDocument(doc.ref.kind, doc.content);
    if (!graph) continue;
    const classId = options.classIdForPath(doc.ref.path);
    graphs[classId] = graph;
  }
  return graphs;
}

export type LogicGraphCommit =
  | { kind: "graph"; graph: SerializedGraph }
  | { kind: "anim-graph"; payload: Record<string, unknown> };

/** Persist a logic graph as a Class body or Animation Object. */
export function commitLogicGraph(
  kind: string,
  content: unknown,
  next: SerializedGraph,
): LogicGraphCommit {
  next = pruneEventMembersToNodes(next);
  if (kind === "anim-graph") {
    const payload = replaceSerializedGraphInDocument(
      "anim-graph",
      content,
      next,
    );
    if (isRecord(payload)) {
      return { kind: "anim-graph", payload };
    }
  }
  return { kind: "graph", graph: next };
}

export type GraphStructureEntry = {
  guid: string;
  name: string;
  fields: StructField[];
};

export type GraphEnumEntry = {
  guid: string;
  name: string;
  members: EnumMember[];
};

export type GraphTypeAssetCatalog = {
  structures: GraphStructureEntry[];
  enums: GraphEnumEntry[];
};

function structureEntryFromPayload(
  payload: Record<string, unknown>,
  fallbackGuid: string,
  fallbackName: string,
): GraphStructureEntry | null {
  const parsed = asStructureAsset({
    ...payload,
    guid:
      typeof payload.guid === "string" && payload.guid.trim()
        ? payload.guid
        : fallbackGuid,
    name:
      typeof payload.name === "string" && payload.name.trim()
        ? payload.name
        : fallbackName,
  });
  if (!parsed.guid) return null;
  return { guid: parsed.guid, name: parsed.name, fields: parsed.fields };
}

function enumEntryFromPayload(
  payload: Record<string, unknown>,
  fallbackGuid: string,
  fallbackName: string,
): GraphEnumEntry | null {
  const parsed = asEnumAsset({
    ...payload,
    guid:
      typeof payload.guid === "string" && payload.guid.trim()
        ? payload.guid
        : fallbackGuid,
    name:
      typeof payload.name === "string" && payload.name.trim()
        ? payload.name
        : fallbackName,
  });
  if (!parsed.guid) return null;
  return { guid: parsed.guid, name: parsed.name, members: parsed.members };
}

/** Closed Structure/Enum headers, open documents, and the engine registry. */
export function collectGraphTypeAssets(options: {
  assets: ReadonlyArray<{
    header: {
      type: string;
      guid?: string;
      name: string;
      payload?: Record<string, unknown>;
    };
  }>;
  openDocuments: ReadonlyArray<{
    ref: { kind: string };
    content: unknown;
  }>;
}): GraphTypeAssetCatalog {
  const structures = new Map<string, GraphStructureEntry>();
  const enums = new Map<string, GraphEnumEntry>();
  for (const entry of ENGINE_STRUCTS) {
    structures.set(entry.id, {
      guid: entry.id,
      name: entry.name,
      fields: [...entry.fields],
    });
  }
  for (const entry of ENGINE_ENUMS) {
    enums.set(entry.id, {
      guid: entry.id,
      name: entry.name,
      members: [...entry.members],
    });
  }
  for (const asset of options.assets) {
    if (asset.header.type === "Structure") {
      const payload = asset.header.payload ?? {};
      const entry = structureEntryFromPayload(
        payload,
        asset.header.guid ?? "",
        asset.header.name,
      );
      if (entry) structures.set(entry.guid, entry);
    }
    if (asset.header.type === "Enum") {
      const payload = asset.header.payload ?? {};
      const entry = enumEntryFromPayload(
        payload,
        asset.header.guid ?? "",
        asset.header.name,
      );
      if (entry) enums.set(entry.guid, entry);
    }
  }
  for (const doc of options.openDocuments) {
    if (!isRecord(doc.content)) continue;
    if (doc.ref.kind === "structure") {
      const entry = structureEntryFromPayload(
        doc.content,
        typeof doc.content.guid === "string" ? doc.content.guid : "",
        typeof doc.content.name === "string" ? doc.content.name : "Structure",
      );
      if (entry) structures.set(entry.guid, entry);
    }
    if (doc.ref.kind === "enum") {
      const entry = enumEntryFromPayload(
        doc.content,
        typeof doc.content.guid === "string" ? doc.content.guid : "",
        typeof doc.content.name === "string" ? doc.content.name : "Enum",
      );
      if (entry) enums.set(entry.guid, entry);
    }
  }
  return {
    structures: [...structures.values()],
    enums: [...enums.values()],
  };
}

export function typeSchemasFromGraphAssets(
  catalog: GraphTypeAssetCatalog,
): TypeSchemas {
  return mergeEngineTypeSchemas({
    structs: Object.fromEntries(
      catalog.structures.map((entry) => [
        entry.guid,
        { name: entry.name, fields: entry.fields },
      ]),
    ),
    enums: Object.fromEntries(
      catalog.enums.map((entry) => [
        entry.guid,
        { name: entry.name, members: entry.members },
      ]),
    ),
  });
}

export function typeAssetPickerEntries(
  catalog: GraphTypeAssetCatalog,
): Array<{ guid: string; name: string; type: string }> {
  return [
    ...catalog.structures.map((entry) => ({
      guid: entry.guid,
      name: entry.name,
      type: "Structure",
    })),
    ...catalog.enums.map((entry) => ({
      guid: entry.guid,
      name: entry.name,
      type: "Enum",
    })),
  ];
}
