import {
  pin,
  type NodeDefinition,
  STRING,
  INT,
  FLOAT,
  BOOL,
  arrayOf,
  BOXED_WILDCARD,
  readPinDefault,
} from "@babylonslate/scripting";

export const FORMAT_ARG_PIN_PREFIX = "arg:";
export const FORMAT_STRING_DEFAULT = "{input}";

export type FormatToken =
  | { kind: "lit"; text: string }
  | { kind: "arg"; name: string };

export function formatArgPinId(name: string): string {
  return `${FORMAT_ARG_PIN_PREFIX}${encodeURIComponent(name)}`;
}

export function formatArgNameFromPinId(pinId: string): string | undefined {
  if (!pinId.startsWith(FORMAT_ARG_PIN_PREFIX)) return undefined;
  try {
    return decodeURIComponent(pinId.slice(FORMAT_ARG_PIN_PREFIX.length));
  } catch {
    return undefined;
  }
}

/** Unique nonempty placeholder names in first-appearance order. */
export function parseFormatPlaceholders(format: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const token of parseFormatTokens(format)) {
    if (token.kind !== "arg") continue;
    if (seen.has(token.name)) continue;
    seen.add(token.name);
    names.push(token.name);
  }
  return names;
}

/**
 * Tokenize a format string. `{{` / `}}` are escaped braces.
 * `{name}` captures nonempty placeholder names (any chars except `}`).
 */
export function parseFormatTokens(format: string): FormatToken[] {
  const tokens: FormatToken[] = [];
  let lit = "";
  let i = 0;
  const pushLit = () => {
    if (!lit) return;
    tokens.push({ kind: "lit", text: lit });
    lit = "";
  };
  while (i < format.length) {
    const ch = format[i]!;
    if (ch === "{" && format[i + 1] === "{") {
      lit += "{";
      i += 2;
      continue;
    }
    if (ch === "}" && format[i + 1] === "}") {
      lit += "}";
      i += 2;
      continue;
    }
    if (ch === "{") {
      const end = format.indexOf("}", i + 1);
      if (end > i + 1) {
        const name = format.slice(i + 1, end);
        if (name.length > 0 && !name.includes("{")) {
          pushLit();
          tokens.push({ kind: "arg", name });
          i = end + 1;
          continue;
        }
      }
    }
    lit += ch;
    i += 1;
  }
  pushLit();
  return tokens;
}

export function formatStringOf(properties: Record<string, unknown>): string {
  const authored = readPinDefault(properties, "format");
  if (typeof authored === "string") return authored;
  return FORMAT_STRING_DEFAULT;
}

export function isFormatWired(properties: Record<string, unknown>): boolean {
  return properties.formatWired === true;
}

function formatStringCodegen(ctx: {
  input: (pinName: string) => string;
  node: { properties: Record<string, unknown> };
}): Record<string, string> {
  if (isFormatWired(ctx.node.properties)) {
    return { out: `String(${ctx.input("format")})` };
  }
  const format = formatStringOf(ctx.node.properties);
  const parts: string[] = [];
  for (const token of parseFormatTokens(format)) {
    if (token.kind === "lit") {
      if (token.text.length === 0) continue;
      parts.push(JSON.stringify(token.text));
      continue;
    }
    parts.push(`ctx.formatValue(${ctx.input(formatArgPinId(token.name))})`);
  }
  if (parts.length === 0) return { out: '""' };
  if (parts.length === 1) return { out: parts[0]! };
  return { out: `(${parts.join(" + ")})` };
}

export const stringNodes: NodeDefinition[] = [
  {
    id: "string.concat",
    title: "Concat",
    category: "string",
    pure: true,
    pins: () => [
      pin("a", "a", "in", STRING),
      pin("b", "b", "in", STRING),
      pin("out", "out", "out", STRING),
    ],
    codegen: (ctx) => ({
      out: `(String(${ctx.input("a")}) + String(${ctx.input("b")}))`,
    }),
  },
  {
    id: "string.length",
    title: "Length",
    category: "string",
    pure: true,
    pins: () => [
      pin("in", "in", "in", STRING),
      pin("out", "out", "out", INT),
    ],
    codegen: (ctx) => ({ out: `(String(${ctx.input("in")}).length)` }),
  },
  {
    id: "string.equals",
    title: "Equals",
    category: "string",
    pure: true,
    pins: () => [
      pin("a", "a", "in", STRING),
      pin("b", "b", "in", STRING),
      pin("out", "out", "out", BOOL),
    ],
    codegen: (ctx) => ({
      out: `(String(${ctx.input("a")}) === String(${ctx.input("b")}))`,
    }),
  },
  {
    id: "string.contains",
    title: "Contains",
    category: "string",
    pure: true,
    pins: () => [
      pin("in", "In", "in", STRING),
      pin("search", "Search", "in", STRING),
      pin("out", "Out", "out", BOOL),
    ],
    codegen: (ctx) => ({
      out: `(String(${ctx.input("in")}).includes(String(${ctx.input("search")})))`,
    }),
  },
  {
    id: "string.startsWith",
    title: "Starts With",
    category: "string",
    pure: true,
    pins: () => [
      pin("in", "In", "in", STRING),
      pin("prefix", "Prefix", "in", STRING),
      pin("out", "Out", "out", BOOL),
    ],
    codegen: (ctx) => ({
      out: `(String(${ctx.input("in")}).startsWith(String(${ctx.input("prefix")})))`,
    }),
  },
  {
    id: "string.endsWith",
    title: "Ends With",
    category: "string",
    pure: true,
    pins: () => [
      pin("in", "In", "in", STRING),
      pin("suffix", "Suffix", "in", STRING),
      pin("out", "Out", "out", BOOL),
    ],
    codegen: (ctx) => ({
      out: `(String(${ctx.input("in")}).endsWith(String(${ctx.input("suffix")})))`,
    }),
  },
  {
    id: "string.replace",
    title: "Replace",
    category: "string",
    pure: true,
    pins: () => [
      pin("in", "In", "in", STRING),
      pin("search", "Search", "in", STRING),
      pin("replacement", "Replacement", "in", STRING),
      pin("out", "Out", "out", STRING),
    ],
    codegen: (ctx) => ({
      out: `(String(${ctx.input("in")}).replaceAll(String(${ctx.input("search")}), String(${ctx.input("replacement")})))`,
    }),
  },
  {
    id: "string.split",
    title: "Split",
    category: "string",
    pure: true,
    pins: () => [
      pin("in", "In", "in", STRING),
      pin("separator", "Separator", "in", STRING),
      pin("out", "Out", "out", arrayOf(STRING)),
    ],
    codegen: (ctx) => ({
      out: `(String(${ctx.input("in")}).split(String(${ctx.input("separator")})))`,
    }),
  },
  {
    id: "string.join",
    title: "Join",
    category: "string",
    pure: true,
    pins: () => [
      pin("array", "Array", "in", arrayOf(STRING)),
      pin("separator", "Separator", "in", STRING),
      pin("out", "Out", "out", STRING),
    ],
    codegen: (ctx) => ({
      out: `((${ctx.input("array")}) ?? []).map((entry) => String(entry)).join(String(${ctx.input("separator")}))`,
    }),
  },
  {
    id: "string.substring",
    title: "Substring",
    category: "string",
    pure: true,
    pins: () => [
      pin("in", "In", "in", STRING),
      pin("start", "Start", "in", INT),
      pin("end", "End", "in", INT),
      pin("out", "Out", "out", STRING),
    ],
    codegen: (ctx) => ({
      out: `(String(${ctx.input("in")}).substring((${ctx.input("start")}) | 0, (${ctx.input("end")}) | 0))`,
    }),
  },
  {
    id: "string.trim",
    title: "Trim",
    category: "string",
    pure: true,
    pins: () => [
      pin("in", "In", "in", STRING),
      pin("out", "Out", "out", STRING),
    ],
    codegen: (ctx) => ({ out: `(String(${ctx.input("in")}).trim())` }),
  },
  {
    id: "string.toLower",
    title: "To Lower",
    category: "string",
    pure: true,
    pins: () => [
      pin("in", "In", "in", STRING),
      pin("out", "Out", "out", STRING),
    ],
    codegen: (ctx) => ({ out: `(String(${ctx.input("in")}).toLowerCase())` }),
  },
  {
    id: "string.toUpper",
    title: "To Upper",
    category: "string",
    pure: true,
    pins: () => [
      pin("in", "In", "in", STRING),
      pin("out", "Out", "out", STRING),
    ],
    codegen: (ctx) => ({ out: `(String(${ctx.input("in")}).toUpperCase())` }),
  },
  {
    id: "string.parseInt",
    title: "Parse Int",
    category: "string",
    pure: true,
    pins: () => [
      pin("in", "In", "in", STRING),
      pin("out", "Out", "out", INT),
      pin("success", "Success", "out", BOOL),
    ],
    codegen: (ctx) => {
      const raw = `String(${ctx.input("in")}).trim()`;
      return {
        success: `((s => /^-?\\d+$/.test(s))(${raw}))`,
        out: `((s => (/^-?\\d+$/.test(s) ? Number.parseInt(s, 10) : 0))(${raw}))`,
      };
    },
  },
  {
    id: "string.parseFloat",
    title: "Parse Float",
    category: "string",
    pure: true,
    pins: () => [
      pin("in", "In", "in", STRING),
      pin("out", "Out", "out", FLOAT),
      pin("success", "Success", "out", BOOL),
    ],
    codegen: (ctx) => {
      const raw = `String(${ctx.input("in")}).trim()`;
      return {
        success: `((s => { const n = Number(s); return s !== "" && Number.isFinite(n); })(${raw}))`,
        out: `((s => { const n = Number.parseFloat(s); return s !== "" && Number.isFinite(n) ? n : 0; })(${raw}))`,
      };
    },
  },
  {
    id: "string.format",
    title: "Format String",
    category: "string",
    pure: true,
    pins: (properties) => {
      const pins = [pin("format", "Format", "in", STRING)];
      if (!isFormatWired(properties)) {
        for (const name of parseFormatPlaceholders(formatStringOf(properties))) {
          pins.push(pin(formatArgPinId(name), name, "in", BOXED_WILDCARD));
        }
      }
      pins.push(pin("out", "Out", "out", STRING));
      return pins;
    },
    codegen: (ctx) => formatStringCodegen(ctx),
  },
];
