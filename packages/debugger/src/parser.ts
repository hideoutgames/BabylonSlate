import type { CommandParameter, CommandResult } from "./types";

/** A console token; `name` is set only for an unquoted `name=value` / `name:value` argument. */
export type CommandToken = { value: string; name?: string };

/**
 * Split a console line into tokens; `name="quoted value"` stays one named token.
 * A quoted token is always a value, even when its text looks like `name=value`.
 */
export function tokenizeCommand(line: string): CommandToken[] {
  const tokens: CommandToken[] = [];
  let i = 0;
  const n = line.length;

  const skipWs = () => {
    while (i < n && /\s/.test(line[i]!)) i += 1;
  };

  const readQuoted = (quote: string): string => {
    i += 1;
    let out = "";
    while (i < n && line[i] !== quote) {
      out += line[i];
      i += 1;
    }
    if (i < n) i += 1;
    return out;
  };

  const readWord = (): string => {
    let out = "";
    while (i < n && !/\s/.test(line[i]!)) {
      out += line[i];
      i += 1;
    }
    return out;
  };

  skipWs();
  while (i < n) {
    const named = /^([A-Za-z_][\w]*)[=:]/.exec(line.slice(i));
    if (named) {
      const name = named[1]!;
      i += named[0].length;
      const value =
        line[i] === '"' || line[i] === "'"
          ? readQuoted(line[i]!)
          : readWord();
      tokens.push({ name, value });
    } else if (line[i] === '"' || line[i] === "'") {
      tokens.push({ value: readQuoted(line[i]!) });
    } else {
      tokens.push({ value: readWord() });
    }
    skipWs();
  }
  return tokens;
}

/** `tokenizeCommand` as text; a named argument reads `name=value`. */
export function tokenize(line: string): string[] {
  return tokenizeCommand(line).map(tokenText);
}

function tokenText(token: string | CommandToken): string {
  if (typeof token === "string") return token;
  return token.name === undefined ? token.value : `${token.name}=${token.value}`;
}

function coerce(
  param: CommandParameter,
  raw: string,
): { ok: true; value: unknown } | { ok: false; output: string } {
  switch (param.type) {
    case "string":
      return { ok: true, value: raw };
    case "int": {
      if (!/^-?\d+$/.test(raw.trim())) {
        return {
          ok: false,
          output: `parameter "${param.name}" expects int, got "${raw}"`,
        };
      }
      return { ok: true, value: Number.parseInt(raw, 10) };
    }
    case "float": {
      const value = Number(raw);
      if (raw.trim() === "" || !Number.isFinite(value)) {
        return {
          ok: false,
          output: `parameter "${param.name}" expects float, got "${raw}"`,
        };
      }
      return { ok: true, value };
    }
    case "bool": {
      const token = raw.trim().toLowerCase();
      if (["true", "1", "on", "yes"].includes(token)) {
        return { ok: true, value: true };
      }
      if (["false", "0", "off", "no"].includes(token)) {
        return { ok: true, value: false };
      }
      return {
        ok: false,
        output: `parameter "${param.name}" expects bool, got "${raw}"`,
      };
    }
    case "enum": {
      const allowed = param.enumValues ?? [];
      const value = raw.trim().toLowerCase();
      const canonical = allowed.find((entry) => entry.toLowerCase() === value);
      if (canonical === undefined) {
        return {
          ok: false,
          output: `parameter "${param.name}" expects one of ${allowed.join(", ")}, got "${raw}"`,
        };
      }
      return { ok: true, value: canonical };
    }
    default:
      return { ok: true, value: raw };
  }
}

export function parseCommandArgs(
  tokens: readonly CommandToken[],
  parameters: readonly CommandParameter[],
): { ok: true; args: Record<string, unknown> } | { ok: false; output: string } {
  const named = new Map<string, string>();
  const positional: string[] = [];
  for (const token of tokens) {
    if (token.name === undefined) {
      positional.push(token.value);
      continue;
    }
    const key = token.name.toLowerCase();
    if (!parameters.some((param) => param.name.toLowerCase() === key)) {
      return { ok: false, output: `unknown parameter "${token.name}"` };
    }
    named.set(key, token.value);
  }

  const args: Record<string, unknown> = {};
  let pos = 0;
  for (const param of parameters) {
    const key = param.name.toLowerCase();
    let raw: string | undefined;
    if (named.has(key)) raw = named.get(key);
    else if (pos < positional.length) {
      raw = param.rest ? positional.slice(pos).join(" ") : positional[pos];
      pos = param.rest ? positional.length : pos + 1;
    }
    if (raw === undefined) {
      if (param.defaultValue !== undefined) {
        args[param.name] = param.defaultValue;
        continue;
      }
      if (param.optional) continue;
      return {
        ok: false,
        output: `parameter "${param.name}" is required`,
      };
    }
    const coerced = coerce(param, raw);
    if (coerced.ok === false) {
      return { ok: false, output: coerced.output };
    }
    args[param.name] = coerced.value;
  }
  return { ok: true, args };
}

export function matchCommandName<T extends string | CommandToken>(
  tokens: readonly T[],
  known: ReadonlySet<string>,
): { name: string; rest: T[] } {
  if (tokens.length === 0) return { name: "", rest: [] };
  for (let len = tokens.length; len >= 1; len -= 1) {
    const name = tokens.slice(0, len).map(tokenText).join(" ").toLowerCase();
    if (known.has(name)) {
      return { name, rest: tokens.slice(len) };
    }
  }
  return { name: tokenText(tokens[0]!).toLowerCase(), rest: tokens.slice(1) };
}

export function fail(output: string): CommandResult {
  return { success: false, output };
}

export function ok(output: string): CommandResult {
  return { success: true, output };
}
