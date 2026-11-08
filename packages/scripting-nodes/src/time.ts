import {
  pin,
  structRef,
  type NodeDefinition,
  FLOAT,
  INT,
  ENGINE_DATE_STRUCT_ID,
  ENGINE_TIME_STRUCT_ID,
} from "@haptic/scripting";

/**
 * Time: global getters with no Target. Delta Seconds and Frame Count read the
 * simulation clock; Time Now, Date Now and Time MS read the wall clock in UTC,
 * so they differ between runs.
 */
export const timeNodes: NodeDefinition[] = [
  {
    id: "time.getDeltaSeconds",
    title: "Get Delta Seconds",
    category: "time",
    description: "Returns the length of the current simulation step in seconds, scaled by time dilation.",
    searchAliases: ["dt", "delta time", "frame time", "step"],
    pure: true,
    pins: () => [pin("deltaSeconds", "Delta Seconds", "out", FLOAT)],
    codegen: () => ({ deltaSeconds: "ctx.getDeltaSeconds()" }),
  },
  {
    id: "time.getCurrentFrameCount",
    title: "Get Current Frame Count",
    category: "time",
    description: "Returns how many frames the game has finished since Play started.",
    searchAliases: ["frame number", "frame index", "tick count"],
    pure: true,
    pins: () => [pin("frameCount", "Frame Count", "out", INT)],
    codegen: () => ({ frameCount: "ctx.getFrameCount()" }),
  },
  {
    id: "time.getTimeNow",
    title: "Get Time Now",
    category: "time",
    description: "Returns the current time of day in UTC as a Time structure of Hour, Minute, Second and Millisecond.",
    searchAliases: ["clock", "utc", "hour", "minute", "second", "time of day"],
    pure: true,
    pins: () => [pin("time", "Time", "out", structRef(ENGINE_TIME_STRUCT_ID))],
    codegen: () => ({ time: "ctx.getTimeNow()" }),
  },
  {
    id: "time.getDateNow",
    title: "Get Date Now",
    category: "time",
    description: "Returns today's date in UTC as a Date structure of Year, Month, Day, Day Of Week and Day Of Year.",
    searchAliases: ["calendar", "today", "utc", "year", "month", "day"],
    pure: true,
    pins: () => [pin("date", "Date", "out", structRef(ENGINE_DATE_STRUCT_ID))],
    codegen: () => ({ date: "ctx.getDateNow()" }),
  },
  {
    id: "time.getTimeMs",
    title: "Get Time MS",
    category: "time",
    description: "Returns the current Unix time: milliseconds since 1 January 1970 UTC.",
    searchAliases: ["unix", "epoch", "timestamp", "milliseconds", "now"],
    pure: true,
    pins: () => [pin("milliseconds", "Milliseconds", "out", FLOAT)],
    codegen: () => ({ milliseconds: "ctx.getTimeMs()" }),
  },
];
