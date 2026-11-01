import {
  SCENE_LAYER_EXCLUSIVE_COMPONENT_CLASS_IDS,
  isSceneLayerDeniedComponent,
  type SerializedTimelineClip,
  type SerializedTimelineClipAsset,
} from "@haptic/core";
import { TIMELINE_CLIP_BUILT_IN_DISPATCHERS } from "@haptic/object-model";
import { diagnostic, jsIdent, type Diagnostic } from "@haptic/scripting";
import { timelineClipNameCollisions, type ProjectTimelineClip } from "./timeline-asset-index";

/**
 * Errors for Custom Event Tracks whose dispatcher a script could not tell
 * apart: two in one clip with the same name (or the same script identifier,
 * such as `On Beat` and `On_Beat`), or one named like a built-in event.
 */
export function timelineClipDiagnostics(
  clips: readonly SerializedTimelineClip[] | undefined,
  anchor: { assetGuid: string; graphId: string },
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const builtIn = new Set<string>(TIMELINE_CLIP_BUILT_IN_DISPATCHERS.map((name) => jsIdent(name)));
  for (const clip of clips ?? []) {
    const seen = new Map<string, string>();
    for (const track of clip.eventTracks) {
      const ident = jsIdent(track.name);
      const clash = builtIn.has(ident)
        ? `${clip.name}: "${track.name}" is the name of a built-in Timeline Clip event.`
        : seen.has(ident)
          ? `${clip.name}: two Custom Event Tracks are named "${track.name}"${seen.get(ident) === track.name ? "" : ` and "${seen.get(ident)}"`}.`
          : undefined;
      if (!seen.has(ident)) seen.set(ident, track.name);
      if (clash) out.push(diagnostic({ ...anchor, severity: "error", code: "timeline.event_name_collision", message: clash }));
    }
  }
  return out;
}

/**
 * Errors for this document's clips that share a name with another clip of the
 * Timeline Asset they are bound to, for example after a rename in another
 * Scene: scripts reach an asset's clips by name.
 */
export function timelineClipBindingDiagnostics(
  clips: readonly ProjectTimelineClip[],
  documentPath: string,
  anchor: { assetGuid: string; graphId: string },
  assetName: (guid: string) => string | undefined,
): Diagnostic[] {
  const collisions = timelineClipNameCollisions(clips);
  return collisions
    .filter((entry) => entry.documentPath === documentPath)
    .map((entry) => {
      const other = collisions.find((candidate) => candidate !== entry && candidate.clip.timelineAsset === entry.clip.timelineAsset
        && candidate.clip.name === entry.clip.name);
      const asset = assetName(entry.clip.timelineAsset!) ?? "Its Timeline Asset";
      const where = other ? ` (${other.documentPath === documentPath ? "this document" : other.documentName})` : "";
      return diagnostic({
        ...anchor,
        severity: "error",
        code: "timeline.clip_name_collision",
        message: `${entry.clip.name}: ${asset} already holds another clip with this name${where}. Rename one of them.`,
      });
    });
}

/**
 * A 2D or 3D Timeline Clip asset's own errors: `timeline.clip_asset_unbound`
 * (no Timeline Asset, or it was deleted), `timeline.proxy_name_collision`
 * (two proxies share a name, so their Create inputs and nodes would too),
 * `timeline.proxy_class_missing` (a proxy's Class was deleted), and the
 * `timeline.proxy_placement` warning for a Component proxy whose Class does
 * not suit the clip's 2D or 3D type.
 */
export function timelineClipAssetDiagnostics(
  payload: SerializedTimelineClipAsset,
  context: { twoD: boolean; timelineAssetName: (guid: string) => string | undefined; classExists: (classId: string) => boolean },
  anchor: { assetGuid: string; graphId: string },
): Diagnostic[] {
  const out: Diagnostic[] = [];
  const push = (severity: "error" | "warning", code: string, message: string) => out.push(diagnostic({ ...anchor, severity, code, message }));
  if (!payload.timelineAsset || !context.timelineAssetName(payload.timelineAsset)) {
    push("error", "timeline.clip_asset_unbound", payload.timelineAsset
      ? "Its Timeline Asset was deleted. Pick another under Timeline Asset in the Inspector."
      : "It has no Timeline Asset. Pick one under Timeline Asset in the Inspector.");
  }
  const named = new Map<string, number>();
  for (const proxy of payload.proxies) named.set(proxy.name, (named.get(proxy.name) ?? 0) + 1);
  for (const [name, count] of named) {
    if (count > 1) push("error", "timeline.proxy_name_collision", `${count} proxies are named ${name}. Rename them so each has its own Create input and nodes.`);
  }
  const overlayOnly = new Set<string>(SCENE_LAYER_EXCLUSIVE_COMPONENT_CLASS_IDS);
  for (const proxy of payload.proxies) {
    if (!context.classExists(proxy.classId)) {
      push("error", "timeline.proxy_class_missing", `${proxy.name}: its Class ${proxy.classId} no longer exists. Remove the proxy or add it again with another Class.`);
    } else if (proxy.represents === "component" && (context.twoD ? isSceneLayerDeniedComponent(proxy.classId) : overlayOnly.has(proxy.classId))) {
      push("warning", "timeline.proxy_placement", `${proxy.name}: ${proxy.classId} is not a ${context.twoD ? "2D" : "3D"} component, so no object in a ${context.twoD ? "Scene Layer" : "Scene"} can stand in for it.`);
    }
  }
  return out;
}
