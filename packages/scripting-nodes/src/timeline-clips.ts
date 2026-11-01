import {
  BOOL,
  ENGINE_TIMELINE_LOOP_MODE_ENUM_ID,
  EXEC,
  FLOAT,
  enumRef,
  objectRef,
  pin,
  type NodeDefinition,
} from "@haptic/scripting";
import { subject } from "./self-pin";

/** Add Node category of the Timeline Clip nodes. */
export const TIMELINE_CLIP_CATEGORY = "timeline";

/** What a Timeline Clip control node asks the runtime to do (`ctx.timelineClipControl`). */
export type TimelineClipAction = "play" | "playFromStart" | "reverse" | "pause" | "stop" | "setPosition" | "setPlayRate" | "setLoopMode";
/** What a Timeline Clip read returns (`ctx.timelineClipState`). */
export type TimelineClipField = "position" | "length" | "playRate" | "playing" | "reversed";

const target = () => subject(pin("target", "Target", "in", objectRef("TimelineClip")));
const exec = () => [pin("execIn", "exec", "in", EXEC), pin("execOut", "then", "out", EXEC)];

function control(
  action: TimelineClipAction,
  title: string,
  description: string,
  inputs: Array<{ id: string; name: string; pin: ReturnType<typeof pin> }> = [],
): NodeDefinition {
  return {
    id: `timelineClip.${action}`,
    title,
    category: TIMELINE_CLIP_CATEGORY,
    description,
    pins: () => [...exec(), target(), ...inputs.map((input) => input.pin)],
    codegen: (ctx) => {
      const args = inputs.map((input) => `${JSON.stringify(input.id)}: ${ctx.input(input.id)}`);
      ctx.emit(`ctx.timelineClipControl(${ctx.input("target")}, ${JSON.stringify(action)}, { ${args.join(", ")} });`);
    },
  };
}

function read(field: TimelineClipField, id: string, title: string, description: string, output: ReturnType<typeof pin>): NodeDefinition {
  return {
    id: `timelineClip.${id}`,
    title,
    category: TIMELINE_CLIP_CATEGORY,
    description,
    pure: true,
    pins: () => [target(), output],
    codegen: (ctx) => ({ [output.id]: `ctx.timelineClipState(${ctx.input("target")}, ${JSON.stringify(field)})` }),
  };
}

/**
 * Play and read a Timeline Clip (`Get <Name> Timeline Clip`). Changes wait
 * while the clip's Scene or Scene Layer cannot run; reads always answer.
 */
export const timelineClipNodes: NodeDefinition[] = [
  control("play", "Play Timeline Clip", "Plays the clip forwards from where it is. A Once clip at its end starts over."),
  control("playFromStart", "Play Timeline Clip From Start", "Plays the clip forwards from its start."),
  control("reverse", "Reverse Timeline Clip", "Plays the clip backwards from where it is. A Once clip at its start starts over from the end."),
  control("pause", "Pause Timeline Clip", "Stops the clip where it is."),
  control("stop", "Stop Timeline Clip", "Stops the clip and returns it to the start, or to the end while it plays in reverse."),
  control("setPosition", "Set Timeline Clip Position", "Moves the clip to Time, in seconds, and applies its values there.", [
    { id: "time", name: "Time", pin: pin("time", "Time", "in", FLOAT, "data", true, 0) },
  ]),
  control("setPlayRate", "Set Timeline Clip Play Rate", "Sets how fast the clip plays: 1 is its authored speed in seconds. A negative rate counts as 0; use Reverse to play backwards.", [
    { id: "playRate", name: "Play Rate", pin: pin("playRate", "Play Rate", "in", FLOAT, "data", true, 1) },
  ]),
  control("setLoopMode", "Set Timeline Clip Loop Mode", "Sets whether the clip stops at its end, starts over or turns around.", [
    { id: "loopMode", name: "Loop Mode", pin: pin("loopMode", "Loop Mode", "in", enumRef(ENGINE_TIMELINE_LOOP_MODE_ENUM_ID), "data", true, "Once") },
  ]),
  read("position", "getPosition", "Get Timeline Clip Position", "Returns where the clip is, in seconds.", pin("position", "Position", "out", FLOAT)),
  read("length", "getLength", "Get Timeline Clip Length", "Returns the clip's Length, in seconds.", pin("length", "Length", "out", FLOAT)),
  read("playRate", "getPlayRate", "Get Timeline Clip Play Rate", "Returns the clip's current Play Rate.", pin("playRate", "Play Rate", "out", FLOAT)),
  read("playing", "isPlaying", "Is Timeline Clip Playing", "Returns true while the clip plays, forwards or in reverse.", pin("playing", "Playing", "out", BOOL)),
  read("reversed", "isReversed", "Is Timeline Clip Reversed", "Returns true when the clip plays, or last played, in reverse.", pin("reversed", "Reversed", "out", BOOL)),
];
