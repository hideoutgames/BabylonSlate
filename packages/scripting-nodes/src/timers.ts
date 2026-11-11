import {
  pin,
  delegateOf,
  structRef,
  type GraphPin,
  type NodeDefinition,
  BOOL,
  EXEC,
  FLOAT,
  ENGINE_TIMER_HANDLE_STRUCT_ID,
} from "@haptic/scripting";

const TIMER_HANDLE = structRef(ENGINE_TIMER_HANDLE_STRUCT_ID);
const handlePin = (): GraphPin => pin("handle", "Handle", "in", TIMER_HANDLE);
const execPins = (): GraphPin[] => [pin("execIn", "exec", "in", EXEC), pin("execOut", "then", "out", EXEC)];

/** A pure read of a timer by its handle. */
function timerRead(id: string, title: string, description: string, outId: string, outName: string, type: GraphPin["type"], member: string): NodeDefinition {
  return {
    id, title, category: "timers", pure: true, description,
    pins: () => [handlePin(), pin(outId, outName, "out", type)],
    codegen: (ctx) => ({ [outId]: `ctx.${member}(${ctx.input("handle")})` }),
  };
}

/** An exec action on a timer by its handle. */
function timerAction(id: string, title: string, description: string, statement: (handle: string) => string): NodeDefinition {
  return {
    id, title, category: "timers", description,
    pins: () => [...execPins(), handlePin()],
    codegen: (ctx) => {
      ctx.emit(statement(ctx.input("handle")));
    },
  };
}

export const timerNodes: NodeDefinition[] = [
  {
    id: "timers.delay",
    title: "Delay",
    category: "timers",
    latent: true,
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("duration", "duration", "in", FLOAT),
    ],
    codegen: (ctx) => {
      ctx.emit(`yield ctx.delay(${ctx.input("duration")});`);
    },
  },
  {
    id: "timers.retriggerableDelay",
    title: "Retriggerable Delay",
    category: "timers",
    latent: true,
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
      pin("duration", "duration", "in", FLOAT),
    ],
    // Keyed by node: a later call restarts the wait and only that call continues.
    codegen: (ctx) => {
      ctx.emit(`yield ctx.retriggerableDelay(${JSON.stringify(ctx.node.id)}, ${ctx.input("duration")});`);
    },
  },
  {
    id: "timers.delayOneTick",
    title: "Delay One Tick",
    category: "timers",
    latent: true,
    pins: () => [
      pin("execIn", "exec", "in", EXEC),
      pin("execOut", "then", "out", EXEC),
    ],
    codegen: (ctx) => {
      ctx.emit("yield ctx.delayOneTick();");
    },
  },
  {
    id: "timers.setTimerByEvent",
    title: "Set Timer By Event",
    category: "timers",
    description: "Runs Event after Time seconds of game time, and again every Time seconds while Looping is on. Returns a Handle for the other Timer nodes.",
    searchAliases: ["timer", "set timer", "repeat", "interval", "schedule"],
    pins: () => [
      ...execPins(),
      pin("event", "Event", "in", delegateOf([])),
      pin("time", "Time", "in", FLOAT, "data", true, 1),
      pin("looping", "Looping", "in", BOOL, "data", true, false),
      pin("firstDelay", "Initial Start Delay", "in", FLOAT, "data", true, 0),
      pin("handle", "Handle", "out", TIMER_HANDLE),
    ],
    codegen: (ctx) => {
      ctx.emit(`${ctx.output("handle")} = ctx.setTimer(${ctx.input("event")}, ${ctx.input("time")}, ${ctx.input("looping")}, ${ctx.input("firstDelay")});`);
    },
  },
  timerAction("timers.clearTimer", "Clear Timer By Handle", "Stops the timer; it will not run its event again.",
    (handle) => `ctx.clearTimer(${handle});`),
  {
    id: "timers.clearAndInvalidateTimer",
    title: "Clear And Invalidate Timer By Handle",
    category: "timers",
    description: "Stops the timer and empties the Handle variable connected to it, so the handle names no timer.",
    pins: () => [...execPins(), { ...pin("handle", "Handle", "in", TIMER_HANDLE), reference: "required" as const }],
    codegen: (ctx) => {
      ctx.emit(`ctx.clearTimer(${ctx.input("handle")});`);
      if (ctx.reference) ctx.emit(`(${ctx.reference("handle")})?.set({ Id: 0 });`);
    },
  },
  timerAction("timers.pauseTimer", "Pause Timer By Handle", "Holds the timer where it is until Unpause Timer By Handle.",
    (handle) => `ctx.setTimerPaused(${handle}, true);`),
  timerAction("timers.unpauseTimer", "Unpause Timer By Handle", "Lets a paused timer count on from where it stopped.",
    (handle) => `ctx.setTimerPaused(${handle}, false);`),
  timerRead("timers.isTimerActive", "Is Timer Active By Handle", "True while the timer exists and is not paused.", "active", "Active", BOOL, "isTimerActive"),
  timerRead("timers.isTimerPaused", "Is Timer Paused By Handle", "True while the timer exists and is paused.", "paused", "Paused", BOOL, "isTimerPaused"),
  timerRead("timers.timerExists", "Does Timer Exist By Handle", "True until the timer is cleared, its owner is destroyed or, when not looping, it has run.", "exists", "Exists", BOOL, "timerExists"),
  timerRead("timers.timerRemaining", "Get Timer Remaining Time By Handle", "Seconds until the timer runs its event, or -1 when there is no timer.", "seconds", "Seconds", FLOAT, "timerRemaining"),
  timerRead("timers.timerElapsed", "Get Timer Elapsed Time By Handle", "Seconds since the timer last ran or started, or -1 when there is no timer.", "seconds", "Seconds", FLOAT, "timerElapsed"),
];
