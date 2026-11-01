import type { GraphClassMemberPin } from "./project";
import type { SerializedTimelineClip } from "./timeline-clips";

/**
 * A Timeline Asset (`Timeline`, `.timeline.hasset`) groups Timeline Clips
 * from any number of Scenes and Scene Layers so any class can reach them.
 * It stores only its description: each clip names its asset itself
 * (`SerializedTimelineClip.timelineAsset`), and the asset's clip list comes
 * from the owning documents' header meta (`TIMELINE_CLIPS_META`).
 */
export interface SerializedTimelineAsset {
  description: string;
}

export function createDefaultTimelineAsset(): SerializedTimelineAsset {
  return { description: "" };
}

export function normalizeTimelineAsset(value: unknown): SerializedTimelineAsset {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return { description: typeof source.description === "string" ? source.description : "" };
}

/** Scene and Scene Layer header meta key listing the document's clips. */
export const TIMELINE_CLIPS_META = "timelineClips";

/** What a document's header says about one of its clips: enough to index bindings without loading it. */
export interface TimelineClipSummary {
  id: string;
  name: string;
  /** Bound Timeline Asset guid. */
  timelineAsset?: string;
  length: number;
  /** Its Custom Event Tracks' dispatchers. */
  events: Array<{ name: string; inputs: GraphClassMemberPin[] }>;
  /** A 2D or 3D Timeline Clip asset's proxies, for its Create node's inputs. */
  proxies?: TimelineClipProxySummary[];
}

/** What a clip asset's header says about one proxy. */
export interface TimelineClipProxySummary {
  id: string;
  name: string;
  represents: "actor" | "component";
  classId: string;
}

export function timelineClipSummaries(clips: readonly SerializedTimelineClip[] | undefined): TimelineClipSummary[] {
  return (clips ?? []).map((clip) => ({
    id: clip.id,
    name: clip.name,
    ...(clip.timelineAsset ? { timelineAsset: clip.timelineAsset } : {}),
    length: clip.length,
    events: clip.eventTracks.map((track) => ({ name: track.name, inputs: track.inputs.map((input) => ({ ...input })) })),
  }));
}

/** A header's clip summaries, or none when it has no valid list. */
export function readTimelineClipSummaries(meta: Record<string, unknown> | undefined): TimelineClipSummary[] {
  const raw = meta?.[TIMELINE_CLIPS_META];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): TimelineClipSummary[] => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    if (typeof row.id !== "string" || typeof row.name !== "string") return [];
    return [{
      id: row.id,
      name: row.name,
      ...(typeof row.timelineAsset === "string" && row.timelineAsset ? { timelineAsset: row.timelineAsset } : {}),
      length: typeof row.length === "number" && Number.isFinite(row.length) ? row.length : 0,
      events: Array.isArray(row.events)
        ? (row.events as Array<Record<string, unknown>>).flatMap((event) =>
          event && typeof event.name === "string"
            ? [{ name: event.name, inputs: Array.isArray(event.inputs) ? (event.inputs as GraphClassMemberPin[]) : [] }]
            : [])
        : [],
      ...(Array.isArray(row.proxies) ? { proxies: readProxySummaries(row.proxies) } : {}),
    }];
  });
}

function readProxySummaries(raw: unknown[]): TimelineClipProxySummary[] {
  return raw.flatMap((entry): TimelineClipProxySummary[] => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    if (typeof row.id !== "string" || !row.id || typeof row.classId !== "string" || !row.classId) return [];
    return [{
      id: row.id,
      name: typeof row.name === "string" && row.name ? row.name : row.classId,
      represents: row.represents === "component" ? "component" : "actor",
      classId: row.classId,
    }];
  });
}
