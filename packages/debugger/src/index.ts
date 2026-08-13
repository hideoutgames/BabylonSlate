export type {
  CommandParamType,
  CommandParameter,
  CommandRegistry,
  CommandResult,
  CommandTier,
  ConsoleCommandHost,
  RegisteredCommand,
} from "./types";
export {
  createCommandRegistry,
  type CreateCommandRegistryOptions,
} from "./registry";
export { CORE_COMMAND_NAMES, DEBUG_COMMAND_NAMES } from "./commands";
export { tokenize, parseCommandArgs, matchCommandName } from "./parser";
export {
  warnDebugTierConsoleCommands,
  type ConsoleCommandDiagnostic,
  type ConsoleCommandGraph,
} from "./validation";
export { createUserCommand, type UserCommandDef } from "./user-commands";
export { suggestConsoleCompletions } from "./autocomplete";
export { TICK_BUDGET_MS, isTickOverBudget } from "./stats";
export {
  TraceRecorder,
  type TraceFrame,
  type TracePayload,
  type TraceRecorderOptions,
} from "./trace-recorder";
