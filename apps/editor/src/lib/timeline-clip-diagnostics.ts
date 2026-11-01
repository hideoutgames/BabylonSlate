import type { SerializedTimelineClip } from "@haptic/core";
import { TIMELINE_CLIP_BUILT_IN_DISPATCHERS } from "@haptic/object-model";
import { diagnostic, jsIdent, type Diagnostic } from "@haptic/scripting";

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
