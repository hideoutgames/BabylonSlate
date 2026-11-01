/**
 * Script palette options and the class-member injector rows: Call Custom Event,
 * Call Function, Call Interface, variable access, Cast and Get <Subsystem>.
 */
import {
  isEditorFunctionLibraryClass,
  isEditorGraphClass,
  isEditorGraphHost,
  isFunctionLibraryClass,
  type GraphClassMemberPin,
  type SerializedGraph,
  type SaveGameDefinition,
} from "@haptic/core";
import { engineParentOf, walkAncestry } from "@haptic/editor-kit";
import { isLatentFunctionKey, type NodeDefinition, type NodeRegistry } from "@haptic/scripting";
import {
  ENGINE_CLASS_SCRIPT_APIS,
  isHiddenEngineBaseClassId,
  isSceneLayerAssetClassId,
  sceneAssetClassId,
  type EngineScriptPin,
} from "@haptic/object-model";
import { componentGraphMembersForClass } from "../lib/component-graph-members";
import { prefabComponentLabel } from "../panels/add-component-catalog";
import {
  callInterfaceTitle,
  SUBSYSTEM_GET_NODE_ID,
  OWNED_ACTOR_GET_NODE_ID,
  OWNED_COMPONENT_GET_NODE_ID,
  OWNED_TIMELINE_CLIP_GET_NODE_ID,
  ownedActorGetTitle,
  ownedComponentGetTitle,
  ownedGetNodeProperties,
  ownedTimelineClipGetTitle,
  subsystemGetPaletteCategory,
  subsystemGetProperties,
  subsystemGetTitle,
} from "@haptic/scripting-nodes";
import type { PaletteNode } from "@haptic/graph-ui";
import {
  createEventNodeData,
  dispatcherEventNodeData,
  dispatcherNodeData,
  freeDispatcherEventName,
  isObjectInstanceVariableType,
  type ClassEventOptions,
} from "../lib/class-members";
import {
  CREATE_EVENT_NODE_TYPE_ID,
  DISPATCHER_NODE_TYPE_IDS,
  OUTPUT_DELEGATE_PIN_ID,
  type DispatcherNodeAction,
} from "@haptic/scripting-nodes";
import type {
  GraphEnumEntry,
  GraphStructureEntry,
  SubsystemClassEntry,
} from "../lib/logic-graph-document";
import {
  customEventRows,
  editorLatentFunctions,
  knownClassIdSet,
  parentLookup,
  type CustomEventRow,
} from "./graph-class-symbols";
import type { InputPaletteAsset } from "./graph-node-refresh";

export type ScriptPaletteOptions = ClassEventOptions & {
  saveGameDefinition?: SaveGameDefinition;
  inputAssets?: readonly InputPaletteAsset[];
  classId?: string;
  graph?: SerializedGraph;
  otherClassGraphs?: Record<string, SerializedGraph>;
  activeFunctionId?: string | null;
  functionLibraries?: Array<{
    classId: string;
    parentClass?: string | null;
    functions: Array<{ name: string; pins?: GraphClassMemberPin[] }>;
  }>;
  scriptInterfaces?: Array<{
    guid: string;
    name: string;
    methods: Array<{ name: string; pins?: GraphClassMemberPin[] }>;
  }>;
  structures?: readonly GraphStructureEntry[];
  dataDefinitions?: readonly GraphStructureEntry[];
  enums?: readonly GraphEnumEntry[];
  sceneDocuments?: readonly PaletteSceneDocument[];
  /** Project subsystem classes; each gets a Get <ClassId> row. */
  subsystemClasses?: readonly SubsystemClassEntry[];
  /**
   * A SceneScript's or SceneLayerScript's own actors: each gets a Get <Actor>
   * row and each of its components a Get <Component> (<Actor>) row.
   */
  ownedActors?: readonly PaletteOwnedActor[];
  /** The same owner's Timeline Clips: each gets a Get <Name> Timeline Clip row. */
  ownedTimelineClips?: readonly PaletteOwnedTimelineClip[];
};

/** A clip of the owner, its `TimelineClip:<document>:<clip>` class and the dispatchers its Custom Event Tracks declare. */
export type PaletteOwnedTimelineClip = {
  id: string;
  name: string;
  classId?: string;
  dispatchers?: ReadonlyArray<{ name: string; pins: GraphClassMemberPin[] }>;
};

export type PaletteOwnedActor = {
  id: string;
  name: string;
  classId: string;
  components: ReadonlyArray<{ id: string; classId: string; name?: string }>;
};

export type PaletteSceneDocument = {
  guid: string;
  name: string;
  actors: ReadonlyArray<{
    name: string;
    components: ReadonlyArray<{
      id: string;
      classId: string;
      properties?: Record<string, unknown>;
    }>;
  }>;
};

function otherClassAllowedOnHost(
  classId: string,
  options?: ScriptPaletteOptions,
): boolean {
  if (isEditorGraphHost(options ?? {})) return true;
  const parentOf =
    options?.parentOf ?? ((id: string) => engineParentOf(id) ?? null);
  return !isEditorGraphClass(classId, parentOf);
}

export function callImplicitSelf(
  eventClassId: string,
  options?: ScriptPaletteOptions,
): boolean {
  const localId = options?.classId;
  if (!localId) return false;
  if (localId === eventClassId) return true;
  const parentOf =
    options?.parentOf ?? ((id: string) => engineParentOf(id) ?? null);
  return walkAncestry(localId, parentOf).includes(eventClassId);
}

export function callCustomEventPaletteNodes(
  nodeRegistry: NodeRegistry,
  options?: ScriptPaletteOptions,
): PaletteNode[] {
  const def = nodeRegistry.get("flow.event.call");
  if (!def) return [];
  const localClassId = options?.classId ?? "Object";
  const localEvents = customEventRows(options?.graph);
  const localNames = new Set(localEvents.map((event) => event.name));
  const rows: Array<{
    classId: string;
    event: CustomEventRow;
    implicitSelf: boolean;
  }> = localEvents.map((event) => ({
    classId: localClassId,
    event,
    implicitSelf: true,
  }));
  for (const [classId, graph] of Object.entries(options?.otherClassGraphs ?? {})) {
    if (classId === localClassId) continue;
    if (!otherClassAllowedOnHost(classId, options)) continue;
    const implicitSelf = callImplicitSelf(classId, options);
    for (const event of customEventRows(graph)) {
      if (implicitSelf && localNames.has(event.name)) continue;
      rows.push({ classId, event, implicitSelf });
    }
  }
  return rows.map(({ classId, event, implicitSelf }) => {
    const defaultData: Record<string, unknown> = {
      name: event.name,
      classId,
      implicitSelf,
      pins: event.pins,
    };
    return {
      id: `flow.event.call:${classId}:${event.name}`,
      nodeType: "flow.event.call",
      title: `Call ${event.name}`,
      category: def.category,
      pins: def.pins(defaultData),
      pure: def.pure,
      latent: def.latent,
      defaultData,
    };
  });
}

type FunctionRow = {
  name: string;
  description?: string;
  searchAliases?: readonly string[];
  pins: GraphClassMemberPin[];
  runtime?: string;
  /** Stored literal defaults by input pin name for a newly placed node. */
  defaults?: Record<string, unknown>;
};

/**
 * Engine API scalar inputs start at their type default, like catalog nodes:
 * an unwired Yaw on Convert Input means 0 (and 2D ignores it), not a
 * missing-input warning.
 */
function engineScalarInputDefaults(
  pins: readonly EngineScriptPin[],
): Record<string, unknown> | undefined {
  const defaults: Record<string, unknown> = {};
  for (const pin of pins) {
    if (pin.direction !== "in" || (pin.container && pin.container !== "single")) continue;
    if (pin.defaultValue !== undefined) defaults[pin.name] = pin.defaultValue;
    else if (pin.typeId === "float" || pin.typeId === "int") defaults[pin.name] = 0;
    else if (pin.typeId === "bool") defaults[pin.name] = false;
  }
  return Object.keys(defaults).length > 0 ? defaults : undefined;
}

export function functionRows(graph?: SerializedGraph): FunctionRow[] {
  const byName = new Map<string, FunctionRow>();
  for (const member of graph?.members ?? []) {
    if (member.kind !== "function" || !member.name) continue;
    byName.set(member.name, {
      name: member.name,
      pins: member.pins ?? [],
    });
  }
  return [...byName.values()];
}

function paletteParentOf(
  options?: ScriptPaletteOptions,
): (id: string) => string | null | undefined {
  return parentLookup(options?.parentOf);
}

function isPaletteLibraryClass(
  classId: string,
  options?: ScriptPaletteOptions,
): boolean {
  const parentOf = paletteParentOf(options);
  if (isFunctionLibraryClass(classId, parentOf)) return true;
  if (
    classId === options?.classId &&
    isFunctionLibraryClass(options.parentClass, parentOf)
  ) {
    return true;
  }
  return (options?.functionLibraries ?? []).some((lib) => lib.classId === classId);
}

function skipEditorOnlyLibrary(
  classId: string,
  parentClass: string | null | undefined,
  options?: ScriptPaletteOptions,
): boolean {
  if (isEditorGraphHost(options ?? {})) return false;
  const parentOf = paletteParentOf(options);
  return (
    isEditorFunctionLibraryClass(classId, parentOf) ||
    isEditorFunctionLibraryClass(parentClass, parentOf)
  );
}

export function callFunctionPaletteNodes(
  nodeRegistry: NodeRegistry,
  options?: ScriptPaletteOptions,
): PaletteNode[] {
  const def = nodeRegistry.get("functions.call");
  if (!def) return [];
  const localClassId = options?.classId ?? "Object";
  const parentOf = paletteParentOf(options);
  const latentFunctions = editorLatentFunctions(nodeRegistry, {
    classId: localClassId,
    graph: options?.graph,
    otherClassGraphs: options?.otherClassGraphs,
    parentOf,
  });
  const localFunctions = functionRows(options?.graph);
  const localNames = new Set(localFunctions.map((entry) => entry.name));
  const rows: Array<{
    classId: string;
    fn: FunctionRow;
    implicitSelf: boolean;
    staticCall: boolean;
  }> = [];
  const seen = new Set<string>();
  const pushRow = (
    classId: string,
    fn: FunctionRow,
    implicitSelf: boolean,
    staticCall: boolean,
  ) => {
    const key = `${classId}:${fn.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ classId, fn, implicitSelf, staticCall });
  };
  const localIsLibrary = isPaletteLibraryClass(localClassId, options);
  if (!skipEditorOnlyLibrary(localClassId, options?.parentClass, options)) {
    for (const fn of localFunctions) {
      pushRow(localClassId, fn, true, localIsLibrary);
    }
  }
  for (const [classId, graph] of Object.entries(options?.otherClassGraphs ?? {})) {
    if (classId === localClassId) continue;
    if (!otherClassAllowedOnHost(classId, options)) continue;
    if (skipEditorOnlyLibrary(classId, undefined, options)) continue;
    const library = isPaletteLibraryClass(classId, options);
    const implicitSelf = library || callImplicitSelf(classId, options);
    for (const fn of functionRows(graph)) {
      if (implicitSelf && !library && localNames.has(fn.name)) continue;
      pushRow(classId, fn, implicitSelf, library);
    }
  }
  for (const api of ENGINE_CLASS_SCRIPT_APIS) {
    if (api.classId === localClassId) continue;
    if (api.classId === "GameInstance") continue;
    if (!otherClassAllowedOnHost(api.classId, options)) continue;
    for (const fn of api.functions ?? []) {
      pushRow(
        api.classId,
        {
          name: fn.name,
          description: fn.description,
          searchAliases: fn.searchAliases,
          pins: fn.pins.map((pin) => ({
            ...(pin.container ? { container: pin.container } : {}),
            name: pin.name,
            typeId: pin.typeId,
            direction: pin.direction,
            ...(pin.typeClassId ? { typeClassId: pin.typeClassId } : {}),
            ...(pin.container ? { container: pin.container } : {}),
          })),
          runtime: fn.runtime,
          defaults: engineScalarInputDefaults(fn.pins),
        },
        false,
        false,
      );
    }
  }
  for (const library of options?.functionLibraries ?? []) {
    if (skipEditorOnlyLibrary(library.classId, library.parentClass, options)) {
      continue;
    }
    if (
      !isPaletteLibraryClass(library.classId, options) &&
      !otherClassAllowedOnHost(library.classId, options)
    ) {
      continue;
    }
    for (const fn of library.functions) {
      pushRow(
        library.classId,
        { name: fn.name, pins: fn.pins ?? [] },
        true,
        true,
      );
    }
  }
  return rows.map(({ classId, fn, implicitSelf, staticCall }) => {
    const defaultData: Record<string, unknown> = {
      functionName: fn.name,
      classId,
      implicitSelf,
      pins: fn.pins,
    };
    if (staticCall) defaultData.static = true;
    if (fn.runtime) defaultData.runtime = fn.runtime;
    for (const [pinName, value] of Object.entries(fn.defaults ?? {})) {
      defaultData[`default:${pinName}`] = value;
    }
    return {
      id: `functions.call:${classId}:${fn.name}`,
      nodeType: "functions.call",
      title: `Call ${fn.name}`,
      description: fn.description,
      searchAliases: fn.searchAliases,
      category: def.category,
      pins: def.pins(defaultData),
      pure: def.pure,
      latent:
        def.latent === true ||
        isLatentFunctionKey(classId, fn.name, latentFunctions, parentOf),
      defaultData,
    };
  });
}

export function callInterfacePaletteNodes(
  nodeRegistry: NodeRegistry,
  options?: ScriptPaletteOptions,
): PaletteNode[] {
  const def = nodeRegistry.get("interface.call");
  if (!def) return [];
  const rows: PaletteNode[] = [];
  const seen = new Set<string>();
  for (const iface of options?.scriptInterfaces ?? []) {
    for (const method of iface.methods) {
      if (!method.name) continue;
      const key = `${iface.guid}:${method.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const pins = method.pins ?? [];
      const defaultData: Record<string, unknown> = {
        interfaceGuid: iface.guid,
        method: method.name,
        implicitSelf: true,
        pins,
        title: callInterfaceTitle(method.name),
      };
      rows.push({
        id: `interface.call:${iface.guid}:${method.name}`,
        nodeType: "interface.call",
        title: callInterfaceTitle(method.name),
        category: def.category,
        pins: def.pins(defaultData),
        pure: def.pure,
        latent: def.latent,
        defaultData,
      });
    }
  }
  return rows;
}

type VariableRow = {
  id: string;
  name: string;
  typeId: string;
  typeClassId?: string;
  container?: "single" | "array" | "map";
  keyTypeId?: string;
  keyTypeClassId?: string;
  scope: "member" | "local";
  functionId?: string;
  componentId?: string;
  propertyKey?: string;
};

function classVariableRows(graph?: SerializedGraph): VariableRow[] {
  const byName = new Map<string, VariableRow>();
  for (const member of graph?.members ?? []) {
    if (member.kind !== "variable" || !member.name || member.functionId) {
      continue;
    }
    byName.set(member.name, {
      id: member.id,
      name: member.name,
      typeId: member.typeId ?? "float",
      ...(member.typeClassId ? { typeClassId: member.typeClassId } : {}),
      ...(member.container === "array" || member.container === "map"
        ? { container: member.container }
        : {}),
      ...(member.keyTypeId ? { keyTypeId: member.keyTypeId } : {}),
      ...(member.keyTypeClassId ? { keyTypeClassId: member.keyTypeClassId } : {}),
      scope: "member",
    });
  }
  return [...byName.values()];
}

function localVariableRows(
  graph: SerializedGraph | undefined,
  functionId: string | null | undefined,
): VariableRow[] {
  if (!functionId) return [];
  const byName = new Map<string, VariableRow>();
  for (const member of graph?.members ?? []) {
    if (
      member.kind !== "variable" ||
      !member.name ||
      member.functionId !== functionId
    ) {
      continue;
    }
    byName.set(member.name, {
      id: member.id,
      name: member.name,
      typeId: member.typeId ?? "float",
      ...(member.typeClassId ? { typeClassId: member.typeClassId } : {}),
      ...(member.container === "array" || member.container === "map"
        ? { container: member.container }
        : {}),
      ...(member.keyTypeId ? { keyTypeId: member.keyTypeId } : {}),
      ...(member.keyTypeClassId ? { keyTypeClassId: member.keyTypeClassId } : {}),
      scope: "local",
      functionId,
    });
  }
  return [...byName.values()];
}

export function variableAccessPaletteNodes(
  nodeRegistry: NodeRegistry,
  options?: ScriptPaletteOptions,
): PaletteNode[] {
  const getDef = nodeRegistry.get("variables.get");
  const setDef = nodeRegistry.get("variables.set");
  const validatedDef = nodeRegistry.get("variables.getValidated");
  if (!getDef || !setDef) return [];
  const localClassId = options?.classId ?? "Object";
  const classVars = classVariableRows(options?.graph);
  const classNames = new Set(classVars.map((entry) => entry.name));
  const rows: Array<{
    classId: string;
    variable: VariableRow;
    implicitSelf: boolean;
    getOnly?: boolean;
  }> = classVars.map((variable) => ({
    classId: localClassId,
    variable,
    implicitSelf: true,
  }));
  // Inherited prefab components come from the parent Class graphs, which the
  // graph panel passes as `otherClassGraphs` (as hydrate and validate read them).
  for (const member of componentGraphMembersForClass({
    graph: options?.graph,
    classId: options?.classId,
    parentClass: options?.parentClass,
    parentOf: options?.parentOf,
    parentGraphs: options?.parentGraphs ?? options?.otherClassGraphs,
  })) {
    rows.push({
      classId: localClassId,
      variable: {
        id: member.id,
        name: member.name,
        typeId: member.typeId ?? "object",
        typeClassId: member.typeClassId,
        scope: "member",
        componentId: member.componentId,
      },
      implicitSelf: true,
      getOnly: true,
    });
  }
  for (const api of ENGINE_CLASS_SCRIPT_APIS) {
    if (api.classId === localClassId) continue;
    if (!otherClassAllowedOnHost(api.classId, options)) continue;
    for (const variable of api.variables ?? []) {
      rows.push({
        classId: api.classId,
        variable: {
          id: `engine:${api.classId}:var:${variable.propertyKey}`,
          name: variable.name,
          typeId: variable.typeId,
          typeClassId: variable.typeClassId,
          container: variable.container,
          scope: "member",
          propertyKey: variable.propertyKey,
        },
        implicitSelf: false,
        getOnly: variable.getOnly === true,
      });
    }
  }
  for (const row of scenePlacedComponentRows(options)) {
    rows.push(row);
  }
  for (const [classId, graph] of Object.entries(options?.otherClassGraphs ?? {})) {
    if (classId === localClassId) continue;
    if (!otherClassAllowedOnHost(classId, options)) continue;
    const implicitSelf = callImplicitSelf(classId, options);
    for (const variable of classVariableRows(graph)) {
      if (implicitSelf && classNames.has(variable.name)) continue;
      rows.push({ classId, variable, implicitSelf });
    }
  }
  for (const variable of localVariableRows(
    options?.graph,
    options?.activeFunctionId,
  )) {
    rows.push({
      classId: localClassId,
      variable,
      implicitSelf: true,
    });
  }
  const injected: PaletteNode[] = [];
  const accessKinds: Array<["get" | "set" | "validatedGet", typeof getDef]> =
    options?.animationGraphHost === "rule"
      ? [["get", getDef]]
      : [
          ["get", getDef],
          ["set", setDef],
        ];
  for (const { classId, variable, implicitSelf, getOnly } of rows) {
    const kinds = [...accessKinds].filter(
      ([access]) => !(getOnly && access === "set"),
    );
    if (
      validatedDef &&
      options?.animationGraphHost !== "rule" &&
      isObjectInstanceVariableType(variable.typeId, variable.container)
    ) {
      kinds.push(["validatedGet", validatedDef]);
    }
    for (const [access, def] of kinds) {
      const title =
        access === "set"
          ? `Set ${variable.name}`
          : access === "validatedGet"
            ? `Validated Get ${variable.name}`
            : `Get ${variable.name}`;
      const nodeType =
        access === "set"
          ? "variables.set"
          : access === "validatedGet"
            ? "variables.getValidated"
            : "variables.get";
      const defaultData: Record<string, unknown> = {
        variableName: variable.name,
        variableId: variable.id,
        typeId: variable.typeId,
        classId,
        implicitSelf,
        scope: variable.scope,
        title,
        ...(getOnly ? { getOnly: true } : {}),
      };
      if (variable.functionId) defaultData.functionId = variable.functionId;
      if (variable.typeClassId) defaultData.typeClassId = variable.typeClassId;
      if (variable.componentId) defaultData.componentId = variable.componentId;
      if (variable.propertyKey) defaultData.propertyKey = variable.propertyKey;
      if (variable.container === "array" || variable.container === "map") {
        defaultData.container = variable.container;
      }
      if (variable.container === "map") {
        defaultData.keyTypeId = variable.keyTypeId ?? "string";
        if (variable.keyTypeClassId) {
          defaultData.keyTypeClassId = variable.keyTypeClassId;
        }
      }
      injected.push({
        id: `${nodeType}:${classId}:${variable.name}`,
        nodeType,
        title,
        category: def.category,
        pins: def.pins(defaultData),
        pure: def.pure,
        latent: def.latent,
        defaultData,
      });
    }
  }
  return injected;
}

function uniquifyLabels(labels: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const label of labels) {
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return labels.map((label) => {
    if ((counts.get(label) ?? 0) < 2) return label;
    const next = (seen.get(label) ?? 0) + 1;
    seen.set(label, next);
    return next === 1 ? label : `${label} ${next}`;
  });
}

function scenePlacedComponentRows(
  options?: ScriptPaletteOptions,
): Array<{
  classId: string;
  variable: VariableRow;
  implicitSelf: boolean;
  getOnly?: boolean;
}> {
  const rows: Array<{
    classId: string;
    variable: VariableRow;
    implicitSelf: boolean;
    getOnly?: boolean;
  }> = [];
  for (const scene of options?.sceneDocuments ?? []) {
    const classId = sceneAssetClassId(scene.guid);
    // In its own SceneScript, Get <Component> (<Actor>) rows name these components.
    if (options?.ownedActors && classId === options.classId) continue;
    const entries = scene.actors.flatMap((actor) =>
      actor.components.map((component) => ({ actor, component })),
    );
    const classCounts = new Map<string, number>();
    for (const entry of entries) {
      classCounts.set(
        entry.component.classId,
        (classCounts.get(entry.component.classId) ?? 0) + 1,
      );
    }
    const labels = uniquifyLabels(
      entries.map(({ actor, component }) => {
        const typeLabel = prefabComponentLabel(component);
        return (classCounts.get(component.classId) ?? 0) > 1
          ? `${actor.name} ${typeLabel}`
          : typeLabel;
      }),
    );
    entries.forEach((entry, index) => {
      rows.push({
        classId,
        variable: {
          id: `scene:${scene.guid}:component:${entry.component.id}`,
          name: labels[index] ?? prefabComponentLabel(entry.component),
          typeId: "object",
          typeClassId: entry.component.classId,
          scope: "member",
          componentId: entry.component.id,
        },
        implicitSelf: false,
        getOnly: true,
      });
    });
  }
  return rows;
}

export function castPaletteNodes(
  nodeRegistry: NodeRegistry,
  options?: ScriptPaletteOptions,
): PaletteNode[] {
  const def = nodeRegistry.get("casting.cast");
  if (!def) return [];
  const parentOf = parentLookup(options?.parentOf);
  const sceneIds = (options?.sceneDocuments ?? []).map((scene) =>
    sceneAssetClassId(scene.guid),
  );
  const sceneTitles = new Map(
    (options?.sceneDocuments ?? []).map((scene) => [
      sceneAssetClassId(scene.guid),
      scene.name,
    ]),
  );
  const classIds = [
    ...knownClassIdSet(
      parentOf,
      [
        options?.classId,
        ...Object.keys(options?.otherClassGraphs ?? {}),
        ...sceneIds,
      ].filter((id): id is string => Boolean(id)),
    ),
  ]
    // A Scene Layer's script class is the layer itself, never a Cast target of its own script.
    .filter((classId) => !isHiddenEngineBaseClassId(classId) && !isSceneLayerAssetClassId(classId))
    .sort((a, b) => a.localeCompare(b));
  return classIds.map((classId) => {
    const defaultData: Record<string, unknown> = { "default:class": classId };
    const sceneName = sceneTitles.get(classId);
    return {
      id: `casting.cast:${classId}`,
      nodeType: "casting.cast",
      title: sceneName ? `Cast to ${sceneName}` : `Cast to ${classId}`,
      category: def.category,
      pins: def.pins(defaultData),
      pure: def.pure,
      latent: def.latent,
      defaultData,
    };
  });
}

/**
 * Get <Actor> and Get <Component> (<Actor>) rows for the actors a SceneScript's
 * Scene or a SceneLayerScript's layer places, in Outliner order, then one Get
 * <Name> Timeline Clip row per Timeline Clip.
 */
export function ownedGetPaletteNodes(
  nodeRegistry: NodeRegistry,
  options?: ScriptPaletteOptions,
): PaletteNode[] {
  const actorDef = nodeRegistry.get(OWNED_ACTOR_GET_NODE_ID);
  const componentDef = nodeRegistry.get(OWNED_COMPONENT_GET_NODE_ID);
  const clipDef = nodeRegistry.get(OWNED_TIMELINE_CLIP_GET_NODE_ID);
  if (!actorDef || !componentDef) return [];
  const clips: PaletteNode[] = clipDef
    ? (options?.ownedTimelineClips ?? []).map((clip) => {
        const data = { sceneTimelineClipId: clip.id, sceneTimelineClipName: clip.name, ...(clip.classId ? { sceneTimelineClipClassId: clip.classId } : {}) };
        return {
          id: `${OWNED_TIMELINE_CLIP_GET_NODE_ID}:${clip.id}`,
          nodeType: OWNED_TIMELINE_CLIP_GET_NODE_ID,
          title: ownedTimelineClipGetTitle(data),
          category: "scene-timeline-clips",
          pins: clipDef.pins(data),
          pure: clipDef.pure,
          latent: clipDef.latent,
          defaultData: data,
        };
      })
    : [];
  return [...ownedActorPaletteNodes(actorDef, componentDef, options), ...clips];
}

function ownedActorPaletteNodes(
  actorDef: NodeDefinition,
  componentDef: NodeDefinition,
  options?: ScriptPaletteOptions,
): PaletteNode[] {
  return (options?.ownedActors ?? []).flatMap((actor) => {
    const target = { actorId: actor.id, actorName: actor.name, actorClassId: actor.classId };
    const actorData = ownedGetNodeProperties(target);
    return [
      {
        id: `${OWNED_ACTOR_GET_NODE_ID}:${actor.id}`,
        nodeType: OWNED_ACTOR_GET_NODE_ID,
        title: ownedActorGetTitle(actorData),
        category: "scene-actors",
        pins: actorDef.pins(actorData),
        pure: actorDef.pure,
        latent: actorDef.latent,
        defaultData: { ...actorData },
      },
      ...actor.components.map((component) => {
        const data = ownedGetNodeProperties({
          ...target,
          componentId: component.id,
          componentName: component.name || prefabComponentLabel(component),
          componentClassId: component.classId,
        });
        return {
          id: `${OWNED_COMPONENT_GET_NODE_ID}:${actor.id}:${component.id}`,
          nodeType: OWNED_COMPONENT_GET_NODE_ID,
          title: ownedComponentGetTitle(data),
          category: "scene-actors",
          pins: componentDef.pins(data),
          pure: componentDef.pure,
          latent: componentDef.latent,
          defaultData: data,
        };
      }),
    ];
  });
}

/**
 * One pure Get <ClassId> row per project subsystem class (non-leaf bases
 * included). Editor utility graphs have no runtime subsystems.
 */
export function subsystemGetPaletteNodes(
  nodeRegistry: NodeRegistry,
  options?: ScriptPaletteOptions,
): PaletteNode[] {
  const def = nodeRegistry.get(SUBSYSTEM_GET_NODE_ID);
  if (!def || isEditorGraphHost(options ?? {})) return [];
  return (options?.subsystemClasses ?? []).map(({ classId, base }) => {
    const defaultData: Record<string, unknown> = {
      ...subsystemGetProperties(classId),
    };
    return {
      id: `${SUBSYSTEM_GET_NODE_ID}:${classId}`,
      nodeType: SUBSYSTEM_GET_NODE_ID,
      title: subsystemGetTitle(classId),
      category: subsystemGetPaletteCategory(base),
      pins: def.pins(defaultData),
      pure: def.pure,
      latent: def.latent,
      defaultData,
    };
  });
}

type DispatcherRow = {
  classId: string;
  name: string;
  pins: GraphClassMemberPin[];
  implicitSelf: boolean;
  /** Engine-declared (a Timeline Clip's): only the engine fires it, so there is no Call row. */
  engine?: boolean;
};

/** Event Dispatchers the host can reach: its own and inherited ones on Self, other Classes' on a Target. */
function dispatcherRows(options?: ScriptPaletteOptions): DispatcherRow[] {
  const localClassId = options?.classId ?? "Object";
  const rows: DispatcherRow[] = [];
  const seen = new Set<string>();
  const push = (classId: string, graph: SerializedGraph | undefined, implicitSelf: boolean) => {
    for (const member of graph?.members ?? []) {
      if (member.kind !== "dispatcher") continue;
      // A child cannot redeclare a dispatcher, so the nearest one names it.
      const key = implicitSelf ? `self:${member.name}` : `${classId}:${member.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ classId, name: member.name, pins: member.pins ?? [], implicitSelf });
    }
  };
  push(localClassId, options?.graph, true);
  for (const [classId, graph] of Object.entries(options?.otherClassGraphs ?? {})) {
    if (classId === localClassId) continue;
    if (!otherClassAllowedOnHost(classId, options)) continue;
    push(classId, graph, callImplicitSelf(classId, options));
  }
  for (const api of ENGINE_CLASS_SCRIPT_APIS) {
    if (!engineDispatchersReachable(api.classId, options)) continue;
    for (const dispatcher of api.dispatchers ?? []) {
      rows.push({ classId: api.classId, name: dispatcher.name, pins: dispatcher.pins.map((pin) => ({ ...pin })), implicitSelf: false, engine: true });
    }
  }
  // The owner's clips: one dispatcher per Custom Event Track, on the clip's own class.
  for (const clip of options?.ownedTimelineClips ?? []) {
    if (!clip.classId) continue;
    for (const dispatcher of clip.dispatchers ?? []) {
      rows.push({ classId: clip.classId, name: dispatcher.name, pins: dispatcher.pins.map((pin) => ({ ...pin })), implicitSelf: false, engine: true });
    }
  }
  return rows;
}

/**
 * Whether the host can hold an object of an engine class that declares
 * dispatchers, so its Bind rows belong in Add Node. A Timeline Clip comes only
 * from a SceneScript's or SceneLayerScript's Get <Name> Timeline Clip.
 */
function engineDispatchersReachable(classId: string, options?: ScriptPaletteOptions): boolean {
  if (classId === "TimelineClip") return (options?.ownedTimelineClips?.length ?? 0) > 0;
  return true;
}

const DISPATCHER_ACTIONS: readonly DispatcherNodeAction[] = ["call", "bind", "unbind", "unbindAll"];

/**
 * One Call, Bind, Unbind and Unbind All row per Event Dispatcher, plus
 * Unreal's Assign (a Bind node with a matching custom event wired to it). In
 * the Event Graph, rows that only make sense from a dragged delegate pin offer
 * a matching custom event or Create Event for it.
 */
export function dispatcherPaletteNodes(
  nodeRegistry: NodeRegistry,
  options?: ScriptPaletteOptions,
): PaletteNode[] {
  const bindDef = nodeRegistry.get(DISPATCHER_NODE_TYPE_IDS.bind);
  const eventDef = nodeRegistry.get("flow.event.custom");
  const createDef = nodeRegistry.get(CREATE_EVENT_NODE_TYPE_ID);
  if (!bindDef || !eventDef || !createDef) return [];
  const inEventGraph = !options?.activeFunctionId;
  const graph = options?.graph ?? { nodes: [], edges: [] };
  const nodes: PaletteNode[] = [];
  for (const row of dispatcherRows(options)) {
    const member = { name: row.name, pins: row.pins };
    const spawn = { classId: row.classId, implicitSelf: row.implicitSelf };
    for (const action of DISPATCHER_ACTIONS) {
      if (row.engine && action === "call") continue;
      const type = DISPATCHER_NODE_TYPE_IDS[action];
      const def = nodeRegistry.get(type);
      if (!def) continue;
      const defaultData = dispatcherNodeData(member, action, spawn);
      nodes.push({
        id: `${type}:${row.classId}:${row.name}`,
        nodeType: type,
        title: String(defaultData.title),
        description: def.description,
        category: def.category,
        pins: def.pins(defaultData),
        defaultData,
      });
    }
    if (!inEventGraph) continue;
    const eventName = freeDispatcherEventName(graph, row.name);
    const eventData = dispatcherEventNodeData(member, eventName);
    const eventNode: PaletteNode = {
      id: "flow.event.custom",
      title: String(eventData.title),
      category: eventDef.category,
      pins: eventDef.pins(eventData),
      pure: eventDef.pure,
      defaultData: eventData,
    };
    const bindData = dispatcherNodeData(member, "bind", spawn);
    nodes.push({
      id: `${DISPATCHER_NODE_TYPE_IDS.bind}:assign:${row.classId}:${row.name}`,
      nodeType: DISPATCHER_NODE_TYPE_IDS.bind,
      title: `Assign ${row.name}`,
      description: `Adds Bind Event to ${row.name} and a custom event with its inputs, wired together.`,
      category: bindDef.category,
      pins: bindDef.pins(bindData),
      defaultData: bindData,
      bundle: {
        nodes: [{ key: "event", node: eventNode, offset: { x: -40, y: 200 } }],
        edges: [{ source: "event", sourceHandle: OUTPUT_DELEGATE_PIN_ID, target: "main", targetHandle: "event" }],
      },
    });
    // From a dragged delegate pin only: a matching custom event, or Create Event for one.
    // The row names the action; the event it adds is named after the dispatcher.
    nodes.push({
      ...eventNode,
      id: `flow.event.custom:for:${row.classId}:${row.name}`,
      nodeType: "flow.event.custom",
      title: `Add Custom Event for ${row.name}`,
      nodeTitle: eventNode.title,
      outOfContext: true,
    });
    const createData = { ...createEventNodeData(row.pins), implicitSelf: true };
    nodes.push({
      id: `${CREATE_EVENT_NODE_TYPE_ID}:for:${row.classId}:${row.name}`,
      nodeType: CREATE_EVENT_NODE_TYPE_ID,
      title: `Create Event for ${row.name}`,
      category: createDef.category,
      pins: createDef.pins(createData),
      pure: true,
      defaultData: createData,
      outOfContext: true,
    });
  }
  return nodes;
}
