/**
 * Class graph validation, and the stable import path for the editor's graph
 * services: hydration and materialization (`graph-hydration.ts`), per-node pin
 * refresh (`graph-node-refresh.ts`), default Class graphs
 * (`class-graph-defaults.ts`), the script palette (`script-palette.ts`,
 * `script-palette-members.ts`) and Class symbols (`graph-class-symbols.ts`).
 * Those modules never import this one, and none of them reads a binding
 * imported from a sibling module at load time: they sit on an import cycle
 * through `script-compiler.ts`, where such a read can meet an uninitialized
 * binding.
 */
import type { SerializedGraph } from "@haptic/core";
import { walkAncestry } from "@haptic/editor-kit";
import {
  validateGraphs,
  hasBlockingErrors,
  isLogicGraphPayload,
  knownGuidsFromSchemas,
  validateDataEntry,
  type ClassHierarchy,
  type ClassMemberSymbol,
  type Diagnostic,
  type InterfaceMethodContext,
  type ParentFunctionSignature,
  type LogicGraph,
  type TypeSchemas,
  diagnostic,
} from "@haptic/scripting";
import {
  engineEventTypeClassIds,
  subsystemBaseClassIdOf,
  subsystemClassIdsForGet,
  type SubsystemClassHierarchy,
} from "@haptic/object-model";
import { mergedPrefabViewsForGraph } from "../lib/component-graph-members";
import { collectParentEventNames } from "../lib/overridable-functions";
import {
  SUBSYSTEM_GET_NODE_ID,
  subsystemGetClassId,
  subsystemGetTitle,
} from "@haptic/scripting-nodes";
import { warnDebugTierConsoleCommands, warnReservedConsoleCommandNames } from "@haptic/debugger";
import {
  GET_GAME_INSTANCE_NODE_ID,
  isEditorUtilityChain,
  isLineageNativeEventAllowed,
  lineageNativeEventBases,
  nativeEventTitle,
} from "../lib/class-members";
import type { SubsystemClassEntry } from "../lib/logic-graph-document";
import { dataGraphMetadata, isDataGraphNode, type DataGraphAssetEntry } from "../lib/data-graph";
import { parentLookup } from "./graph-class-symbols";
import { defaultNodeRegistry as registry, materializeLogicGraph } from "./graph-hydration";
import {
  dataLiteralEntry,
  type HydrateGraphOptions,
  type InputPaletteAsset,
} from "./graph-node-refresh";

export {
  classHierarchyFromParentOf,
  classMemberSymbolsFromGraphs,
  knownClassIdSet,
  scriptPinCompatibility,
} from "./graph-class-symbols";
export type { HydrateGraphOptions, InputPaletteAsset } from "./graph-node-refresh";
export {
  bindUnboundComponentEvents,
  hydrateSerializedGraphForEditor,
  materializeLogicGraph,
} from "./graph-hydration";
export {
  createDefaultLogicGraphSerialized,
  requireClassGraphPayload,
} from "./class-graph-defaults";
export {
  ScriptPaletteCache,
  scriptPaletteInjectorKey,
  scriptPaletteNodes,
} from "./script-palette";
export type {
  PaletteSceneDocument,
  ScriptPaletteBuildOptions,
  ScriptPaletteOptions,
} from "./script-palette";

export type ValidateSerializedGraphOptions = {
  dataAssets?: readonly DataGraphAssetEntry[];
  inputAssets?: readonly InputPaletteAsset[];
  assetGuid: string;
  graphId: string;
  hierarchy?: ClassHierarchy;
  classId?: string;
  activeFunctionId?: string | null;
  members?: readonly ClassMemberSymbol[];
  knownClassIds?: ReadonlySet<string>;
  implementedInterfaces?: readonly InterfaceMethodContext[];
  parentFunctionSignatures?: readonly ParentFunctionSignature[];
  knownGuids?: ReadonlySet<string>;
  enums?: TypeSchemas["enums"];
  structs?: TypeSchemas["structs"];
  dataDefinitions?: TypeSchemas["dataDefinitions"];
  materialDomains?: Readonly<Record<string, string>>;
  parentOf?: (id: string) => string | null | undefined;
  otherClassGraphs?: Record<string, SerializedGraph>;
  attachedComponents?: ReadonlyArray<{ id: string; classId: string }>;
  eventTypeClassIds?: Readonly<Record<string, readonly string[]>>;
  parentEventNames?: ReadonlySet<string>;
  /**
   * Every project subsystem class; enables the Get <Subsystem> instance
   * checks (no instantiable class, more than one).
   */
  subsystemClasses?: readonly SubsystemClassEntry[];
};

function joinClassIds(classIds: readonly string[]): string {
  if (classIds.length <= 1) return classIds[0] ?? "";
  return `${classIds.slice(0, -1).join(", ")} or ${classIds[classIds.length - 1]}`;
}

/**
 * Host-lineage rules the palette also enforces, so pasted or stale nodes are
 * reported: lifecycle events outside their lineage, Get <Subsystem> classes
 * and both runtime getters in editor utility graphs.
 */
function hostLineageDiagnostics(
  graphs: readonly LogicGraph[],
  options: ValidateSerializedGraphOptions,
): Diagnostic[] {
  const parentOf = parentLookup(options.parentOf);
  const hierarchy: SubsystemClassHierarchy = {
    ancestry: (id) => walkAncestry(id, parentOf),
  };
  // A host the lookup does not know (an Animation Graph object, or a caller
  // without the project's parent lookup) has no lineage to check against.
  const classChain = options.classId
    ? walkAncestry(options.classId, parentOf)
    : [];
  const hostChain = classChain.length > 1 ? classChain : null;
  const editorHost = hostChain ? isEditorUtilityChain(hostChain) : false;
  const subsystemClassIds = options.subsystemClasses?.map(
    (entry) => entry.classId,
  );
  const out: Diagnostic[] = [];
  for (const graph of graphs) {
    const report = (code: string, message: string, nodeId: string) =>
      out.push(
        diagnostic({
          code,
          message,
          assetGuid: options.assetGuid,
          graphId: graph.id,
          nodeId,
        }),
      );
    for (const node of graph.nodes) {
      if (hostChain && !isLineageNativeEventAllowed(node.typeId, hostChain)) {
        report(
          "event.wrong_lineage",
          `${nativeEventTitle(node.typeId)} only runs on ${joinClassIds(
            lineageNativeEventBases(node.typeId),
          )} classes`,
          node.id,
        );
        continue;
      }
      if (node.typeId === GET_GAME_INSTANCE_NODE_ID && editorHost) {
        report(
          "gameInstance.editor_host",
          "Get Game Instance is not available in editor utility graphs",
          node.id,
        );
        continue;
      }
      if (node.typeId !== SUBSYSTEM_GET_NODE_ID) continue;
      const classId = subsystemGetClassId(node.properties);
      const title = subsystemGetTitle(classId);
      if (editorHost) {
        report(
          "subsystem.editor_host",
          `${title} is not available in editor utility graphs`,
          node.id,
        );
        continue;
      }
      if (!classId) {
        report("subsystem.missing_class", "Get Subsystem has no class", node.id);
        continue;
      }
      if (!subsystemBaseClassIdOf(hierarchy, classId)) {
        report(
          "subsystem.not_subsystem",
          `"${classId}" is not a GameSubsystem or SceneSubsystem class`,
          node.id,
        );
        continue;
      }
      if (!subsystemClassIds) continue;
      const leaves = subsystemClassIdsForGet(
        hierarchy,
        subsystemClassIds,
        classId,
      );
      if (leaves.length === 0) {
        report(
          "subsystem.no_instance",
          `${title} matches no subsystem class that is created at runtime`,
          node.id,
        );
      } else if (leaves.length > 1) {
        report(
          "subsystem.ambiguous",
          `${title} is ambiguous because more than one subsystem is created for it (${leaves.join(", ")}). Get one of those classes instead`,
          node.id,
        );
      }
    }
  }
  return out;
}

function dataGraphDiagnostics(
  graphs: readonly LogicGraph[],
  options: ValidateSerializedGraphOptions,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const assets = options.dataAssets && new Map(options.dataAssets.map((entry) => [entry.guid, entry]));
  for (const graph of graphs) {
    for (const node of graph.nodes) {
      if (!isDataGraphNode(node.typeId)) continue;
      const metadata = dataGraphMetadata(node.typeId)!;
      const guid = typeof node.properties.definitionGuid === "string" ? node.properties.definitionGuid.trim() : "";
      const report = (code: string, message: string, pinId?: string) => out.push(diagnostic({
        code, message, assetGuid: options.assetGuid, graphId: graph.id, nodeId: node.id, pinId,
      }));
      const grouping = node.typeId === "editorData.addEntry" && node.properties.definitionMode === "none";
      const needsDefinition = metadata.required || (node.typeId === "editorData.addEntry" && node.properties.definitionMode === "override");
      if (!guid && needsDefinition) {
        report("data.missing_definition", "Select a Data Definition in the node Inspector");
      } else if (!grouping && metadata.schema !== false && guid && options.dataDefinitions && !options.dataDefinitions[guid]) {
        report("data.unknown_definition", `The selected Data Definition '${guid}' is missing`);
      }
      const wired = (pinId: string) => graph.edges.some((edge) => edge.targetNodeId === node.id && edge.targetPinId === pinId);
      if ((node.typeId === "editorData.addEntry" || node.typeId === "editorData.updateEntry") &&
        !grouping && guid && options.dataDefinitions?.[guid] && !wired("values") && node.properties["default:values"] !== undefined) {
        const value = dataLiteralEntry(node.id, node.properties);
        if (!value) report("data.invalid-values", "Data entry values must be an object", "values");
        for (const issue of value ? validateDataEntry(value, guid, { structs: options.structs ?? {}, enums: options.enums ?? {}, dataDefinitions: options.dataDefinitions }) : []) {
          out.push(diagnostic({
            code: `data.${issue.code}`, message: issue.path ? `${issue.path}: ${issue.message}` : issue.message,
            severity: issue.severity, assetGuid: options.assetGuid, graphId: graph.id, nodeId: node.id, pinId: "values",
          }));
        }
      }
      const treeRef = node.properties["default:tree"];
      const tree = typeof treeRef === "string" ? assets?.get(treeRef) : undefined;
      if (node.typeId === "editorData.addEntry" && node.properties.definitionMode === "inherit" && guid) {
        const parentPath = node.properties["default:parentPath"] ?? "";
        const effective = !tree?.invalid && typeof parentPath === "string"
          ? parentPath === "" ? tree?.defaultDefinitionGuid : tree?.entries.find((entry) => entry.path === parentPath)?.effectiveDefinitionGuid
          : undefined;
        if (wired("tree") || wired("parentPath") || effective === undefined) {
          report("data.dynamic_inherited_values", "Typed inherited values need a known Tree and parent. Use Override for a dynamic Tree or Parent Path", "values");
        } else if (effective !== guid) {
          report("data.definition_mismatch", "The parent does not use the selected Data Definition. Select its Definition or use Override", "parentPath");
        }
      }
      if (!assets) continue;
      if (metadata.assetPin && !wired(metadata.assetPin) && typeof treeRef === "string" && treeRef) {
        if (!tree) report("data.missing_asset", `The selected Data Tree '${treeRef}' is missing`, "tree");
        else if (tree.invalid) report("data.invalid_tree", `The selected Data Tree '${tree.name}' has invalid hierarchy`, "tree");
      }
      if (!tree || tree.invalid || wired("tree")) continue;
      for (const pathPin of metadata.pathPins ?? []) {
        if (wired(pathPin.pinId)) continue;
        const path = node.properties[`default:${pathPin.pinId}`];
        if (typeof path !== "string" || (!path && pathPin.root)) continue;
        const entry = tree.entries.find((item) => item.path === path);
        if (!entry && path) {
          out.push(diagnostic({
            code: "data.missing_entry", message: `'${tree.name}' has no entry at '${path}'`, severity: "warning",
            assetGuid: options.assetGuid, graphId: graph.id, nodeId: node.id, pinId: pathPin.pinId,
          }));
        } else if (entry && metadata.definitionPath === pathPin.pinId && guid && entry.effectiveDefinitionGuid !== guid) {
          report("data.definition_mismatch", `'${path}' does not use the selected Data Definition`, pathPin.pinId);
        }
      }
    }
  }
  return out;
}

function attachedComponentsForGraph(
  content: SerializedGraph,
  options: ValidateSerializedGraphOptions,
): ReadonlyArray<{ id: string; classId: string }> {
  if (options.attachedComponents) return options.attachedComponents;
  return mergedPrefabViewsForGraph({
    graph: content,
    classId: options.classId,
    parentOf: options.parentOf,
    parentGraphs: options.otherClassGraphs,
  }).map((component) => ({ id: component.id, classId: component.classId }));
}

export function validateSerializedGraph(
  content: SerializedGraph | LogicGraph,
  options: ValidateSerializedGraphOptions,
): Diagnostic[] {
  const serialized = isLogicGraphPayload(content) ? undefined : content;
  const ctx = {
    assetGuid: options.assetGuid,
    hierarchy: options.hierarchy,
    classId: options.classId,
    activeFunctionId: options.activeFunctionId,
    members: options.members,
    knownClassIds: options.knownClassIds,
    implementedInterfaces: options.implementedInterfaces,
    parentFunctionSignatures: options.parentFunctionSignatures,
    knownGuids:
      options.knownGuids ??
      (options.enums || options.structs
        ? knownGuidsFromSchemas({
            enums: options.enums ?? {},
            structs: options.structs ?? {},
            dataDefinitions: options.dataDefinitions,
          })
        : undefined),
    enums: options.enums,
    structs: options.structs,
    dataDefinitions: options.dataDefinitions,
    materialDomains: options.materialDomains,
    attachedComponents: serialized
      ? attachedComponentsForGraph(serialized, options)
      : options.attachedComponents,
    eventTypeClassIds: options.eventTypeClassIds ?? engineEventTypeClassIds(),
    parentEventNames:
      options.parentEventNames ??
      (options.otherClassGraphs
        ? collectParentEventNames({
            classId: options.classId,
            parentOf: options.parentOf,
            parentGraphs: options.otherClassGraphs,
          })
        : undefined),
  };
  if (isLogicGraphPayload(content)) {
    return [
      ...validateGraphs([content], ctx, { registry }),
      ...hostLineageDiagnostics([content], options),
      ...dataGraphDiagnostics([content], options),
      ...warnDebugTierConsoleCommands([content], { assetGuid: options.assetGuid }),
      ...warnReservedConsoleCommandNames([content], { assetGuid: options.assetGuid }),
    ];
  }
  const typeOptions: HydrateGraphOptions = {
    dataAssets: options.dataAssets,
    inputAssets: options.inputAssets,
    enums: options.enums,
    structs: options.structs,
    dataDefinitions: options.dataDefinitions,
    // A Cast's Result kind follows the project Class hierarchy, as on the canvas.
    parentOf: options.parentOf,
  };
  const eventGraph = materializeLogicGraph(
    content,
    options.graphId,
    "event",
    typeOptions,
  );
  const graphs = [eventGraph];
  for (const [memberId, slice] of Object.entries(content.functionGraphs ?? {})) {
    graphs.push(
      materializeLogicGraph(
        { nodes: slice.nodes, edges: slice.edges },
        memberId,
        "function",
        typeOptions,
      ),
    );
  }
  return [
    ...validateGraphs(graphs, ctx, { registry }),
    ...hostLineageDiagnostics(graphs, options),
    ...dataGraphDiagnostics(graphs, options),
    ...warnDebugTierConsoleCommands(graphs, { assetGuid: options.assetGuid }),
    ...warnReservedConsoleCommandNames(graphs, { assetGuid: options.assetGuid }),
  ];
}

export function projectHasBlockingErrors(
  diagnostics: readonly Diagnostic[],
): boolean {
  return hasBlockingErrors(diagnostics);
}

export { registry as defaultNodeRegistry };
