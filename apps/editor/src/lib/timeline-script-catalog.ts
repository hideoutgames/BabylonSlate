import type { GraphClassMemberPin, SerializedGraph } from "@haptic/core";
import {
  TIMELINE_CLIP_BUILT_IN_DISPATCHERS,
  TIMELINE_REFIRED_CLIP_INPUT,
  timelineAssetGuidOf,
  timelineClassId,
  timelineClipClassId,
  timelineRefiredDispatcherName,
} from "@haptic/object-model";
import type { ClassMemberSymbol, Diagnostic } from "@haptic/scripting";
import {
  TIMELINE_FROM_ASSET_NODE_ID,
  TIMELINE_GET_CLIP_NODE_ID,
  timelineClipNodeProperties,
  timelineClipNodeTitle,
} from "@haptic/scripting-nodes";
import { ownedTimelineClipDispatcherSymbols, type OwnedTimelineClipEntry } from "./owned-actor-gets";
import { isSceneClipDocument, timelineAssetClips, type ProjectTimelineClip } from "./timeline-asset-index";

/** A scene clip a Timeline Asset holds, as scripts see it through the asset's Timeline. */
export type TimelineScriptClip = OwnedTimelineClipEntry & { documentGuid: string; documentName: string };

/**
 * A Timeline Asset as scripts see it: its `Timeline:<guid>` class, with one
 * Get <Name> Timeline Clip per scene clip and the clips' re-fired events.
 */
export type TimelineScriptAsset = { guid: string; name: string; classId: string; clips: TimelineScriptClip[] };

type TimelineAssetEntry = { header: { type: string; guid: string; name: string } };

/** Every Timeline Asset in the project, with the scene clips bound to it (`projectTimelineClips`). */
export function timelineScriptAssets(assets: readonly TimelineAssetEntry[], clips: readonly ProjectTimelineClip[]): TimelineScriptAsset[] {
  return assets.filter((asset) => asset.header.type === "Timeline").map(({ header }) => ({
    guid: header.guid,
    name: header.name,
    classId: timelineClassId(header.guid),
    // Scene clips have Get nodes; clip assets are reached by Create instead.
    clips: timelineAssetClips(clips, header.guid).filter((entry) => isSceneClipDocument(entry.documentKind)).map((entry) => ({
      id: entry.clip.id,
      name: entry.clip.name,
      classId: timelineClipClassId(entry.documentGuid, entry.clip.id),
      dispatchers: entry.clip.events.map((event) => ({
        name: event.name,
        pins: event.inputs.map((input) => ({ ...input, direction: "in" as const })),
      })),
      documentGuid: entry.documentGuid,
      documentName: entry.documentName,
    })),
  }));
}

/**
 * The dispatchers a Timeline re-fires: each clip's Custom Event Tracks, On
 * Finished and On Looped, named `<Event> (<Clip>)`, with the clip that fired
 * as the last input.
 */
export function timelineRefiredDispatchers(asset: TimelineScriptAsset): Array<{ name: string; pins: GraphClassMemberPin[] }> {
  return asset.clips.flatMap((clip) => {
    const clipPin: GraphClassMemberPin = { name: TIMELINE_REFIRED_CLIP_INPUT, typeId: "object", typeClassId: clip.classId, direction: "in" };
    const events = [...clip.dispatchers, ...TIMELINE_CLIP_BUILT_IN_DISPATCHERS.map((name) => ({ name, pins: [] as GraphClassMemberPin[] }))];
    return events.map((event) => ({ name: timelineRefiredDispatcherName(event.name, clip.name), pins: [...event.pins, clipPin] }));
  });
}

/** Dispatchers on each `Timeline:<guid>` class and on its clips' classes, for validation and Bind rows. */
export function timelineScriptSymbols(assets: readonly TimelineScriptAsset[]): ClassMemberSymbol[] {
  const timelines = assets.flatMap((asset) => timelineRefiredDispatchers(asset).map((dispatcher) => ({
    id: `timeline:${asset.classId}:${dispatcher.name}`,
    name: dispatcher.name,
    kind: "dispatcher" as const,
    classId: asset.classId,
    pins: dispatcher.pins,
  })));
  return [...timelines, ...ownedTimelineClipDispatcherSymbols(assets.flatMap((asset) => asset.clips))];
}

/** The `Timeline:<guid>` and `TimelineClip:<document>:<clip>` classes scripts can hold. */
export function timelineScriptClassIds(assets: readonly TimelineScriptAsset[]): string[] {
  return assets.flatMap((asset) => [asset.classId, ...asset.clips.map((clip) => clip.classId)]);
}

/** Node properties of a Get <Name> Timeline Clip on the asset's Timeline. */
export function timelineClipNodeData(asset: TimelineScriptAsset, clip: TimelineScriptClip): Record<string, string> {
  return {
    timelineAssetGuid: asset.guid,
    timelineClipDocument: clip.documentGuid,
    timelineClipId: clip.id,
    timelineClipName: clip.name,
    timelineClipClassId: clip.classId,
  };
}

function findClip(assets: readonly TimelineScriptAsset[], data: Record<string, unknown>) {
  const { assetGuid, documentGuid, clipId } = timelineClipNodeProperties(data);
  const asset = assets.find((entry) => entry.guid === assetGuid);
  return { asset, clip: asset?.clips.find((entry) => entry.documentGuid === documentGuid && entry.id === clipId) };
}

/**
 * Shows each Get <Name> Timeline Clip on a Timeline under its clip's current
 * name and class. Clips that left the asset keep their last names;
 * `timelineGraphDiagnostics` reports them.
 */
export function refreshTimelineClipNodes(graph: SerializedGraph, assets: readonly TimelineScriptAsset[]): SerializedGraph {
  let changed = false;
  const nodes = graph.nodes.map((node) => {
    if (node.type !== TIMELINE_GET_CLIP_NODE_ID) return node;
    const { asset, clip } = findClip(assets, node.data);
    if (!asset || !clip) return node;
    const data: Record<string, unknown> = { ...node.data, ...timelineClipNodeData(asset, clip) };
    data.title = timelineClipNodeTitle(data);
    if (Object.keys(data).every((key) => data[key] === node.data[key])) return node;
    changed = true;
    return { ...node, data };
  });
  return changed ? { ...graph, nodes } : graph;
}

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/**
 * `timeline.clip_not_in_asset` for a Get <Name> Timeline Clip whose clip left
 * its Timeline Asset, and `timeline.asset_empty` where a node or a variable's
 * default names a Timeline Asset that holds no clips.
 */
export function timelineGraphDiagnostics(
  graph: SerializedGraph,
  assets: readonly TimelineScriptAsset[],
  anchor: { assetGuid: string; graphId: string },
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const empty = (guid: string) => {
    const asset = guid ? assets.find((entry) => entry.guid === guid) : undefined;
    return asset && asset.clips.length === 0 ? asset : undefined;
  };
  const slices = [graph.nodes, ...Object.values(graph.functionGraphs ?? {}).map((slice) => slice.nodes)];
  for (const node of slices.flat()) {
    if (node.type === TIMELINE_GET_CLIP_NODE_ID) {
      const { asset, clip } = findClip(assets, node.data);
      if (clip) continue;
      const assetName = asset?.name ?? "its Timeline Asset";
      diagnostics.push({ ...anchor, severity: "error", code: "timeline.clip_not_in_asset", nodeId: node.id,
        message: `${timelineClipNodeTitle(node.data)}: the Timeline Clip is no longer in ${assetName}.` });
    } else if (node.type === TIMELINE_FROM_ASSET_NODE_ID) {
      const asset = empty(text(node.data["default:timelineAsset"]));
      if (asset) {
        diagnostics.push({ ...anchor, severity: "warning", code: "timeline.asset_empty", nodeId: node.id,
          message: `${asset.name} holds no Timeline Clips yet. Bind a clip to it in a Scene's or Scene Layer's Clips window.` });
      }
    }
  }
  for (const member of graph.members ?? []) {
    if (member.kind !== "variable" || member.typeId !== "asset" || member.typeClassId !== "Timeline") continue;
    const asset = empty(text(member.defaultValue));
    if (asset) {
      diagnostics.push({ ...anchor, severity: "warning", code: "timeline.asset_empty",
        message: `${member.name}: ${asset.name} holds no Timeline Clips yet.` });
    }
  }
  return diagnostics;
}

/** The Timeline Asset a `Timeline:<guid>` class names, for labels. */
export function timelineScriptAssetOf(assets: readonly TimelineScriptAsset[], classId: string): TimelineScriptAsset | undefined {
  const guid = timelineAssetGuidOf(classId);
  return guid ? assets.find((asset) => asset.guid === guid) : undefined;
}
