import { TIMELINE_CLIP_ASSET_CLIP_ID, type GraphClassMemberPin, type SerializedGraph, type TimelineClipProxySummary } from "@haptic/core";
import {
  TIMELINE_CLIP_BUILT_IN_DISPATCHERS,
  TIMELINE_REFIRED_CLIP_INPUT,
  timelineAssetGuidOf,
  timelineClassId,
  timelineClipClassId,
  timelineRefiredDispatcherName,
} from "@haptic/object-model";
import type { PropertyRow } from "@haptic/editor-kit";
import type { ClassMemberSymbol, Diagnostic } from "@haptic/scripting";
import {
  TIMELINE_CREATE_CLIP_NODE_ID,
  TIMELINE_FROM_ASSET_NODE_ID,
  TIMELINE_GET_CLIP_NODE_ID,
  TIMELINE_PROXY_BIND_ACTOR_NODE_ID,
  TIMELINE_PROXY_BIND_COMPONENT_NODE_ID,
  isTimelineProxyPickerNode,
  timelineClipNodeProperties,
  timelineClipNodeTitle,
  timelineCreateClipNodeTitle,
  timelineProxyNodeProperties,
  timelineProxyNodeTitle,
} from "@haptic/scripting-nodes";
import { ownedTimelineClipDispatcherSymbols, type OwnedTimelineClipEntry } from "./owned-actor-gets";
import { isSceneClipDocument, timelineAssetClips, type ProjectTimelineClip } from "./timeline-asset-index";

/** A scene clip a Timeline Asset holds, as scripts see it through the asset's Timeline. */
export type TimelineScriptClip = OwnedTimelineClipEntry & { documentGuid: string; documentName: string };

/** A 2D or 3D Timeline Clip asset a Timeline Asset holds: Create makes instances of its class. */
export type TimelineScriptClipAsset = TimelineScriptClip & { proxies: TimelineClipProxySummary[] };

/**
 * A Timeline Asset as scripts see it: its `Timeline:<guid>` class, with one
 * Get <Name> Timeline Clip per scene clip, one Create <Name> Timeline Clip
 * per clip asset, and every clip's re-fired events.
 */
export type TimelineScriptAsset = {
  guid: string;
  name: string;
  classId: string;
  clips: TimelineScriptClip[];
  clipAssets: TimelineScriptClipAsset[];
};

type TimelineAssetEntry = { header: { type: string; guid: string; name: string } };

/** Every Timeline Asset in the project, with the scene clips and clip assets bound to it (`projectTimelineClips`). */
export function timelineScriptAssets(assets: readonly TimelineAssetEntry[], clips: readonly ProjectTimelineClip[]): TimelineScriptAsset[] {
  return assets.filter((asset) => asset.header.type === "Timeline").map(({ header }) => {
    const bound = timelineAssetClips(clips, header.guid);
    return {
      guid: header.guid,
      name: header.name,
      classId: timelineClassId(header.guid),
      // Scene clips have Get nodes; clip assets are reached by Create instead.
      clips: bound.filter((entry) => isSceneClipDocument(entry.documentKind)).map(scriptClip),
      clipAssets: bound.filter((entry) => !isSceneClipDocument(entry.documentKind) && entry.clip.id === TIMELINE_CLIP_ASSET_CLIP_ID)
        .map((entry) => ({ ...scriptClip(entry), proxies: entry.clip.proxies ?? [] })),
    };
  });
}

function scriptClip(entry: ProjectTimelineClip): TimelineScriptClip {
  return {
    id: entry.clip.id,
    name: entry.clip.name,
    classId: timelineClipClassId(entry.documentGuid, entry.clip.id),
    dispatchers: entry.clip.events.map((event) => ({
      name: event.name,
      pins: event.inputs.map((input) => ({ ...input, direction: "in" as const })),
    })),
    documentGuid: entry.documentGuid,
    documentName: entry.documentName,
  };
}

/**
 * The dispatchers a Timeline re-fires: each clip's Custom Event Tracks, On
 * Finished and On Looped, named `<Event> (<Clip>)`, with the clip that fired
 * as the last input.
 */
export function timelineRefiredDispatchers(asset: TimelineScriptAsset): Array<{ name: string; pins: GraphClassMemberPin[] }> {
  return [...asset.clips, ...asset.clipAssets].flatMap((clip) => {
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
  return [...timelines, ...ownedTimelineClipDispatcherSymbols(assets.flatMap((asset) => [...asset.clips, ...asset.clipAssets]))];
}

/** The `Timeline:<guid>` and `TimelineClip:<document>:<clip>` classes scripts can hold. */
export function timelineScriptClassIds(assets: readonly TimelineScriptAsset[]): string[] {
  return assets.flatMap((asset) => [asset.classId, ...[...asset.clips, ...asset.clipAssets].map((clip) => clip.classId)]);
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

/** Node properties of a Create <Name> Timeline Clip on the asset's Timeline: the clip asset and its proxies' inputs. */
export function timelineCreateClipNodeData(asset: TimelineScriptAsset, clip: TimelineScriptClipAsset): Record<string, unknown> {
  return {
    ...timelineClipNodeData(asset, clip),
    timelineClipProxies: clip.proxies.map((proxy) => ({ ...proxy })),
  };
}

/** Node properties of a Bind, Unbind or Get Timeline Proxy node that picks `proxy` of `clip`. */
export function timelineProxyNodeData(clip: TimelineScriptClipAsset, proxy: TimelineClipProxySummary): Record<string, string> {
  return {
    timelineClipDocument: clip.documentGuid,
    timelineClipName: clip.name,
    timelineClipClassId: clip.classId,
    timelineProxyId: proxy.id,
    timelineProxyName: proxy.name,
    timelineProxyClassId: proxy.classId,
    timelineProxyRepresents: proxy.represents,
  };
}

/** The clip asset a proxy node names, and its picked proxy while the clip still has it. */
export function timelineProxyNodeTarget(assets: readonly TimelineScriptAsset[], data: Record<string, unknown>) {
  const { clipAssetGuid, proxyId } = timelineProxyNodeProperties(data);
  const clip = clipAssetGuid ? assets.flatMap((asset) => asset.clipAssets).find((entry) => entry.documentGuid === clipAssetGuid) : undefined;
  return { clip, proxy: proxyId ? clip?.proxies.find((entry) => entry.id === proxyId) : undefined };
}

/**
 * The Inspector's Proxy row for a Bind, Unbind or Get Timeline Proxy node:
 * the clip asset's proxies (a Bind node lists those of its kind). Picking one
 * renames, retypes and retitles the node.
 */
export function timelineProxyPickerRows(
  nodeType: string,
  data: Record<string, unknown>,
  clip: TimelineScriptClipAsset | undefined,
  onPatch: (patch: Record<string, unknown>) => void,
): PropertyRow[] {
  if (!isTimelineProxyPickerNode(nodeType)) return [];
  const { proxyId, proxyName } = timelineProxyNodeProperties(data);
  const proxies = (clip?.proxies ?? []).filter((proxy) => !proxyKindMismatch(nodeType, proxy));
  const options = proxies.map((proxy) => ({ value: proxy.id, label: proxy.name }));
  // A picked proxy that left the clip keeps its row, so the error names what to replace.
  if (proxyId && !options.some((option) => option.value === proxyId)) options.unshift({ value: proxyId, label: proxyName || proxyId });
  return [{
    kind: "enum",
    id: "timelineProxy",
    label: "Proxy",
    value: proxyId,
    options,
    onChange: (value) => {
      const proxy = proxies.find((entry) => entry.id === value);
      if (!clip || !proxy) return;
      const next = { ...data, ...timelineProxyNodeData(clip, proxy) };
      onPatch({ ...timelineProxyNodeData(clip, proxy), title: timelineProxyNodeTitle(nodeType, next) });
    },
  }];
}

/** Whether a Bind node's kind cannot take `proxy` (Bind Actor on a Component proxy, or the other way round). */
function proxyKindMismatch(nodeType: string, proxy: TimelineClipProxySummary): boolean {
  return (nodeType === TIMELINE_PROXY_BIND_ACTOR_NODE_ID && proxy.represents !== "actor")
    || (nodeType === TIMELINE_PROXY_BIND_COMPONENT_NODE_ID && proxy.represents !== "component");
}

function findClip(assets: readonly TimelineScriptAsset[], data: Record<string, unknown>, create: boolean) {
  const { assetGuid, documentGuid, clipId } = timelineClipNodeProperties(data);
  const asset = assets.find((entry) => entry.guid === assetGuid);
  const clips: readonly TimelineScriptClip[] = (create ? asset?.clipAssets : asset?.clips) ?? [];
  return { asset, clip: clips.find((entry) => entry.documentGuid === documentGuid && entry.id === clipId) };
}

const sameValue = (a: unknown, b: unknown) => a === b || (Array.isArray(a) && JSON.stringify(a) === JSON.stringify(b));

/**
 * Shows each Get <Name> Timeline Clip and Create <Name> Timeline Clip on a
 * Timeline under its clip's current name and class, a Create node with an
 * input per current proxy. Clips that left the asset keep their last names;
 * `timelineGraphDiagnostics` reports them.
 */
export function refreshTimelineClipNodes(graph: SerializedGraph, assets: readonly TimelineScriptAsset[]): SerializedGraph {
  let changed = false;
  const nodes = graph.nodes.map((node) => {
    if (isTimelineProxyPickerNode(node.type)) {
      // A proxy node follows its proxy's rename and Class; a removed proxy keeps its last names.
      const { clip, proxy } = timelineProxyNodeTarget(assets, node.data);
      if (!clip || !proxy) return node;
      const data: Record<string, unknown> = { ...node.data, ...timelineProxyNodeData(clip, proxy) };
      data.title = timelineProxyNodeTitle(node.type, data);
      if (Object.keys(data).every((key) => data[key] === node.data[key])) return node;
      changed = true;
      return { ...node, data };
    }
    const create = node.type === TIMELINE_CREATE_CLIP_NODE_ID;
    if (!create && node.type !== TIMELINE_GET_CLIP_NODE_ID) return node;
    const { asset, clip } = findClip(assets, node.data, create);
    if (!asset || !clip) return node;
    const data: Record<string, unknown> = create
      ? { ...node.data, ...timelineCreateClipNodeData(asset, clip as TimelineScriptClipAsset) }
      : { ...node.data, ...timelineClipNodeData(asset, clip) };
    data.title = create ? timelineCreateClipNodeTitle(data) : timelineClipNodeTitle(data);
    if (Object.keys(data).every((key) => sameValue(data[key], node.data[key]))) return node;
    changed = true;
    return { ...node, data };
  });
  return changed ? { ...graph, nodes } : graph;
}

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/**
 * `timeline.clip_not_in_asset` for a Get or Create <Name> Timeline Clip whose
 * clip left its Timeline Asset, and `timeline.asset_empty` where a node or a variable's
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
    return asset && asset.clips.length === 0 && asset.clipAssets.length === 0 ? asset : undefined;
  };
  const slices = [graph.nodes, ...Object.values(graph.functionGraphs ?? {}).map((slice) => slice.nodes)];
  for (const node of slices.flat()) {
    if (isTimelineProxyPickerNode(node.type)) {
      const { clip, proxy } = timelineProxyNodeTarget(assets, node.data);
      const { clipName, proxyName } = timelineProxyNodeProperties(node.data);
      const title = timelineProxyNodeTitle(node.type, node.data);
      if (!proxy) {
        diagnostics.push({ ...anchor, severity: "error", code: "timeline.proxy_member_missing", nodeId: node.id,
          message: proxyName
            ? `${title}: ${clip?.name ?? (clipName || "its Timeline Clip asset")} has no ${proxyName} proxy any more.`
            : `${title}: pick a proxy in the Inspector.` });
      } else if (proxyKindMismatch(node.type, proxy)) {
        diagnostics.push({ ...anchor, severity: "error", code: "timeline.proxy_kind_mismatch", nodeId: node.id,
          message: `${title}: ${proxy.name} stands in for ${proxy.represents === "actor" ? "an actor" : "a component"}. Use Bind ${proxy.represents === "actor" ? "Actor" : "Component"} to Timeline Proxy.` });
      }
      continue;
    }
    if (node.type === TIMELINE_GET_CLIP_NODE_ID || node.type === TIMELINE_CREATE_CLIP_NODE_ID) {
      const create = node.type === TIMELINE_CREATE_CLIP_NODE_ID;
      const { asset, clip } = findClip(assets, node.data, create);
      if (clip) continue;
      const assetName = asset?.name ?? "its Timeline Asset";
      const title = create ? timelineCreateClipNodeTitle(node.data) : timelineClipNodeTitle(node.data);
      diagnostics.push({ ...anchor, severity: "error", code: "timeline.clip_not_in_asset", nodeId: node.id,
        message: `${title}: the Timeline Clip is no longer in ${assetName}.` });
    } else if (node.type === TIMELINE_FROM_ASSET_NODE_ID) {
      const asset = empty(text(node.data["default:timelineAsset"]));
      if (asset) {
        diagnostics.push({ ...anchor, severity: "warning", code: "timeline.asset_empty", nodeId: node.id,
          message: `${asset.name} holds no Timeline Clips yet. Bind a clip to it in a Scene's or Scene Layer's Clips window, or create a 2D or 3D Timeline Clip asset for it.` });
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
