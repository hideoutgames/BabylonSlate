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
import { isLatentFunctionKey, type NodeRegistry } from "@haptic/scripting";
import {
  ENGINE_CLASS_SCRIPT_APIS,
  isHiddenEngineBaseClassId,
  sceneAssetClassId,
  type EngineScriptPin,
} from "@haptic/object-model";
import { componentGraphMembersForClass } from "../lib/component-graph-members";
import { prefabComponentLabel } from "../panels/add-component-catalog";
import {
  callInterfaceTitle,
  SUBSYSTEM_GET_NODE_ID,
  subsystemGetPaletteCategory,
  subsystemGetProperties,
  subsystemGetTitle,
} from "@haptic/scripting-nodes";
import type { PaletteNode } from "@haptic/graph-ui";
import { isObjectInstanceVariableType, type ClassEventOptions } from "../lib/class-members";
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
    .filter((classId) => !isHiddenEngineBaseClassId(classId))
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
