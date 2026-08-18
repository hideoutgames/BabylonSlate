export type {
  CommandParamType,
  CommandParameter,
  CommandRegistry,
  CommandResult,
  CommandTier,
  ConsoleCommandHost,
  ConsoleCompleteKind,
  ConsoleCompletionContext,
  RegisteredCommand,
} from "./types";
export {
  createCommandRegistry,
  type CreateCommandRegistryOptions,
} from "./registry";
export { CORE_COMMAND_NAMES, DEBUG_COMMAND_NAMES, isReservedConsoleCommandName } from "./commands";
export { tokenize, parseCommandArgs, matchCommandName } from "./parser";
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
export { TICK_BUDGET_MS, isTickOverBudget } from "./stats";
export {
  DEFAULT_INFINITE_LOOP_COUNT,
  INFINITE_LOOP_DIAGNOSTIC_CODE,
  INFINITE_LOOP_ERROR_MESSAGE,
  InfiniteLoopError,
  createInfiniteLoopGuard,
  instrumentJsLoops,
  isInfiniteLoopError,
  type InfiniteLoopGuard,
} from "./infinite-loop";
export {
  TraceRecorder,
  type TraceBtState,
  type TraceFrame,
  type TracePayload,
  type TraceRecorderOptions,
} from "./trace-recorder";
