import { matchCommandName, tokenize } from "./parser";
import type { RegisteredCommand } from "./types";

/** Prefix match on command names, then enum values for the current argument. */
export function suggestConsoleCompletions(
  line: string,
  commands: readonly RegisteredCommand[],
): string[] {
  const tokens = tokenize(line.trimStart());
  const names = commands.map((command) => command.name);
  const known = new Set(names.map((name) => name.toLowerCase()));
  if (tokens.length === 0) {
    return [...names].sort();
  }
  const { name, rest } = matchCommandName(tokens, known);
  const command = commands.find((c) => c.name.toLowerCase() === name);
  const trailingSpace = /\s$/.test(line);
  if (!command) {
    const prefix = tokens.join(" ").toLowerCase();
    return names.filter((n) => n.toLowerCase().startsWith(prefix)).sort();
  }
  if (rest.length === 0 && !trailingSpace) {
    return names.filter((n) => n.toLowerCase().startsWith(name)).sort();
  }
  const filled = rest.length;
  const param = command.parameters[filled];
  if (param?.type === "enum" && param.enumValues) {
    const typed = rest[filled]?.toLowerCase() ?? "";
    return param.enumValues.filter((value) =>
      typed ? value.toLowerCase().startsWith(typed) : true,
    );
  }
  if (param && (trailingSpace || rest.length === filled)) {
    return param.enumValues ? [...param.enumValues] : [];
  }
  return [];
}
