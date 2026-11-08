import {
  classGraphComponentFromHeaderRow,
  classHeaderComponentRow,
  declaredValueUnit,
  isFunctionLibraryClass,
  normalizeClassMemberCategory,
  normalizeDataDefinitionAsset,
  normalizeScene,
  type DataDefinitionField,
  type DelegateSignatureType,
  type GraphClassMember,
  type GraphClassMemberPin,
  type SerializedGraph,
  type SerializedScene,
} from "@haptic/core";
import { diffGraphCommands, type EditCommand } from "@haptic/edit";
import { pruneEventMembersToNodes } from "./class-members";
import {
  animGraphMembersFromVariables,
  parseAnimGraphDocument,
} from "@haptic/anim-graph";
import {
  ENGINE_ENUMS,
  ENGINE_STRUCTS,
  mergeEngineTypeSchemas,
  type EnumMember,
  type StructField,
  type TypeSchemas,
} from "@haptic/scripting";
import { asEnumAsset, asStructureAsset } from "./type-asset-payload";
import { walkAncestry } from "@haptic/editor-kit";
import {
  compareClassIds,
  isLockedEngineClassId,
  subsystemBaseClassIdOf,
  type SubsystemBaseClassId,
} from "@haptic/object-model";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSerializedGraph(value: unknown): value is SerializedGraph {
  if (!isRecord(value)) return false;
  return Array.isArray(value.nodes) && Array.isArray(value.edges);
}

/** Logic graph stored on a Class document, Animation Object, or Scene / Scene Layer script. */
export function serializedGraphFromDocument(
  kind: string,
  content: unknown,
): SerializedGraph | null {
  if (kind === "graph") {
    return isSerializedGraph(content) ? content : null;
  }
  if (kind === "scene" || kind === "scene-layer") {
    const script = isRecord(content) ? content.script : undefined;
    return isSerializedGraph(script) ? script : null;
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
    const unit = declaredValueUnit(pin.typeId, (row as { unit?: unknown }).unit);
    if (unit) pin.unit = unit;
    if (pin.typeId === "delegate") pin.signature = normalizeHeaderSignature((row as { signature?: unknown }).signature);
    pins.push(pin);
  }
  return pins;
}

/** A Delegate's signature as a header stores it: type picker rows, possibly nested. */
function normalizeHeaderSignature(value: unknown): DelegateSignatureType[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): DelegateSignatureType[] => {
    if (!entry || typeof entry !== "object") return [];
    const { typeId, typeClassId, container, keyTypeId, keyTypeClassId, signature } = entry as Record<string, unknown>;
    if (typeof typeId !== "string" || !typeId) return [];
    const input: DelegateSignatureType = { typeId };
    if (typeof typeClassId === "string" && typeClassId.trim()) input.typeClassId = typeClassId.trim();
    if (container === "array" || container === "map") input.container = container;
    if (typeof keyTypeId === "string" && keyTypeId) input.keyTypeId = keyTypeId;
    if (typeof keyTypeClassId === "string" && keyTypeClassId.trim()) input.keyTypeClassId = keyTypeClassId.trim();
    if (typeId === "delegate") input.signature = normalizeHeaderSignature(signature);
    return [input];
  });
}

type FunctionLibraryAssets = ReadonlyArray<{
  path: string;
  header: {
    type: string;
    name: string;
    parentClass?: string | null;
    payload?: Record<string, unknown>;
  };
}>;

type GraphDocuments = ReadonlyArray<{
  ref: { kind: string; path: string };
  content: unknown;
}>;

/**
 * The Function Library Classes the registry headers list, in asset order,
 * each with its header functions. It reads only headers, so it changes only
 * with the registry; `withOpenFunctionLibraries` adds the open tabs.
 */
export function functionLibrariesFromHeaders(options: {
  assets: FunctionLibraryAssets;
  parentOf: (id: string) => string | null | undefined;
  classIdForPath: (path: string) => string;
}): FunctionLibraryPaletteEntry[] {
  const libraries: FunctionLibraryPaletteEntry[] = [];
  const seen = new Set<string>();
  for (const asset of options.assets) {
    if (asset.header.type !== "Class") continue;
    const classId = options.classIdForPath(asset.path);
    const parentClass = asset.header.parentClass;
    if (seen.has(classId)) continue;
    if (!isFunctionLibraryClass(classId, options.parentOf) && !isFunctionLibraryClass(parentClass, options.parentOf)) continue;
    seen.add(classId);
    libraries.push({ classId, parentClass, functions: functionsFromHeaderPayload(asset.header.payload) });
  }
  return libraries;
}

/** Header Function Libraries with each open tab's members winning, then open Libraries no header lists. */
export function withOpenFunctionLibraries(
  headerLibraries: readonly FunctionLibraryPaletteEntry[],
  options: {
    openDocuments: GraphDocuments;
    parentOf: (id: string) => string | null | undefined;
    classIdForPath: (path: string) => string;
  },
): FunctionLibraryPaletteEntry[] {
  const openByClassId = new Map<string, SerializedGraph>();
  for (const doc of options.openDocuments) {
    if (doc.ref.kind !== "graph") continue;
    const graph = serializedGraphFromDocument(doc.ref.kind, doc.content);
    if (!graph) continue;
    openByClassId.set(options.classIdForPath(doc.ref.path), graph);
  }
  const seen = new Set<string>();
  const libraries = headerLibraries.map((entry) => {
    seen.add(entry.classId);
    const open = openByClassId.get(entry.classId);
    return open ? { ...entry, functions: functionsFromMembers(open.members) } : entry;
  });
  for (const [classId, graph] of openByClassId) {
    if (seen.has(classId)) continue;
    const parentClass = options.parentOf(classId) ?? null;
    if (!isFunctionLibraryClass(classId, options.parentOf) && !isFunctionLibraryClass(parentClass, options.parentOf)) continue;
    seen.add(classId);
    libraries.push({ classId, parentClass, functions: functionsFromMembers(graph.members) });
  }
  return libraries;
}

export type SubsystemClassEntry = {
  classId: string;
  base: SubsystemBaseClassId;
};

/**
 * Project and plugin Classes of GameSubsystem / SceneSubsystem lineage,
 * including non-leaf bases, by compile class id in class-id order. Closed
 * assets use their header parent; open documents join like Function Libraries.
 */
export function collectSubsystemClassesForPalette(options: {
  assets: ReadonlyArray<{
    path: string;
    header: { type: string; parentClass?: string | null };
  }>;
  openDocuments: ReadonlyArray<{ ref: { kind: string; path: string } }>;
  parentOf: (id: string) => string | null | undefined;
  classIdForPath: (path: string) => string;
}): SubsystemClassEntry[] {
  const hierarchy = {
    ancestry: (id: string) => walkAncestry(id, options.parentOf),
  };
  const bases = new Map<string, SubsystemBaseClassId>();
  const consider = (classId: string, parentClass: string | null | undefined) => {
    if (bases.has(classId) || isLockedEngineClassId(classId)) return;
    const base =
      subsystemBaseClassIdOf(hierarchy, classId) ??
      (parentClass ? subsystemBaseClassIdOf(hierarchy, parentClass) : null);
    if (base) bases.set(classId, base);
  };
  for (const asset of options.assets) {
    if (asset.header.type !== "Class") continue;
    consider(options.classIdForPath(asset.path), asset.header.parentClass);
  }
  for (const doc of options.openDocuments) {
    if (doc.ref.kind !== "graph") continue;
    const classId = options.classIdForPath(doc.ref.path);
    consider(classId, options.parentOf(classId));
  }
  return [...bases]
    .map(([classId, base]) => ({ classId, base }))
    .sort((a, b) => compareClassIds(a.classId, b.classId));
}

/** Header members always carry the member id (`classHeaderMeta`). */
function headerMemberId(entry: object): string | undefined {
  const id = (entry as { id?: unknown }).id;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
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
      const id = headerMemberId(entry);
      if (typeof name !== "string" || !name || !id) continue;
      const fn: GraphClassMember = {
        id,
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
      const fnCategory = normalizeClassMemberCategory(
        (entry as { category?: unknown }).category,
      );
      if (fnCategory) fn.category = fnCategory;
      members.push(fn);
    }
  }
  const variables = payload?.variables;
  if (Array.isArray(variables)) {
    for (const entry of variables) {
      if (!entry || typeof entry !== "object") continue;
      const name = (entry as { name?: unknown }).name;
      const id = headerMemberId(entry);
      if (typeof name !== "string" || !name || !id) continue;
      const { typeId, typeClassId, container, keyTypeId, keyTypeClassId, loading, unit } =
        entry as Record<string, unknown>;
      const member: GraphClassMember = {
        id,
        kind: "variable",
        name,
        typeId: typeof typeId === "string" && typeId ? typeId : "float",
      };
      if (typeof typeClassId === "string" && typeClassId.trim()) {
        member.typeClassId = typeClassId.trim();
      }
      // Array and Map variables keep their container, so a closed parent's
      // inherited variable is not read back as a scalar.
      if (container === "array" || container === "map") member.container = container;
      if (typeof keyTypeId === "string" && keyTypeId) member.keyTypeId = keyTypeId;
      if (typeof keyTypeClassId === "string" && keyTypeClassId.trim()) {
        member.keyTypeClassId = keyTypeClassId.trim();
      }
      if (loading === "hard") member.loading = "hard";
      const variableUnit = declaredValueUnit(member.typeId, unit);
      if (variableUnit) member.unit = variableUnit;
      if (member.typeId === "delegate") {
        member.signature = normalizeHeaderSignature((entry as { signature?: unknown }).signature);
      }
      const variableCategory = normalizeClassMemberCategory(
        (entry as { category?: unknown }).category,
      );
      if (variableCategory) member.category = variableCategory;
      members.push(member);
    }
  }
  const events = payload?.events;
  if (Array.isArray(events)) {
    for (const entry of events) {
      if (!entry || typeof entry !== "object") continue;
      const name = (entry as { name?: unknown }).name;
      const id = headerMemberId(entry);
      if (typeof name !== "string" || !name || !id) continue;
      members.push({
        id,
        kind: "event",
        name,
        pins: normalizeHeaderPins((entry as { pins?: unknown }).pins),
      });
    }
  }
  const dispatchers = payload?.dispatchers;
  if (Array.isArray(dispatchers)) {
    for (const entry of dispatchers) {
      if (!entry || typeof entry !== "object") continue;
      const name = (entry as { name?: unknown }).name;
      const id = headerMemberId(entry);
      if (typeof name !== "string" || !name || !id) continue;
      const dispatcher: GraphClassMember = {
        id,
        kind: "dispatcher",
        name,
        pins: normalizeHeaderPins((entry as { pins?: unknown }).pins),
      };
      const dispatcherCategory = normalizeClassMemberCategory(
        (entry as { category?: unknown }).category,
      );
      if (dispatcherCategory) dispatcher.category = dispatcherCategory;
      members.push(dispatcher);
    }
  }
  const interfaces = payload?.interfaces;
  if (Array.isArray(interfaces)) {
    for (const entry of interfaces) {
      if (!entry || typeof entry !== "object") continue;
      const name = (entry as { name?: unknown }).name;
      const id = headerMemberId(entry);
      if (typeof name !== "string" || !name || !id) continue;
      const assetGuid = (entry as { assetGuid?: unknown }).assetGuid;
      members.push({
        id,
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
      const row = classHeaderComponentRow(entry);
      if (row) components.push(classGraphComponentFromHeaderRow(row));
    }
  }
  return {
    nodes: [],
    edges: [],
    members,
    ...(components.length > 0 ? { components } : {}),
  };
}

type ScriptInterfacePaletteEntry = {
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

/**
 * Closed Class graphs rebuilt from registry headers, keyed by class id. It
 * reads only headers, so it changes only with the registry; overlay the open
 * tabs with `withOpenClassGraphs`.
 */
export function classGraphsFromHeaders(options: {
  assets: FunctionLibraryAssets;
  classIdForPath: (path: string) => string;
}): Readonly<Record<string, SerializedGraph>> {
  const graphs: Record<string, SerializedGraph> = {};
  for (const asset of options.assets) {
    if (asset.header.type !== "Class") continue;
    graphs[options.classIdForPath(asset.path)] = classGraphFromHeaderPayload(asset.header.payload);
  }
  return graphs;
}

/**
 * Header graphs with each open Class tab's unsaved graph winning: a new
 * record on every call, so a caller may add to it without touching the
 * shared header graphs.
 */
export function withOpenClassGraphs(
  headerGraphs: Readonly<Record<string, SerializedGraph>>,
  openDocuments: GraphDocuments,
  classIdForPath: (path: string) => string,
): Record<string, SerializedGraph> {
  const graphs: Record<string, SerializedGraph> = { ...headerGraphs };
  for (const doc of openDocuments) {
    if (doc.ref.kind !== "graph") continue;
    const graph = serializedGraphFromDocument(doc.ref.kind, doc.content);
    if (!graph) continue;
    graphs[classIdForPath(doc.ref.path)] = graph;
  }
  return graphs;
}

/** Closed Class headers plus open documents, keyed by class id. */
export function collectClassGraphsForPalette(options: {
  assets: FunctionLibraryAssets;
  openDocuments: GraphDocuments;
  classIdForPath: (path: string) => string;
}): Record<string, SerializedGraph> {
  return withOpenClassGraphs(classGraphsFromHeaders(options), options.openDocuments, options.classIdForPath);
}

export type PaletteSceneDocument = {
  guid: string;
  name: string;
  actors: Array<{
    name: string;
    components: Array<{
      id: string;
      classId: string;
      properties?: Record<string, unknown>;
    }>;
  }>;
};

function paletteSceneFromContent(
  guid: string,
  content: unknown,
  fallbackName: string,
): PaletteSceneDocument {
  const scene = normalizeScene(content);
  return {
    guid,
    name: scene.name || fallbackName,
    actors: scene.actors.map((actor) => ({
      name: actor.name,
      components: actor.components.map((component) => ({
        id: component.id,
        classId: component.classId,
        properties: component.properties,
      })),
    })),
  };
}

/**
 * Palette views by Scene content object. Headers and open Scene contents are
 * replaced, never mutated, so every graph panel shares one view per content
 * and a Scene edit normalizes only the edited Scene, once.
 */
const paletteScenes = new WeakMap<object, { guid: string; fallbackName: string; scene: PaletteSceneDocument }>();

function cachedPaletteScene(guid: string, content: unknown, fallbackName: string): PaletteSceneDocument {
  if (!isRecord(content)) return paletteSceneFromContent(guid, content, fallbackName);
  const cached = paletteScenes.get(content);
  if (cached && cached.guid === guid && cached.fallbackName === fallbackName) return cached.scene;
  const scene = paletteSceneFromContent(guid, content, fallbackName);
  paletteScenes.set(content, { guid, fallbackName, scene });
  return scene;
}

type SceneHeaderAssets = ReadonlyArray<{
  path: string;
  header: {
    guid?: string;
    type: string;
    name: string;
    payload?: Record<string, unknown>;
  };
}>;

/** Saved Scenes by guid from their headers, plus each asset's guid by path for the open tabs. */
export type PaletteSceneHeaders = {
  byGuid: ReadonlyMap<string, PaletteSceneDocument>;
  guidByPath: ReadonlyMap<string, string | undefined>;
};

/** The header part of the Scene palette; it changes only with the registry. */
export function sceneDocumentsFromHeaders(assets: SceneHeaderAssets): PaletteSceneHeaders {
  const byGuid = new Map<string, PaletteSceneDocument>();
  const guidByPath = new Map<string, string | undefined>();
  for (const asset of assets) {
    if (!guidByPath.has(asset.path)) guidByPath.set(asset.path, asset.header.guid);
    if (asset.header.type !== "Scene") continue;
    const guid = asset.header.guid?.trim();
    if (!guid) continue;
    byGuid.set(guid, cachedPaletteScene(guid, asset.header.payload ?? {}, asset.header.name));
  }
  return { byGuid, guidByPath };
}

/** Header Scenes with each open Scene tab's unsaved actors winning. */
export function withOpenSceneDocuments(
  headers: PaletteSceneHeaders,
  openDocuments: GraphDocuments,
): PaletteSceneDocument[] {
  const byGuid = new Map(headers.byGuid);
  for (const doc of openDocuments) {
    if (doc.ref.kind !== "scene") continue;
    const guid = headers.guidByPath.get(doc.ref.path);
    if (!guid) continue;
    byGuid.set(guid, cachedPaletteScene(guid, doc.content, guid));
  }
  return [...byGuid.values()];
}

export function collectSceneDocumentsForPalette(options: {
  assets: SceneHeaderAssets;
  openDocuments: GraphDocuments;
}): PaletteSceneDocument[] {
  return withOpenSceneDocuments(sceneDocumentsFromHeaders(options.assets), options.openDocuments);
}

type LogicGraphCommit =
  | { kind: "graph"; graph: SerializedGraph }
  /** The whole Scene (or Scene Layer tab) with its new script, for `applySceneChange`. */
  | { kind: "scene"; scene: SerializedScene }
  | {
      kind: "anim-graph";
      payload: Record<string, unknown>;
      /** Set when the edit is one graph command that coalesces (a pin default scrub). */
      mergeKey?: string;
    };

/**
 * Undo merge key for a logic graph stored inside an asset payload. A Class
 * graph gets its keys from `applyGraphChange`; here the command layer's own
 * key is reused when the edit is a single graph command, so scrubbing a pin
 * default is one undo step there too.
 */
export function logicGraphEditMergeKey(
  previous: SerializedGraph | null,
  next: SerializedGraph,
): string | undefined {
  if (!previous) return undefined;
  const commands: EditCommand<SerializedGraph>[] = diffGraphCommands(
    previous,
    next,
  );
  const key = commands.length === 1 ? commands[0]!.mergeKey : undefined;
  return key ? `logic-graph:${key}` : undefined;
}

/** Route a `commitLogicGraph` result to the document action its owner takes. */
export function applyLogicGraphCommit(
  actions: {
    applyGraphChange: (id: string, graph: SerializedGraph) => Promise<boolean>;
    applyAssetDocumentChange: (id: string, payload: Record<string, unknown>, mergeKey?: string) => Promise<boolean>;
    applySceneChange: (id: string, scene: SerializedScene) => Promise<boolean>;
  },
  documentId: string,
  commit: LogicGraphCommit,
): void {
  if (commit.kind === "graph") void actions.applyGraphChange(documentId, commit.graph);
  else if (commit.kind === "scene") void actions.applySceneChange(documentId, commit.scene);
  else void actions.applyAssetDocumentChange(documentId, commit.payload, commit.mergeKey);
}

/** Persist a logic graph as a Class body, Animation Object or Scene / Scene Layer script. */
export function commitLogicGraph(
  kind: string,
  content: unknown,
  next: SerializedGraph,
): LogicGraphCommit {
  next = pruneEventMembersToNodes(next);
  if ((kind === "scene" || kind === "scene-layer") && isRecord(content)) {
    // A script has no prefab: never store components or Actor Defaults on it.
    const { components: _components, actorDefaults: _actorDefaults, overlayDesign: _overlayDesign, ...script } = next;
    void _components;
    void _actorDefaults;
    void _overlayDesign;
    return { kind: "scene", scene: { ...(content as unknown as SerializedScene), script } };
  }
  if (kind === "anim-graph") {
    const payload = replaceSerializedGraphInDocument(
      "anim-graph",
      content,
      next,
    );
    if (isRecord(payload)) {
      return {
        kind: "anim-graph",
        payload,
        mergeKey: logicGraphEditMergeKey(
          serializedGraphFromDocument("anim-graph", content),
          next,
        ),
      };
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

/** A Data Definition's fields always carry their persisted id. */
type GraphDataDefinitionEntry = {
  guid: string;
  name: string;
  fields: DataDefinitionField[];
};

type GraphTypeAssetCatalog = {
  structures: GraphStructureEntry[];
  dataDefinitions: GraphDataDefinitionEntry[];
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

/** Closed Data Definition/Structure/Enum headers, open documents, and the engine registry. */
export function collectGraphTypeAssets(options: {
  assets: ReadonlyArray<{
    path?: string;
    header: {
      type: string;
      guid?: string;
      name: string;
      payload?: Record<string, unknown>;
    };
  }>;
  openDocuments: ReadonlyArray<{
    ref: { kind: string; path?: string };
    content: unknown;
  }>;
}): GraphTypeAssetCatalog {
  const dataDefinitions = new Map<string, GraphDataDefinitionEntry>();
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
  const open = new Map(options.openDocuments.filter((doc) => doc.ref.kind === "data-definition" && doc.ref.path && doc.content != null)
    .map((doc) => [doc.ref.path, doc.content]));
  for (const asset of options.assets) {
    if (asset.header.type === "DataDefinition" && asset.header.guid) {
      const authored = asset.path && open.has(asset.path) ? open.get(asset.path) : asset.header.payload ?? {};
      try {
        const payload = normalizeDataDefinitionAsset(authored);
        dataDefinitions.set(asset.header.guid, { guid: asset.header.guid, name: asset.header.name, fields: payload.fields });
      } catch {
        // A malformed schema cannot provide typed graph values. Leave it out
        // so affected nodes report a missing Definition instead of crashing.
      }
    }
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
    dataDefinitions: [...dataDefinitions.values()],
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
    dataDefinitions: Object.fromEntries(
      catalog.dataDefinitions.map((entry) => [entry.guid, { name: entry.name, fields: entry.fields }]),
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
    ...catalog.dataDefinitions.map((entry) => ({ guid: entry.guid, name: entry.name, type: "DataDefinition" })),
    ...catalog.enums.map((entry) => ({
      guid: entry.guid,
      name: entry.name,
      type: "Enum",
    })),
  ];
}
