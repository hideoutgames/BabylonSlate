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
  if (param.defaultValue !== undefined && param.defaultValue !== null) {
    return [String(param.defaultValue)];
  }
  return [];
}

function suggestionsForParam(
  param: CommandParameter,
  typed: string,
  context?: ConsoleCompletionContext,
  namedValue = false,
): string[] {
  const prefix = typed.toLowerCase();
  const named = namedPrefix(param);
  const out: string[] = [];
  if (
    !namedValue &&
    (!prefix ||
      named.toLowerCase().startsWith(prefix) ||
      param.name.toLowerCase().startsWith(prefix))
  ) {
    out.push(named);
  }
  const values = unique([
    ...valueSuggestions(param),
    ...contextValues(param, context),
  ]);
  out.push(...rankMatches(values, typed));
  return unique(out);
}

/** Exact, prefix, interior, then abbreviated subsequence; short queries stay precise. */
function matchRank(value: string, query: string): number {
  const candidate = value.toLowerCase();
  const needle = query.toLowerCase();
  if (candidate === needle) return 0;
  if (candidate.startsWith(needle)) return 1;
  if (candidate.includes(needle)) return 2;
  if (needle.length < 3) return Infinity;
  let cursor = 0;
  for (const letter of needle) {
    const index = candidate.indexOf(letter, cursor);
    if (index < 0) return Infinity;
    cursor = index + 1;
  }
  return 3;
}

function rankMatches(
  values: readonly string[],
  query: string,
  alphabetic = false,
): string[] {
  return values
    .map((value, index) => ({ value, index, rank: matchRank(value, query) }))
    .filter(({ rank }) => Number.isFinite(rank))
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        (alphabetic ? a.value.localeCompare(b.value) : a.index - b.index),
    )
    .map(({ value }) => value);
}

/** Keep source spans so completion never discards quoting in earlier arguments. */
function sourceTokens(line: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  let start = -1;
  let quote = "";
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (start < 0 && /\s/.test(char)) continue;
    if (start < 0) start = index;
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      spans.push({ start, end: index });
      start = -1;
    }
  }
  if (start >= 0) spans.push({ start, end: line.length });
  return spans;
}

function currentParameter(
  parameters: readonly CommandParameter[],
  rest: readonly string[],
  trailingSpace: boolean,
): CommandParameter | undefined {
  const current = trailingSpace ? "" : (rest[rest.length - 1] ?? "");
  const named = /^([A-Za-z_][\w]*)=/.exec(current);
  if (named)
    return parameters.find(
      (param) => param.name.toLowerCase() === named[1]!.toLowerCase(),
    );
  const previous = trailingSpace ? rest : rest.slice(0, -1);
  const suppliedNames = new Set(
    previous.flatMap((token) => {
      const match = /^([A-Za-z_][\w]*)=/.exec(token);
      return match ? [match[1]!.toLowerCase()] : [];
    }),
  );
  const positionalCount = previous.filter(
    (token) => !/^[A-Za-z_][\w]*=/.test(token),
  ).length;
  return parameters.filter(
    (param) => !suppliedNames.has(param.name.toLowerCase()),
  )[positionalCount];
}

function typedValue(token: string | undefined): string {
  if (!token) return "";
  const named = /^[A-Za-z_][\w]*=(.*)$/.exec(token);
  return named ? named[1]! : token;
}

/** Ranked command matches, then contextual values for the current argument. */
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
  const lastSpan = sourceTokens(line).at(-1);
  const trailingSpace = !lastSpan || lastSpan.end < line.length;
  if (!command) {
    return rankMatches(names, tokens.join(" "), true);
  }
  if (rest.length === 0 && !trailingSpace) {
    return rankMatches(names, name, true);
  }
  const param = currentParameter(command.parameters, rest, trailingSpace);
  if (!param) return [];
  const current = trailingSpace ? "" : rest.at(-1);
  return suggestionsForParam(
    param,
    typedValue(current),
    context,
    /^[A-Za-z_][\w]*=/.test(current ?? ""),
  );
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
  const lastSpan = sourceTokens(body).at(-1);
  const trailingSpace = !lastSpan || lastSpan.end < body.length;
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
    return `${leading}${prefix}${spacer}${quoteCompletion(suggestion)}`;
  }
  const last = rest[rest.length - 1]!;
  const named = /^([A-Za-z_][\w]*)=(.*)$/.exec(last);
  const replaced =
    named && !suggestion.includes("=")
      ? `${named[1]}=${quoteCompletion(suggestion)}`
      : quoteCompletion(suggestion);
  return `${leading}${body.slice(0, lastSpan?.start ?? body.length)}${replaced}`;
}

function quoteCompletion(value: string): string {
  if (!/\s/.test(value)) return value;
  const quote = value.includes('"') ? "'" : '"';
  return `${quote}${value}${quote}`;
}
