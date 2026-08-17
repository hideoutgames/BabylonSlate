/** Idle Details numerics: round to two decimals and strip trailing zeros. */
export function formatNumericDisplay(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const [intPart, frac = ""] = value.toFixed(2).split(".");
  const trimmedFrac = frac.replace(/0+$/, "");
  const formatted = trimmedFrac ? `${intPart}.${trimmedFrac}` : intPart;
  return formatted === "-0" ? "0" : formatted;
}

type Operator = "+" | "-" | "*" | "/";

type Token =
  | { kind: "number"; value: number }
  | { kind: "op"; value: Operator }
  | { kind: "lparen" }
  | { kind: "rparen" };

/**
 * Evaluate a typed numeric draft. Incomplete text, divide-by-zero, and
 * non-finite results are undefined. A leading `*`, `/`, or `+` applies to
 * `currentValue`; a leading `-` on a number is a negative literal.
 */
export function evaluateNumericExpression(
  raw: string,
  currentValue: number,
): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const source =
    trimmed.startsWith("*") || trimmed.startsWith("/") || trimmed.startsWith("+")
      ? `${currentValue}${trimmed}`
      : trimmed;
  const tokens = tokenize(source);
  if (!tokens) return undefined;
  const parser = { tokens, index: 0 };
  const value = parseAdditive(parser);
  if (value === undefined || parser.index !== tokens.length) return undefined;
  return Number.isFinite(value) ? value : undefined;
}

function tokenize(source: string): Token[] | undefined {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === " " || ch === "\t") {
      i += 1;
      continue;
    }
    if (ch === "+" || ch === "-" || ch === "*" || ch === "/") {
      tokens.push({ kind: "op", value: ch });
      i += 1;
      continue;
    }
    if (ch === "(") {
      tokens.push({ kind: "lparen" });
      i += 1;
      continue;
    }
    if (ch === ")") {
      tokens.push({ kind: "rparen" });
      i += 1;
      continue;
    }
    if ((ch >= "0" && ch <= "9") || ch === ".") {
      const start = i;
      let sawDigit = false;
      let sawDot = false;
      while (i < source.length) {
        const next = source[i]!;
        if (next >= "0" && next <= "9") {
          sawDigit = true;
          i += 1;
          continue;
        }
        if (next === "." && !sawDot) {
          sawDot = true;
          i += 1;
          continue;
        }
        break;
      }
      if (!sawDigit) return undefined;
      const value = Number(source.slice(start, i));
      if (!Number.isFinite(value)) return undefined;
      tokens.push({ kind: "number", value });
      continue;
    }
    return undefined;
  }
  return tokens;
}

interface Parser {
  tokens: Token[];
  index: number;
}

function peek(parser: Parser): Token | undefined {
  return parser.tokens[parser.index];
}

function take(parser: Parser): Token | undefined {
  const token = parser.tokens[parser.index];
  if (token) parser.index += 1;
  return token;
}

function parseAdditive(parser: Parser): number | undefined {
  let left = parseMultiplicative(parser);
  if (left === undefined) return undefined;
  while (true) {
    const token = peek(parser);
    if (!token || token.kind !== "op" || (token.value !== "+" && token.value !== "-")) {
      break;
    }
    take(parser);
    const right = parseMultiplicative(parser);
    if (right === undefined) return undefined;
    left = token.value === "+" ? left + right : left - right;
  }
  return left;
}

function parseMultiplicative(parser: Parser): number | undefined {
  let left = parseUnary(parser);
  if (left === undefined) return undefined;
  while (true) {
    const token = peek(parser);
    if (!token || token.kind !== "op" || (token.value !== "*" && token.value !== "/")) {
      break;
    }
    take(parser);
    const right = parseUnary(parser);
    if (right === undefined) return undefined;
    if (token.value === "/") {
      if (right === 0) return undefined;
      left /= right;
    } else {
      left *= right;
    }
  }
  return left;
}

function parseUnary(parser: Parser): number | undefined {
  const token = peek(parser);
  if (token?.kind === "op" && token.value === "-") {
    take(parser);
    const inner = parseUnary(parser);
    return inner === undefined ? undefined : -inner;
  }
  if (token?.kind === "op" && token.value === "+") {
    take(parser);
    return parseUnary(parser);
  }
  return parsePrimary(parser);
}

function parsePrimary(parser: Parser): number | undefined {
  const token = peek(parser);
  if (!token) return undefined;
  if (token.kind === "number") {
    take(parser);
    return token.value;
  }
  if (token.kind === "lparen") {
    take(parser);
    const inner = parseAdditive(parser);
    if (inner === undefined) return undefined;
    const close = take(parser);
    if (close?.kind !== "rparen") return undefined;
    return inner;
  }
  return undefined;
}
