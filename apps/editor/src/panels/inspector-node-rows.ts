import { ANIM_POSE_CLIP_PICK, animPoseClipPatch, animPoseNodePropertyRows } from "../lib/anim-pose-inspector";
import type { SerializedGraph } from "@haptic/core";
import type { PropertyRow } from "@haptic/editor-kit";
import { pinDefaultPropertyKey } from "@haptic/scripting";
import {
  assetPickerAllowedTypes,
  connectedEnumGuidFromSerialized,
  containerConstructorPropertyRows,
  dataNodePathOptions,
  dataNodePropertyRows,
  developmentOnlyPropertyRows,
  enumNodePropertyRows,
  graphDataLiteralField,
  inputEventPropertyRows,
  inspectorLiteralPinDefaults,
  logNodePropertyRows,
  pinDefaultPropertyRows,
  sequencePropertyRows,
  structNodePropertyRows,
  tagNodePropertyRows,
} from "../lib/graph-inspector";
import { dataGraphAssetPickPatch } from "../lib/data-graph";
import { timelineProxyPickerRows, type TimelineScriptClipAsset } from "../lib/timeline-script-catalog";
import type { InspectorCatalogs } from "./use-inspector-catalogs";

type GraphNode = SerializedGraph["nodes"][number];

/** The pin whose default the Class picker fills, and the base Class it allows. */
export type ClassPinPick = { pinId: string; constraintClassId: string };
/** The pin whose default the asset picker fills, and the asset types it allows. */
export type AssetPinPick = { pinId: string; assetType: string; allowedTypes: string[] };

/** A node's Inspector PropertyGrid sections, in the order the Inspector shows them. */
export const GRAPH_NODE_ROW_SECTIONS = [
  { section: "inputEvent", testId: "inspector-input-event" },
  { section: "timelineProxy", testId: "inspector-timeline-proxy" },
  { section: "log", testId: "inspector-log-properties" },
  { section: "developmentOnly", testId: "inspector-development-only" },
  { section: "enum", testId: "inspector-enum-properties" },
  { section: "struct", testId: "inspector-struct-properties" },
  { section: "data", testId: "inspector-data-properties" },
  { section: "containerConstructor", testId: "inspector-container-constructor" },
  { section: "sequence", testId: "inspector-sequence" },
  { section: "tagCases", testId: "inspector-tag-cases" },
  { section: "animPose", testId: "inspector-anim-pose" },
] as const;

export type GraphNodeRowSection = (typeof GRAPH_NODE_ROW_SECTIONS)[number]["section"];

export interface GraphNodeRowsEnv {
  graph: SerializedGraph;
  inspectGraph: SerializedGraph | null;
  hydratedInspectGraph: SerializedGraph | null;
  catalogs: Pick<
    InspectorCatalogs,
    "dataAssets" | "enumMembers" | "objectClassEntries" | "pickerAssets" | "typeCatalog" | "typeSchemas"
  >;
  tags: ReadonlyArray<{ id: number; path: string }>;
  /** A Timeline Proxy node's clip asset. */
  proxyClip: TimelineScriptClipAsset | undefined;
  /** Merges a patch into this node's data. */
  updateNodeData: (patch: Record<string, unknown>) => void;
  onPickClass: (pick: ClassPinPick) => void;
  onPickAsset: (pick: AssetPinPick) => void;
}

/**
 * Everything a graph node's details build from the node: its PropertyGrid
 * sections, its pin Defaults (each keyed by pin id, pin type and row, so a
 * multi-selection shares only same-id, same-type pins), the defaults shown by
 * custom fields, and what a Class or asset pick writes for a pin.
 */
export function graphNodeInspectorRows(node: GraphNode, env: GraphNodeRowsEnv) {
  const { graph, inspectGraph, hydratedInspectGraph, catalogs, updateNodeData } = env;
  const { dataAssets, enumMembers, objectClassEntries, pickerAssets, typeCatalog, typeSchemas } = catalogs;
  const edges = inspectGraph?.edges ?? graph.edges;
  const dataPinWired = (pinId: string) =>
    edges.some((edge) => edge.target === node.id && edge.targetHandle === pinId);
  const literalDefaults = inspectorLiteralPinDefaults(node, edges, (hydratedInspectGraph ?? inspectGraph)?.nodes);
  const pathDefaults = literalDefaults.flatMap((entry) => {
    const options = dataNodePathOptions(node.type, entry.pinId, node.data, dataAssets, dataPinWired);
    return options ? [{ ...options, pin: entry }] : [];
  });
  const dataLiteralDefaults = literalDefaults.filter((entry) => graphDataLiteralField(entry, typeSchemas));
  const mapping = {
    enumMembers,
    classEntries: objectClassEntries,
    onPickClass: (pinId: string, constraintClassId: string) => env.onPickClass({ pinId, constraintClassId }),
    assetEntries: pickerAssets.map((asset) => ({ id: asset.guid, name: asset.name, type: asset.type })),
    onPickAsset: (pinId: string, assetType: string) =>
      env.onPickAsset({ pinId, assetType, allowedTypes: assetPickerAllowedTypes(assetType) }),
    schemas: typeSchemas,
  };
  const pinDefaults: PropertyRow[] = [];
  const pinDefaultKeys = new Map<PropertyRow, string>();
  for (const entry of literalDefaults) {
    if (graphDataLiteralField(entry, typeSchemas)) continue;
    if (pathDefaults.some((path) => path.pin.pinId === entry.pinId)) continue;
    if ((node.type === "input.actionEvent" || node.type === "input.axisEvent") && entry.pinId === "binding") continue;
    const type = JSON.stringify(entry.type);
    for (const row of pinDefaultPropertyRows([entry], updateNodeData, mapping)) {
      pinDefaultKeys.set(row, `${entry.pinId}\u0000${type}\u0000${row.id}`);
      pinDefaults.push(row);
    }
  }
  /** A Structure field inside a pin default writes through its own row, not as a pin. */
  const nestedPinDefaultRow = (rowId: string) =>
    literalDefaults.some((entry) => entry.pinId === rowId)
      ? undefined
      : pinDefaults.find((row) => row.id === rowId);

  const sections: Record<GraphNodeRowSection, PropertyRow[]> = {
    inputEvent: inputEventPropertyRows(node.type, node.data, updateNodeData, mapping.assetEntries, dataPinWired("binding")),
    timelineProxy: timelineProxyPickerRows(node.type, node.data, env.proxyClip, updateNodeData),
    log: node.type === "debug.log" ? logNodePropertyRows(node.data, updateNodeData) : [],
    developmentOnly: developmentOnlyPropertyRows(node.type, node.data, updateNodeData),
    enum: node.type.startsWith("enum.")
      ? enumNodePropertyRows(node.type, node.data, updateNodeData, {
          enums: typeCatalog.enums,
          // The wire lives in the graph being inspected (event or function).
          typeSelectDisabled: Boolean(
            connectedEnumGuidFromSerialized(hydratedInspectGraph ?? inspectGraph ?? graph, node.id),
          ),
        })
      : [],
    struct: structNodePropertyRows(node.type, node.data, updateNodeData, typeCatalog.structures, typeCatalog.dataDefinitions),
    data: dataNodePropertyRows(node.type, node.data, updateNodeData, typeCatalog.dataDefinitions),
    containerConstructor: containerConstructorPropertyRows(node.type, node.data, updateNodeData),
    sequence: sequencePropertyRows(node.type, node.data, updateNodeData),
    tagCases: tagNodePropertyRows(node.type, node.data, updateNodeData, env.tags),
    animPose: animPoseNodePropertyRows(node.type, node.data, updateNodeData, {
      assetEntries: mapping.assetEntries,
      onPickClip: (assetType) => env.onPickAsset({ pinId: ANIM_POSE_CLIP_PICK, assetType, allowedTypes: [assetType] }),
    }),
  };

  return {
    sections,
    pinDefaults,
    pinDefaultKeys,
    literalDefaults,
    pathDefaults,
    dataLiteralDefaults,
    /** Write a Class picked for `pinId`'s default. */
    pickClass: (pinId: string, classId: string) => {
      const nested = nestedPinDefaultRow(pinId);
      if (nested?.kind === "asset") nested.onChange(classId);
      else updateNodeData({ [pinDefaultPropertyKey(pinId)]: classId });
    },
    /** Write an asset picked (or None) for `pinId`'s default. */
    pickAsset: (pinId: string, guid: string | null) => {
      // A pose node's clip is its own setting, not a pin default.
      if (pinId === ANIM_POSE_CLIP_PICK) {
        updateNodeData(animPoseClipPatch(guid));
        return;
      }
      const nested = nestedPinDefaultRow(pinId);
      if (nested?.kind === "asset") nested.onChange(guid ?? "");
      else updateNodeData(dataGraphAssetPickPatch(node.type, pinId, guid, dataAssets, node.data, dataPinWired));
    },
  };
}
