import { TIMELINE_CLIPS_META, type TimelineClipSummary } from "./timeline-assets";
import {
  createTimelineClip,
  normalizeTimelineClip,
  type SerializedTimelineClip,
  type TimelineEventTrack,
  type TimelineFrameRate,
  type TimelineLoopMode,
  type TimelinePropertyTrack,
  type TimelineWhenFinished,
} from "./timeline-clips";

/**
 * 2D and 3D Timeline Clip assets: one clip in its own file, animating Proxies
 * (typed stand-ins for an Actor or a Component) that each runtime instance
 * binds to real objects. The two types never convert into each other.
 */
export const TIMELINE_CLIP_ASSET_TYPES = ["TimelineClip2D", "TimelineClip3D"] as const;
export type TimelineClipAssetType = (typeof TIMELINE_CLIP_ASSET_TYPES)[number];

export function isTimelineClipAssetType(type: string | undefined): type is TimelineClipAssetType {
  return type === "TimelineClip2D" || type === "TimelineClip3D";
}

export type TimelineProxyRepresents = "actor" | "component";

export interface TimelineProxy {
  /** Stable; the clip's object track for the proxy uses it as its actor id. */
  id: string;
  /** Unique in the clip; names the proxy's Create input and Bind nodes. */
  name: string;
  represents: TimelineProxyRepresents;
  /** An Actor or ActorComponent subclass, engine or project; its properties are the proxy's tracks. */
  classId: string;
  tracks: TimelinePropertyTrack[];
}

export const TIMELINE_PROXY_REPRESENTATIONS = ["outline", "model", "material", "texture", "class"] as const;
export type TimelineProxyRepresentation = (typeof TIMELINE_PROXY_REPRESENTATIONS)[number];
export type TimelineProxyPreviewAs = "relative" | "absolute";
/** The representations that draw a picked asset. */
export type TimelineProxyAssetRepresentation = "model" | "material" | "texture";
const ASSET_REPRESENTATIONS: readonly TimelineProxyAssetRepresentation[] = ["model", "material", "texture"];

/** How the editor draws a proxy. Editor only: never in Play or an export. */
export interface TimelineProxyPreview {
  /** `#rrggbb`. */
  color: string;
  representation: TimelineProxyRepresentation;
  /** Where the proxy stands in the preview; Relative keys offset it. */
  location: [number, number, number];
  /** Degrees: pitch, yaw, roll. */
  rotation: [number, number, number];
  /** The proxy's size: an Outline is one metre (3D) or unit (2D) at 1, a Model, Material or Texture its own size. Relative Scale keys multiply it. */
  scale: [number, number, number];
  previewAs: TimelineProxyPreviewAs;
  /**
   * The Model, Material and Texture picked for those representations, kept
   * while another representation is shown. Editor-only references.
   */
  assets?: Partial<Record<TimelineProxyAssetRepresentation, string>>;
}

/** The asset the proxy's current representation draws, if it draws one and one is picked. */
export function timelineProxyPreviewAsset(preview: TimelineProxyPreview): string | undefined {
  const representation = preview.representation as TimelineProxyAssetRepresentation;
  return ASSET_REPRESENTATIONS.includes(representation) ? preview.assets?.[representation] : undefined;
}

export interface SerializedTimelineClipAsset {
  /** Required: the Timeline Asset that holds the clip and through which scripts reach it. */
  timelineAsset: string;
  length: number;
  frameRate: TimelineFrameRate;
  playRate: number;
  loopMode: TimelineLoopMode;
  whenFinished: TimelineWhenFinished;
  proxies: TimelineProxy[];
  eventTracks: TimelineEventTrack[];
  /** Editor-only section, stripped from Play and export (`stripTimelineClipAssetEditorData`). */
  editorPreview?: { proxies: Record<string, TimelineProxyPreview> };
}

/** The colours new proxies take in turn. */
export const TIMELINE_PROXY_COLORS = ["#f97316", "#22d3ee", "#a3e635", "#e879f9", "#facc15", "#60a5fa", "#f87171", "#34d399"] as const;

/** The clip a clip asset holds always has this id; its name is the asset's name. */
export const TIMELINE_CLIP_ASSET_CLIP_ID = "clip";

export function createDefaultTimelineClipAsset(timelineAsset = ""): SerializedTimelineClipAsset {
  const { length, frameRate, playRate, loopMode, whenFinished } = createTimelineClip(TIMELINE_CLIP_ASSET_CLIP_ID, "");
  return { timelineAsset, length, frameRate, playRate, loopMode, whenFinished, proxies: [], eventTracks: [] };
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const finite = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
const triple = (value: unknown, fallback: [number, number, number]): [number, number, number] =>
  Array.isArray(value) && value.length === 3 && value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
    ? [value[0], value[1], value[2]]
    : fallback;

/** The default look of the `index`th proxy. */
export function defaultTimelineProxyPreview(index: number): TimelineProxyPreview {
  return {
    color: TIMELINE_PROXY_COLORS[index % TIMELINE_PROXY_COLORS.length]!,
    representation: "outline",
    location: [index * 2, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    previewAs: "relative",
  };
}

function normalizePreview(value: unknown, index: number, represents: TimelineProxy["represents"]): TimelineProxyPreview {
  const source = record(value);
  const fallback = defaultTimelineProxyPreview(index);
  const color = text(source.color);
  const representation = (TIMELINE_PROXY_REPRESENTATIONS as readonly string[]).includes(source.representation as string)
    ? (source.representation as TimelineProxyRepresentation)
    : "outline";
  // An earlier preview sized the representation alone by a uniform Size. An Actor proxy's Scale takes it (it draws
  // nothing else); a Component proxy's would also scale its component, so there it goes.
  const size = representation === "class" || represents === "component" ? 1 : Math.max(0.01, finite(source.size, 1));
  const authoredAssets = record(source.assets);
  const assets: Partial<Record<TimelineProxyAssetRepresentation, string>> = {};
  for (const kind of ASSET_REPRESENTATIONS) {
    const guid = text(authoredAssets[kind]);
    if (guid) assets[kind] = guid;
  }
  // An earlier preview kept one asset, for its representation.
  const legacyAsset = text(source.assetGuid);
  const legacyKind = representation as TimelineProxyAssetRepresentation;
  if (legacyAsset && ASSET_REPRESENTATIONS.includes(legacyKind) && !assets[legacyKind]) assets[legacyKind] = legacyAsset;
  return {
    color: /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : fallback.color,
    representation,
    location: triple(source.location, fallback.location),
    rotation: triple(source.rotation, fallback.rotation),
    scale: triple(source.scale, [size, size, size]),
    previewAs: source.previewAs === "absolute" ? "absolute" : "relative",
    ...(Object.keys(assets).length ? { assets } : {}),
  };
}

/**
 * A clip asset payload, read the way the shared clip normalizer reads a
 * scene clip: tracks and keys are checked, proxies need an id, a name and a
 * class, and repeated proxy ids are dropped. Every proxy gets a preview.
 */
export function normalizeTimelineClipAsset(value: unknown): SerializedTimelineClipAsset {
  const source = record(value);
  const ids = new Set<string>();
  const rawProxies = (Array.isArray(source.proxies) ? source.proxies : []).flatMap((entry) => {
    const proxy = record(entry);
    const id = text(proxy.id);
    const classId = text(proxy.classId);
    if (!id || !classId || ids.has(id)) return [];
    ids.add(id);
    return [{ id, name: text(proxy.name) || classId, represents: proxy.represents === "component" ? "component" as const : "actor" as const, classId, tracks: proxy.tracks }];
  });
  // The shared normalizer checks tracks and keys, with each proxy as an object track.
  const clip = normalizeTimelineClip({
    ...source,
    id: TIMELINE_CLIP_ASSET_CLIP_ID,
    name: "Clip",
    objects: rawProxies.map((proxy) => ({ id: proxy.id, actorId: proxy.id, tracks: proxy.tracks })),
  })!;
  const tracksOf = new Map(clip.objects.map((object) => [object.actorId, object.tracks]));
  const proxies: TimelineProxy[] = rawProxies.map((proxy) => ({
    id: proxy.id, name: proxy.name, represents: proxy.represents, classId: proxy.classId, tracks: tracksOf.get(proxy.id) ?? [],
  }));
  const previews = record(record(source.editorPreview).proxies);
  return {
    timelineAsset: text(source.timelineAsset),
    length: clip.length,
    frameRate: clip.frameRate,
    playRate: clip.playRate,
    loopMode: clip.loopMode,
    whenFinished: clip.whenFinished,
    proxies,
    eventTracks: clip.eventTracks,
    editorPreview: { proxies: Object.fromEntries(proxies.map((proxy, index) => [proxy.id, normalizePreview(previews[proxy.id], index, proxy.represents)])) },
  };
}

/** The payload Play and an export see: the editor-only preview section is gone. */
export function stripTimelineClipAssetEditorData(payload: SerializedTimelineClipAsset): SerializedTimelineClipAsset {
  const rest = { ...payload };
  delete rest.editorPreview;
  return rest;
}

/**
 * The asset's clip in the shared clip shape, so the Timeline panel and the
 * evaluator edit and play it unchanged: each proxy is an object track whose
 * actor id is the proxy id. A clip asset never Auto Plays.
 */
export function timelineClipOfAsset(payload: SerializedTimelineClipAsset, name: string): SerializedTimelineClip {
  return {
    ...createTimelineClip(TIMELINE_CLIP_ASSET_CLIP_ID, name),
    length: payload.length,
    frameRate: payload.frameRate,
    playRate: payload.playRate,
    loopMode: payload.loopMode,
    whenFinished: payload.whenFinished,
    ...(payload.timelineAsset ? { timelineAsset: payload.timelineAsset } : {}),
    objects: payload.proxies.map((proxy) => ({ id: proxy.id, actorId: proxy.id, tracks: proxy.tracks })),
    eventTracks: payload.eventTracks,
  };
}

/**
 * Writes an edited clip back: settings, event tracks, and each proxy's tracks
 * from its object track. Proxies keep their order and settings; an object
 * track without a proxy is dropped.
 */
export function withTimelineClipOfAsset(payload: SerializedTimelineClipAsset, clip: SerializedTimelineClip): SerializedTimelineClipAsset {
  const tracksOf = new Map(clip.objects.map((object) => [object.actorId, object.tracks]));
  return {
    ...payload,
    length: clip.length,
    frameRate: clip.frameRate,
    playRate: clip.playRate,
    loopMode: clip.loopMode,
    whenFinished: clip.whenFinished,
    eventTracks: clip.eventTracks,
    proxies: payload.proxies.map((proxy) => ({ ...proxy, tracks: tracksOf.get(proxy.id) ?? [] })),
  };
}

/** What a clip asset's header says about its clip, in the shape Scene headers use (`TIMELINE_CLIPS_META`). */
export function timelineClipAssetSummaries(payload: SerializedTimelineClipAsset, name: string): Record<string, unknown> {
  const summary: TimelineClipSummary = {
    id: TIMELINE_CLIP_ASSET_CLIP_ID,
    name,
    ...(payload.timelineAsset ? { timelineAsset: payload.timelineAsset } : {}),
    length: payload.length,
    events: payload.eventTracks.map((track) => ({ name: track.name, inputs: track.inputs.map((input) => ({ ...input })) })),
    proxies: payload.proxies.map(({ id, name: proxyName, represents, classId }) => ({ id, name: proxyName, represents, classId })),
  };
  return { [TIMELINE_CLIPS_META]: [summary] };
}

/** A clip asset as Play and exported games hold it: no Editor Preview. Create makes instances of it. */
export interface TimelineClipAssetCatalogEntry {
  guid: string;
  type: TimelineClipAssetType;
  /** The asset's name: its clip's name, which the Timeline's re-fired events carry. */
  name: string;
  payload: SerializedTimelineClipAsset;
}

export function timelineClipAssetCatalogEntry(guid: string, type: TimelineClipAssetType, name: string, raw: unknown): TimelineClipAssetCatalogEntry {
  return { guid, type, name, payload: stripTimelineClipAssetEditorData(normalizeTimelineClipAsset(raw)) };
}
