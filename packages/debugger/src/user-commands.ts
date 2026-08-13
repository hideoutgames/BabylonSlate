import type { CommandParameter, CommandResult, RegisteredCommand } from "./types";

export type UserCommandDef = {
  name: string;
  description: string;
  category: string;
  parameters: readonly CommandParameter[];
  run: (args: Record<string, unknown>) => CommandResult;
};

/** User-authored commands are core tier so they ship in every export. */
export function createUserCommand(def: UserCommandDef): RegisteredCommand {
  return {
    name: def.name,
    tier: "core",
    description: def.description,
    parameters: def.parameters,
    run: (args) => def.run(args),
  };
}
