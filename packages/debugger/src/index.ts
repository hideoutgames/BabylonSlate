export type {
  CommandParamType,
  CommandParameter,
  CommandRegistry,
  CommandResult,
  CommandTier,
  ConsoleCommandHost,
  ConsoleCompleteKind,
  ConsoleCompletionContext,
  FixedShapeLightingRequest,
  RegisteredCommand,
} from "./types";
export {
  createCommandRegistry,
  type CreateCommandRegistryOptions,
} from "./registry";
export { CORE_COMMAND_NAMES, DEBUG_COMMAND_NAMES, EDITOR_COMMAND_NAMES, MAX_TIME_DILATION, isReservedConsoleCommandName } from "./commands";
export { tokenize, tokenizeCommand, parseCommandArgs, matchCommandName, type CommandToken } from "./parser";
export {
  warnDebugTierConsoleCommands,
  warnReservedConsoleCommandNames,
  type ConsoleCommandDiagnostic,
  type ConsoleCommandGraph,
} from "./validation";
export { createUserCommand, type UserCommandDef } from "./user-commands";
export {
  applyConsoleCompletion,
  suggestConsoleCompletions,
} from "./autocomplete";
export {
  STAT_GROUP_LABELS,
  STAT_GROUPS,
  STATS_COMMAND_INTERVAL_MS,
  TICK_BUDGET_MS,
  createMessageRateMeter,
  formatStatBytes,
  isStatGroup,
  isTickOverBudget,
  nextStatGroups,
  shouldEmitStatsCommand,
  statsHudModel,
  type StatGroup,
  type StatsHudInput,
  type StatsHudMetric,
  type StatsHudModel,
  type StatsHudRendering,
  type StatsHudRow,
} from "./stats";
export {
  DEFAULT_INFINITE_LOOP_COUNT,
  INFINITE_LOOP_DIAGNOSTIC_CODE,
  INFINITE_LOOP_ERROR_MESSAGE,
  InfiniteLoopError,
  createInfiniteLoopGuard,
  instrumentJsLoops,
  isInfiniteLoopError,
  type InfiniteLoopGuard,
  type ScriptLoopLocation,
} from "./infinite-loop";
export {
  TraceRecorder,
  type TraceAnimGraphState,
  type TraceAudioState,
  type TraceBtState,
  type TraceFrame,
  type TraceInputEvent,
  type TraceSpriteClip,
  type TraceVoice,
  type TracePayload,
  type TraceRetention,
  type TraceStopReason,
  type TraceRecorderOptions,
} from "./trace-recorder";
export * from "./performance-recorder";
export * from "./long-tasks";
export * from "./session-diagnostics";
export * from "./diagnostic-operation-client";
