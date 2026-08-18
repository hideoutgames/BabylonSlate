import { matchCommandName, tokenize } from "./parser";
import type {
  CommandParameter,
  ConsoleCompletionContext,
  RegisteredCommand,
} from "./types";

export type { ConsoleCompletionContext };

function unique(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function namedPrefix(param: CommandParameter): string {
  return `${param.name}=`;
}

function contextValues(
  param: CommandParameter,
  context?: ConsoleCompletionContext,
): readonly string[] {
  if (param.complete === "scenes") return context?.scenes ?? [];
  if (param.complete === "actors") return context?.actors ?? [];
  if (param.complete === "commands") return context?.commands ?? [];
  return [];
}

function valueSuggestions(param: CommandParameter): string[] {
  if (param.type === "enum" && param.enumValues) {
    return [...param.enumValues];
  }
  if (param.type === "bool") {
    return ["on", "off"];
  }
  if (
    param.defaultValue !== undefined &&
    param.defaultValue !== null
  ) {
    return [String(param.defaultValue)];
  }
  return [];
}

function suggestionsForParam(
  param: CommandParameter,
  typed: string,
  context?: ConsoleCompletionContext,
): string[] {
  const prefix = typed.toLowerCase();
  const named = namedPrefix(param);
  const out: string[] = [];
  if (
    !prefix ||
    named.toLowerCase().startsWith(prefix) ||
    param.name.toLowerCase().startsWith(prefix)
  ) {
    out.push(named);
  }
  const values = [...valueSuggestions(param), ...contextValues(param, context)];
  for (const value of values) {
    if (!prefix || value.toLowerCase().startsWith(prefix)) {
      out.push(value);
    }
  }
  return unique(out);
}

function currentParamIndex(
  rest: readonly string[],
  trailingSpace: boolean,
): number {
  if (trailingSpace) return rest.length;
  return Math.max(0, rest.length - 1);
}

function typedValue(token: string | undefined): string {
  if (!token) return "";
  const named = /^[A-Za-z_][\w]*=(.*)$/.exec(token);
  return named ? named[1]! : token;
}

/** Prefix match on command names, then values for the current argument. */
export function suggestConsoleCompletions(
  line: string,
  commands: readonly RegisteredCommand[],
  context?: ConsoleCompletionContext,
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
  const index = currentParamIndex(rest, trailingSpace);
  const param = command.parameters[index];
  if (!param) return [];
  const typed = trailingSpace ? "" : typedValue(rest[index]);
  return suggestionsForParam(param, typed, context);
}

/**
 * Insert `suggestion` into `line`, replacing the current token (or appending
 * after a trailing space). Command-name hits become `name `.
 */
export function applyConsoleCompletion(
  line: string,
  suggestion: string,
  commands: readonly RegisteredCommand[],
): string {
  const leading = /^\s*/.exec(line)?.[0] ?? "";
  const body = line.slice(leading.length);
  const trailingSpace = /\s$/.test(line);
  const names = commands.map((command) => command.name);
  const known = new Set(names.map((name) => name.toLowerCase()));
  const tokens = tokenize(body.trimStart());
  const isCommandSuggestion = names.some(
    (name) => name.toLowerCase() === suggestion.toLowerCase(),
  );
  const { name, rest } = matchCommandName(tokens, known);
  const command = commands.find((c) => c.name.toLowerCase() === name);
  if (
    !command ||
    (rest.length === 0 && !trailingSpace && isCommandSuggestion)
  ) {
    return `${leading}${suggestion}${suggestion.endsWith("=") ? "" : " "}`;
  }
  if (trailingSpace || rest.length === 0) {
    const prefix = body.trimEnd();
    const spacer = prefix.length > 0 ? " " : "";
    return `${leading}${prefix}${spacer}${suggestion}`;
  }
  const last = rest[rest.length - 1]!;
  const named = /^([A-Za-z_][\w]*)=(.*)$/.exec(last);
  const replaced =
    named && !suggestion.includes("=") ? `${named[1]}=${suggestion}` : suggestion;
  return `${leading}${[command.name, ...rest.slice(0, -1), replaced].join(" ")}`;
}
