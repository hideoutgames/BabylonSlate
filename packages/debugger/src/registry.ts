import {
  builtinCommands,
  createHelpCommand,
  DEBUG_COMMAND_NAMES,
  isReservedConsoleCommandName,
} from "./commands";
import { fail, matchCommandName, parseCommandArgs, tokenize } from "./parser";
import type {
  CommandRegistry,
  CommandResult,
  ConsoleCommandHost,
  RegisteredCommand,
} from "./types";

export type {
  CommandRegistry,
  CommandResult,
  ConsoleCommandHost,
  RegisteredCommand,
};

export type CreateCommandRegistryOptions = {
  /** When false, debug-tier commands are recognised but not runnable (P14 stand-in). */
  includeDebug?: boolean;
};

export function createCommandRegistry(
  options: CreateCommandRegistryOptions = {},
): CommandRegistry {
  const includeDebug = options.includeDebug ?? true;
  const byName = new Map<string, RegisteredCommand>();
  const stripped = new Set<string>();

  const registry: CommandRegistry = {
    register(command) {
      const name = command.name.toLowerCase();
      if (
        isReservedConsoleCommandName(name) &&
        (byName.has(name) || stripped.has(name))
      ) {
        return;
      }
      byName.set(name, command);
      stripped.delete(name);
    },
    get(name) {
      return byName.get(name.toLowerCase());
    },
    list() {
      return [...byName.values()];
    },
    execute(line, host: ConsoleCommandHost): CommandResult {
      const tokens = tokenize(line.trim());
      if (tokens.length === 0) {
        return fail("unknown command:");
      }
      const known = new Set<string>([...byName.keys(), ...stripped]);
      const { name, rest } = matchCommandName(tokens, known);
      if (stripped.has(name)) {
        return fail(`debug command '${name}' is not available in this build`);
      }
      const command = byName.get(name);
      if (!command) {
        return fail(`unknown command: ${name}`);
      }
      const parsed = parseCommandArgs(rest, command.parameters);
      if (parsed.ok === false) return fail(parsed.output);
      return command.run(parsed.args, host);
    },
  };

  for (const command of builtinCommands()) {
    if (command.tier === "debug" && !includeDebug) {
      stripped.add(command.name.toLowerCase());
      continue;
    }
    registry.register(command);
  }

  if (!includeDebug) {
    for (const name of DEBUG_COMMAND_NAMES) {
      stripped.add(name);
    }
  }

  registry.register(
    createHelpCommand(() => [...byName.values()], stripped),
  );

  return registry;
};
