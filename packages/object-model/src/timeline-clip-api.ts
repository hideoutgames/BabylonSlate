import type { EngineClassScriptApi } from "./engine-script-api";

/**
 * Dispatchers every Timeline Clip declares (`TIMELINE_CLIP_BUILT_IN_DISPATCHERS`).
 * A clip's Custom Event Tracks add one dispatcher each on its own clip class.
 */
export const TIMELINE_CLIP_SCRIPT_API: EngineClassScriptApi = {
  classId: "TimelineClip",
  dispatchers: [
    { name: "On Finished", description: "A Once clip reached its end, after When Finished.", pins: [] },
    { name: "On Looped", description: "A Loop clip wrapped around, or a Ping Pong clip turned.", pins: [] },
  ],
};
