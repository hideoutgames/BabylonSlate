import type { EngineClassScriptApi, EngineScriptPin } from "./engine-script-api";

const EXEC_IN: EngineScriptPin = { name: "exec", typeId: "exec", direction: "in" };
const EXEC_OUT: EngineScriptPin = { name: "then", typeId: "exec", direction: "out" };

/** Functions on a Timeline Clip reference (`Get <Name> Timeline Clip`). */
export const TIMELINE_CLIP_SCRIPT_API: EngineClassScriptApi = {
  classId: "TimelineClip",
  functions: [
    { name: "Play", runtime: "timelinePlay", description: "Play forwards from the current time; a finished Once clip starts over.",
      searchAliases: ["timeline", "start"], pins: [EXEC_IN, EXEC_OUT] },
    { name: "Play Reverse", runtime: "timelinePlayReverse", description: "Play backwards from the current time.",
      searchAliases: ["timeline", "rewind"], pins: [EXEC_IN, EXEC_OUT] },
    { name: "Pause", runtime: "timelinePause", description: "Stop where it is.", searchAliases: ["timeline"], pins: [EXEC_IN, EXEC_OUT] },
    { name: "Stop", runtime: "timelineStop", description: "Stop and go back to the start, showing its first values.",
      searchAliases: ["timeline"], pins: [EXEC_IN, EXEC_OUT] },
    { name: "Set Time", runtime: "timelineSetTime", description: "Jump to a time in seconds and show its values.",
      searchAliases: ["timeline", "seek", "scrub"], pins: [EXEC_IN, EXEC_OUT, { name: "time", typeId: "float", direction: "in" }] },
    { name: "Set Play Rate", runtime: "timelineSetPlayRate", description: "Multiply the clip's Play Rate; 1 plays at it, 0 holds still.",
      searchAliases: ["timeline", "speed"], pins: [EXEC_IN, EXEC_OUT, { name: "rate", typeId: "float", direction: "in", defaultValue: 1 }] },
    { name: "Get Time", runtime: "timelineGetTime", searchAliases: ["timeline"], pins: [{ name: "time", typeId: "float", direction: "out" }] },
    { name: "Get Length", runtime: "timelineGetLength", searchAliases: ["timeline", "duration"], pins: [{ name: "length", typeId: "float", direction: "out" }] },
    { name: "Is Playing", runtime: "timelineIsPlaying", searchAliases: ["timeline"], pins: [{ name: "playing", typeId: "bool", direction: "out" }] },
  ],
};
