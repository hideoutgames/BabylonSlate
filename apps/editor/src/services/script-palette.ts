/**
 * The script palette's entry point: catalog rows filtered for the host, the
 * injector cache and the rows built from project type schemas.
 * `graph-validation.ts` re-exports the public names.
 */
import { isEditorGraphHost, type SerializedGraph } from "@haptic/core";
import { engineParentOf, walkAncestry } from "@haptic/editor-kit";
import { isTouchEventNodeType, type NodeRegistry } from "@haptic/scripting";
import { sceneAssetClassId } from "@haptic/object-model";
import type { PaletteNode } from "@haptic/graph-ui";
import { isScriptCatalogNodeAllowed, nativeEventStubs } from "../lib/class-members";
import { DATA_GRAPH_NODES, dataGraphMetadata, dataGraphNodeTitle } from "../lib/data-graph";
import { customEventRows, knownClassIdSet } from "./graph-class-symbols";
import { defaultNodeRegistry as registry } from "./graph-hydration";
import { isInputEvent } from "./graph-node-refresh";
import {
  callCustomEventPaletteNodes,
  callFunctionPaletteNodes,
  callImplicitSelf,
  callInterfacePaletteNodes,
  castPaletteNodes,
  functionRows,
  subsystemGetPaletteNodes,
  variableAccessPaletteNodes,
  type ScriptPaletteOptions,
} from "./script-palette-members";

export type { PaletteSceneDocument, ScriptPaletteOptions } from "./script-palette-members";

function structPaletteNodes(
  nodeRegistry: NodeRegistry,
  options?: ScriptPaletteOptions,
): PaletteNode[] {
  const makeDef = nodeRegistry.get("struct.make");
  const breakDef = nodeRegistry.get("struct.break");
  if (!makeDef || !breakDef) return [];
  const rows: PaletteNode[] = [];
  for (const structure of [...(options?.structures ?? []), ...(options?.dataDefinitions ?? [])]) {
    const isDefinition = options?.dataDefinitions?.some((entry) => entry.guid === structure.guid);
    const name = `${structure.name}${isDefinition ? " Data" : ""}`;
    const defaultData: Record<string, unknown> = {
      structGuid: structure.guid,
      fields: structure.fields,
      ...(isDefinition ? { dataDefinition: true } : {}),
    };
    rows.push({
      id: `struct.make:${structure.guid}`,
      nodeType: "struct.make",
      title: `Make ${name}`,
      category: isDefinition ? "data" : makeDef.category,
      pins: makeDef.pins(defaultData),
      pure: makeDef.pure,
      latent: makeDef.latent,
      defaultData: { ...defaultData, title: `Make ${name}` },
    });
    rows.push({
      id: `struct.break:${structure.guid}`,
      nodeType: "struct.break",
      title: `Break ${name}`,
      category: isDefinition ? "data" : breakDef.category,
      pins: breakDef.pins(defaultData),
      pure: breakDef.pure,
      latent: breakDef.latent,
      defaultData: { ...defaultData, title: `Break ${name}` },
    });
  }
  return rows;
}

function saveGamePaletteNodes(nodeRegistry: NodeRegistry, options?: ScriptPaletteOptions): PaletteNode[] {
  if (isEditorGraphHost(options ?? {}) || options?.animationGraphHost === "rule") return [];
  return (options?.saveGameDefinition?.fields ?? []).flatMap((field) =>
    ["getField", "setField", "migrationGetField", "migrationSetField"].map((operation): PaletteNode => {
      const def = nodeRegistry.get(`saveGame.${operation}`)!;
      const migration = operation.startsWith("migration");
      const write = operation === "setField" || operation === "migrationSetField";
      const title = `${write ? "Set" : "Get"} ${migration ? "Migration" : "Save"} ${field.name}`;
      const defaultData = { fieldId: field.id, fieldName: field.name, typeId: field.type, array: field.array === true, title,
        ...(write ? { "default:value": field.defaultValue } : {}) };
      return { id: `${def.id}:${field.id}`, nodeType: def.id, title, category: "save-game", description: def.description,
        pins: def.pins(defaultData), pure: def.pure, latent: def.latent, defaultData };
    }));
}

function dataPaletteNodes(
  nodeRegistry: NodeRegistry,
  options?: ScriptPaletteOptions,
): PaletteNode[] {
  const rows: PaletteNode[] = [];
  for (const typeId of Object.keys(DATA_GRAPH_NODES) as Array<keyof typeof DATA_GRAPH_NODES>) {
    const def = nodeRegistry.get(typeId);
    if (!def || dataGraphMetadata(typeId)?.schema === false || (def.editorOnly && !isEditorGraphHost(options ?? {}))) continue;
    for (const structure of options?.dataDefinitions ?? []) {
      const title = dataGraphNodeTitle(typeId, structure.name);
      const defaultData = { definitionGuid: structure.guid, title };
      rows.push({
        id: `${typeId}:${structure.guid}`,
        nodeType: typeId,
        title,
        description: def.description,
        category: def.category,
        searchAliases: def.searchAliases,
        pins: def.pins(defaultData),
        pure: def.pure,
        latent: def.latent,
        editorOnly: def.editorOnly,
        defaultData,
      });
    }
  }
  return rows;
}

function enumPaletteNodes(
  nodeRegistry: NodeRegistry,
  options?: ScriptPaletteOptions,
): PaletteNode[] {
  const makeDef = nodeRegistry.get("enum.make");
  const equalDef = nodeRegistry.get("enum.equals");
  const notEqualDef = nodeRegistry.get("enum.notEquals");
  const toStringDef = nodeRegistry.get("enum.toString");
  const switchDef = nodeRegistry.get("enum.switch");
  const selectDef = nodeRegistry.get("enum.select");
  if (
    !makeDef ||
    !equalDef ||
    !notEqualDef ||
    !toStringDef ||
    !switchDef ||
    !selectDef
  ) {
    return [];
  }
  const rows: PaletteNode[] = [];
  for (const entry of options?.enums ?? []) {
    const defaultData: Record<string, unknown> = {
      enumGuid: entry.guid,
      members: entry.members,
      value: entry.members[0]?.name ?? "",
    };
    rows.push({
      id: `enum.make:${entry.guid}`,
      nodeType: "enum.make",
      title: `Make ${entry.name}`,
      category: makeDef.category,
      pins: makeDef.pins(defaultData),
      pure: makeDef.pure,
      latent: makeDef.latent,
      defaultData: { ...defaultData, title: `Make ${entry.name}` },
    });
    rows.push({
      id: `enum.equals:${entry.guid}`,
      nodeType: "enum.equals",
      title: `Equal ${entry.name}`,
      category: equalDef.category,
      searchAliases: equalDef.searchAliases,
      pins: equalDef.pins(defaultData),
      pure: equalDef.pure,
      latent: equalDef.latent,
      defaultData: { ...defaultData, title: `Equal ${entry.name}` },
    });
    rows.push({
      id: `enum.notEquals:${entry.guid}`,
      nodeType: "enum.notEquals",
      title: `Not Equal ${entry.name}`,
      category: notEqualDef.category,
      searchAliases: notEqualDef.searchAliases,
      pins: notEqualDef.pins(defaultData),
      pure: notEqualDef.pure,
      latent: notEqualDef.latent,
      defaultData: { ...defaultData, title: `Not Equal ${entry.name}` },
    });
    rows.push({
      id: `enum.toString:${entry.guid}`,
      nodeType: "enum.toString",
      title: `${entry.name} to String`,
      category: toStringDef.category,
      pins: toStringDef.pins(defaultData),
      pure: toStringDef.pure,
      latent: toStringDef.latent,
      defaultData: { ...defaultData, title: `${entry.name} to String` },
    });
    rows.push({
      id: `enum.switch:${entry.guid}`,
      nodeType: "enum.switch",
      title: `Switch on ${entry.name}`,
      category: switchDef.category,
      pins: switchDef.pins(defaultData),
      pure: switchDef.pure,
      latent: switchDef.latent,
      defaultData: { ...defaultData, title: `Switch on ${entry.name}` },
    });
    const selectData: Record<string, unknown> = {
      enumGuid: entry.guid,
      members: entry.members,
      "default:index": entry.members[0]?.name ?? "",
    };
    rows.push({
      id: `enum.select:${entry.guid}`,
      nodeType: "enum.select",
      title: `Select ${entry.name}`,
      category: selectDef.category,
      pins: selectDef.pins(selectData),
      pure: selectDef.pure,
      latent: selectDef.latent,
      defaultData: { ...selectData, title: `Select ${entry.name}` },
    });
  }
  return rows;
}

export type ScriptPaletteBuildOptions = {
  /** Default true. False returns host-legal catalog rows only (no injectors). */
  injectors?: boolean;
  cache?: ScriptPaletteCache;
};

/** Session-lifetime injector cache keyed by class-set / FL / member identity. */
export class ScriptPaletteCache {
  injectors = 0;
  private key: string | null = null;
  private rows: PaletteNode[] | null = null;

  getOrBuild(key: string, build: () => PaletteNode[]): PaletteNode[] {
    if (this.key === key && this.rows) return this.rows;
    this.injectors += 1;
    this.rows = build();
    this.key = key;
    return this.rows;
  }

  clear(): void {
    this.key = null;
    this.rows = null;
    this.injectors = 0;
  }
}

function graphPaletteMemberFingerprint(graph?: SerializedGraph): unknown {
  return {
    members: graph?.members ?? [],
    components: graph?.components ?? [],
    events: customEventRows(graph),
    functions: functionRows(graph),
    functionGraphs: Object.fromEntries(
      Object.entries(graph?.functionGraphs ?? {}).map(([id, slice]) => [
        id,
        slice.nodes.map((node) => ({
          type:
            typeof node.data.__nodeType === "string"
              ? node.data.__nodeType
              : node.type,
          async: node.data.async === true,
          functionName: node.data.functionName,
          classId: node.data.classId,
        })),
      ]),
    ),
  };
}

/** Identity for Cast/FL injectors — not graph pin or position data. */
export function scriptPaletteInjectorKey(
  options?: ScriptPaletteOptions,
): string {
  const parentOf =
    options?.parentOf ?? ((id: string) => engineParentOf(id) ?? null);
  const seed = [
    options?.classId,
    typeof options?.parentClass === "string" ? options.parentClass : null,
    ...Object.keys(options?.otherClassGraphs ?? {}),
    ...(options?.functionLibraries ?? []).map((lib) => lib.classId),
    ...(options?.sceneDocuments ?? []).map((scene) => sceneAssetClassId(scene.guid)),
  ].filter((id): id is string => Boolean(id));
  const classIds = [...knownClassIdSet(parentOf, seed)].sort((a, b) =>
    a.localeCompare(b),
  );
  const other = Object.entries(options?.otherClassGraphs ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, graph]) => [id, graphPaletteMemberFingerprint(graph)]);
  return JSON.stringify({
    parentClass: options?.parentClass ?? null,
    classId: options?.classId ?? null,
    assetType: options?.assetType ?? null,
    animationGraphHost: options?.animationGraphHost ?? null,
    activeFunctionId: options?.activeFunctionId ?? null,
    classes: classIds.map((id) => [id, parentOf(id) ?? null]),
    graph: graphPaletteMemberFingerprint(options?.graph),
    other,
    functionLibraries: options?.functionLibraries ?? [],
    scriptInterfaces: options?.scriptInterfaces ?? [],
    subsystemClasses: options?.subsystemClasses ?? [],
    structures: options?.structures ?? [],
    dataDefinitions: options?.dataDefinitions ?? [],
    saveGameDefinition: options?.saveGameDefinition,
    enums: options?.enums ?? [],
    inputAssets: options?.inputAssets ?? [],
    scenes: (options?.sceneDocuments ?? []).map((scene) => [
      scene.guid,
      scene.name,
      scene.actors.map((actor) => [
        actor.name,
        actor.components.map((component) => [component.id, component.classId]),
      ]),
    ]),
  });
}

function scriptPaletteCatalogNodes(
  nodeRegistry: NodeRegistry,
  options?: ScriptPaletteOptions,
): PaletteNode[] {
  return nodeRegistry
    .list()
    .filter((def) => {
      if ((def.id.startsWith("saveGame.") || def.id === "flow.event.gameLoaded" || def.id === "flow.event.saveMigration") && isEditorGraphHost(options ?? {})) return false;
      if ((def.id === "flow.event.gameLoaded" || def.id === "flow.event.saveMigration") && options?.activeFunctionId) return false;
      if (def.id === "flow.event.scalabilityChanged" && options?.activeFunctionId) return false;
      if ((isInputEvent(def.id) || def.id === "input.onAnyKeyPressed" || isTouchEventNodeType(def.id)) &&
        (options?.activeFunctionId || options?.animationGraphHost || !nativeEventStubs(options).some((node) => node.eventType === "flow.event.tick"))) return false;
      if (def.editorOnly && !isEditorGraphHost(options ?? {})) {
        return false;
      }
      if (options?.animationGraphHost === "rule" && def.pure !== true) {
        return false;
      }
      return isScriptCatalogNodeAllowed(def.id, options);
    })
    .map((def) => {
      const defaultData: Record<string, unknown> = {};
      if (def.id === "debug.log") {
        defaultData.message = "";
        defaultData.severity = "log";
        defaultData.category = "Script";
      }
      if (def.developmentOnlyByDefault) {
        defaultData.developmentOnly = true;
      }
      if (def.id === "string.format") {
        defaultData["default:format"] = "{input}";
      }
      const pins = def.pins(defaultData);
      if (def.editorOnly) defaultData.__editorOnly = true;
      return {
        id: def.id,
        title: def.title,
        description: def.description,
        category: def.category,
        searchAliases: def.searchAliases,
        pins,
        pure: def.pure,
        latent: def.latent,
        editorOnly: def.editorOnly,
        defaultData:
          Object.keys(defaultData).length > 0 ? defaultData : undefined,
      };
    });
}

function inputEventPaletteNodes(nodeRegistry: NodeRegistry, options?: ScriptPaletteOptions): PaletteNode[] {
  if (options?.activeFunctionId || options?.animationGraphHost || !nativeEventStubs(options).some((node) => node.eventType === "flow.event.tick")) return [];
  return (options?.inputAssets ?? []).flatMap((asset) => {
    const nodeType = asset.type === "InputAction" ? "input.actionEvent" : "input.axisEvent";
    const def = nodeRegistry.get(nodeType);
    if (!def) return [];
    const title = `Event ${asset.name}`;
    const defaultData = { "default:binding": { Input: { Name: asset.name, Asset: asset.guid } }, valueType: asset.valueType, title };
    return [{ id: `${nodeType}:${asset.guid}`, nodeType, title, category: def.category, pins: def.pins(defaultData), defaultData }];
  });
}

/**
 * Rows that need a Target on another object (other-class Get/Set/Call, engine
 * component APIs, scene-placed components) are not reachable from the host
 * graph on their own, so Add Node hides them while Context Sensitive is on
 * and no pin is being dragged. Rows owned by the host's own ancestry stay in
 * context: `self` is such an object even when the row keeps a Target pin.
 */
function markOutOfContext(
  nodes: PaletteNode[],
  options?: ScriptPaletteOptions,
): PaletteNode[] {
  const components = hostComponentAncestry(options);
  return nodes.map((node) => {
    if (node.defaultData?.implicitSelf !== false) return node;
    const owner = node.defaultData.classId;
    if (typeof owner === "string" && callImplicitSelf(owner, options)) {
      return node;
    }
    // A component the host actor owns (Movement on a character) is reachable
    // from its graph, so its API stays listed, still with a Target pin.
    if (typeof owner === "string" && components.has(owner)) return node;
    return { ...node, outOfContext: true };
  });
}

/** Classes (and their ancestors) of components on the host's own and inherited prefab. */
function hostComponentAncestry(options?: ScriptPaletteOptions): Set<string> {
  const result = new Set<string>();
  const localId = options?.classId;
  if (!localId) return result;
  const parentOf =
    options?.parentOf ?? ((id: string) => engineParentOf(id) ?? null);
  for (const classId of walkAncestry(localId, parentOf)) {
    const graph =
      classId === localId ? options?.graph : options?.otherClassGraphs?.[classId];
    for (const component of graph?.components ?? []) {
      for (const ancestor of walkAncestry(component.classId, parentOf)) {
        result.add(ancestor);
      }
    }
  }
  return result;
}

function scriptPaletteInjectorNodes(
  nodeRegistry: NodeRegistry,
  options?: ScriptPaletteOptions,
): PaletteNode[] {
  if (options?.animationGraphHost === "rule") {
    return markOutOfContext(
      [
        ...variableAccessPaletteNodes(nodeRegistry, options),
        ...structPaletteNodes(nodeRegistry, options),
        ...dataPaletteNodes(nodeRegistry, options),
        ...enumPaletteNodes(nodeRegistry, options),
      ].filter((node) => node.pure === true),
      options,
    );
  }
  return markOutOfContext(
    [
      ...inputEventPaletteNodes(nodeRegistry, options),
      ...callCustomEventPaletteNodes(nodeRegistry, options),
      ...callFunctionPaletteNodes(nodeRegistry, options),
      ...callInterfacePaletteNodes(nodeRegistry, options),
      ...variableAccessPaletteNodes(nodeRegistry, options),
      ...castPaletteNodes(nodeRegistry, options),
      ...subsystemGetPaletteNodes(nodeRegistry, options),
      ...structPaletteNodes(nodeRegistry, options),
      ...saveGamePaletteNodes(nodeRegistry, options),
      ...dataPaletteNodes(nodeRegistry, options),
      ...enumPaletteNodes(nodeRegistry, options),
    ],
    options,
  );
}

/** Palette rows for Class graphs (pins from the registry). */
export function scriptPaletteNodes(
  nodeRegistry: NodeRegistry = registry,
  options?: ScriptPaletteOptions,
  build: ScriptPaletteBuildOptions = {},
): PaletteNode[] {
  if (build.injectors === false) {
    return scriptPaletteCatalogNodes(nodeRegistry, options);
  }
  const assemble = () => [
    ...scriptPaletteCatalogNodes(nodeRegistry, options),
    ...scriptPaletteInjectorNodes(nodeRegistry, options),
  ];
  if (build.cache) {
    return build.cache.getOrBuild(scriptPaletteInjectorKey(options), assemble);
  }
  return assemble();
}
