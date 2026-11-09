/**
 * Platform directives: comment lines that mark code for some platforms only, in the manner of Unreal's
 * `#if WITH_EDITOR`. They stay valid TypeScript because they are comments.
 *
 *     // #if WITH_DESKTOP && !WITH_LINUX
 *     ...
 *     // #elif WITH_MOBILE
 *     ...
 *     // #else
 *     ...
 *     // #endif
 *
 * Extension code may use them anywhere; Play and packaging strip the inactive lines before linking. Engine code that
 * ships in games marks whole modules only (a {@link platformModuleCondition}); the player build puts each in its own
 * file, which packaging leaves out for other platforms.
 */

/** Platforms a game is played or packaged for. */
export const BUILD_PLATFORMS = ["web", "windows", "macos", "linux", "android", "ios"] as const;
export type BuildPlatform = (typeof BUILD_PLATFORMS)[number];

export const PLATFORM_SYMBOLS = [
  "WITH_EDITOR",
  "WITH_WEB",
  "WITH_DESKTOP",
  "WITH_WINDOWS",
  "WITH_MACOS",
  "WITH_LINUX",
  "WITH_MOBILE",
  "WITH_ANDROID",
  "WITH_IOS",
] as const;
export type PlatformSymbol = (typeof PLATFORM_SYMBOLS)[number];

const PLATFORM_FAMILY: Record<BuildPlatform, readonly PlatformSymbol[]> = {
  web: ["WITH_WEB"],
  windows: ["WITH_DESKTOP", "WITH_WINDOWS"],
  macos: ["WITH_DESKTOP", "WITH_MACOS"],
  linux: ["WITH_DESKTOP", "WITH_LINUX"],
  android: ["WITH_MOBILE", "WITH_ANDROID"],
  ios: ["WITH_MOBILE", "WITH_IOS"],
};

export function isBuildPlatform(value: unknown): value is BuildPlatform {
  return typeof value === "string" && (BUILD_PLATFORMS as readonly string[]).includes(value);
}

/** The symbols that are true for a platform; `editor` adds `WITH_EDITOR` (Play in the editor, never a packaged game). */
export function platformSymbols(platform: BuildPlatform, options: { editor: boolean }): ReadonlySet<PlatformSymbol> {
  return new Set<PlatformSymbol>([...PLATFORM_FAMILY[platform], ...(options.editor ? ["WITH_EDITOR" as const] : [])]);
}

type Token = { kind: "symbol"; name: string } | { kind: "and" | "or" | "not" | "open" | "close" };

function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /\s*(?:([A-Za-z_][A-Za-z0-9_]*)|(&&)|(\|\|)|(!)|(\()|(\)))/y;
  let index = 0;
  while (index < expression.length) {
    if (/^\s*$/.test(expression.slice(index))) break;
    pattern.lastIndex = index;
    const match = pattern.exec(expression);
    if (!match) throw new Error(`Unexpected "${expression.slice(index).trim()}" in "${expression.trim()}".`);
    index = pattern.lastIndex;
    if (match[1]) {
      if (!(PLATFORM_SYMBOLS as readonly string[]).includes(match[1])) {
        throw new Error(`Unknown platform symbol ${match[1]}; use ${PLATFORM_SYMBOLS.join(", ")}.`);
      }
      tokens.push({ kind: "symbol", name: match[1] });
    } else {
      tokens.push({ kind: match[2] ? "and" : match[3] ? "or" : match[4] ? "not" : match[5] ? "open" : "close" });
    }
  }
  return tokens;
}

/** Whether a directive condition holds for `symbols`. Throws on unknown symbols and malformed expressions. */
export function evaluatePlatformCondition(expression: string, symbols: ReadonlySet<PlatformSymbol>): boolean {
  const tokens = tokenize(expression);
  if (tokens.length === 0) throw new Error("A platform condition is missing.");
  let position = 0;
  const peek = () => tokens[position];
  const primary = (): boolean => {
    const token = tokens[position++];
    if (token?.kind === "symbol") return symbols.has(token.name as PlatformSymbol);
    if (token?.kind === "open") {
      const value = or();
      if (tokens[position++]?.kind !== "close") throw new Error(`A ")" is missing in "${expression.trim()}".`);
      return value;
    }
    throw new Error(`A platform symbol is missing in "${expression.trim()}".`);
  };
  const unary = (): boolean => {
    if (peek()?.kind === "not") {
      position++;
      return !unary();
    }
    return primary();
  };
  const and = (): boolean => {
    let value = unary();
    while (peek()?.kind === "and") {
      position++;
      // Both sides are parsed, so an error anywhere in the condition is reported whatever the symbols.
      const right = unary();
      value = value && right;
    }
    return value;
  };
  const or = (): boolean => {
    let value = and();
    while (peek()?.kind === "or") {
      position++;
      const right = and();
      value = value || right;
    }
    return value;
  };
  const value = or();
  if (position < tokens.length) throw new Error(`Unexpected text after "${expression.trim()}".`);
  return value;
}

type Directive = { keyword: "if" | "elif" | "else" | "endif"; argument: string };

/** `#region` and other `#` comments are not directives. */
const DIRECTIVE = /^\s*\/\/\s*#\s*(if|elif|else|endif)\b(.*)$/;

function parseDirective(line: string): Directive | null {
  const match = DIRECTIVE.exec(line.endsWith("\r") ? line.slice(0, -1) : line);
  if (!match) return null;
  return { keyword: match[1] as Directive["keyword"], argument: match[2]!.trim() };
}

function located(file: string, line: number, message: string): Error {
  return new Error(`${file}:${line}: ${message}`);
}

/**
 * The source with every line of an inactive region blanked, so line numbers stay. Directive lines stay as they are.
 * Throws, naming the file and line, on a malformed or unbalanced directive or an unknown symbol.
 */
export function applyPlatformDirectives(source: string, symbols: ReadonlySet<PlatformSymbol>, file = "source"): string {
  const lines = source.split("\n");
  const frames: { parentActive: boolean; taken: boolean; active: boolean; sawElse: boolean; line: number }[] = [];
  const active = () => frames.length === 0 || frames[frames.length - 1]!.active;
  const condition = (argument: string, line: number): boolean => {
    try {
      return evaluatePlatformCondition(argument, symbols);
    } catch (error) {
      throw located(file, line, error instanceof Error ? error.message : String(error));
    }
  };
  const out = lines.map((text, index) => {
    const line = index + 1;
    const directive = parseDirective(text);
    // An inactive line becomes empty; a CRLF file keeps its line ending.
    if (!directive) return active() ? text : text.endsWith("\r") ? "\r" : "";
    const top = frames[frames.length - 1];
    switch (directive.keyword) {
      case "if": {
        const parentActive = active();
        const holds = condition(directive.argument, line);
        frames.push({ parentActive, taken: holds, active: parentActive && holds, sawElse: false, line });
        break;
      }
      case "elif": {
        if (!top) throw located(file, line, "#elif without #if.");
        if (top.sawElse) throw located(file, line, "#elif after #else.");
        const holds = condition(directive.argument, line);
        top.active = top.parentActive && !top.taken && holds;
        top.taken ||= holds;
        break;
      }
      case "else": {
        if (!top) throw located(file, line, "#else without #if.");
        if (top.sawElse) throw located(file, line, "A second #else.");
        if (directive.argument) throw located(file, line, "#else takes no condition; use #elif.");
        top.sawElse = true;
        top.active = top.parentActive && !top.taken;
        top.taken = true;
        break;
      }
      case "endif": {
        if (!top) throw located(file, line, "#endif without #if.");
        if (directive.argument) throw located(file, line, "#endif takes no condition.");
        frames.pop();
        break;
      }
    }
    return text;
  });
  const open = frames[frames.length - 1];
  if (open) throw located(file, open.line, "#if without #endif.");
  return out.join("\n");
}

/**
 * The condition of a platform module: engine code whose whole file is one `// #if <condition>` … `// #endif` region,
 * or null for a file without directives. Any other use of directives is an error, because the player is built once
 * for every platform and can leave out whole files only.
 */
export function platformModuleCondition(source: string, file = "source"): string | null {
  const lines = source.split("\n");
  const directives = lines
    .map((text, index) => ({ directive: parseDirective(text), line: index + 1 }))
    .filter((entry): entry is { directive: Directive; line: number } => entry.directive !== null);
  if (directives.length === 0) return null;
  const meaningful = lines.map((text, index) => ({ text: text.trim(), line: index + 1 })).filter((entry) => entry.text !== "");
  const first = directives[0]!;
  const last = directives[directives.length - 1]!;
  if (
    directives.length !== 2 ||
    first.directive.keyword !== "if" ||
    last.directive.keyword !== "endif" ||
    meaningful[0]?.line !== first.line ||
    meaningful[meaningful.length - 1]?.line !== last.line
  ) {
    throw located(file, first.line, "Engine code that ships in games can mark only a whole file: start it with " +
      "\"// #if <condition>\", end it with \"// #endif\" and use no other directives in it.");
  }
  // Checks the symbols and syntax.
  evaluatePlatformCondition(first.directive.argument, new Set());
  if (last.directive.argument) throw located(file, last.line, "#endif takes no condition.");
  return first.directive.argument;
}
