export const INFINITE_LOOP_ERROR_MESSAGE = "Infinite loop detected";
export const INFINITE_LOOP_DIAGNOSTIC_CODE = "runtime.infinite_loop";
export const DEFAULT_INFINITE_LOOP_COUNT = 1_000_000;

export class InfiniteLoopError extends Error {
  constructor(message = INFINITE_LOOP_ERROR_MESSAGE) {
    super(message);
    this.name = "InfiniteLoopError";
  }
}

export function isInfiniteLoopError(value: unknown): value is InfiniteLoopError {
  if (value instanceof InfiniteLoopError) return true;
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { name?: unknown }).name === "InfiniteLoopError"
  );
}

export type InfiniteLoopGuard = {
  check(): void;
  reset(): void;
};

export function createInfiniteLoopGuard(options: {
  enabled: boolean;
  loopCount: number;
}): InfiniteLoopGuard {
  const loopCount =
    typeof options.loopCount === "number" && options.loopCount >= 1
      ? options.loopCount
      : DEFAULT_INFINITE_LOOP_COUNT;
  let count = 0;
  return {
    check() {
      if (!options.enabled) return;
      count += 1;
      if (count > loopCount) throw new InfiniteLoopError();
    },
    reset() {
      count = 0;
    },
  };
}

const KEYWORDS = ["while", "for", "do"] as const;

/**
 * Insert `checkCall` at the start of every `while` / `for` / `do` body.
 * Empty `while (true);` becomes a braced body so the check still runs.
 * Strings, comments, and regex literals are left alone.
 */
export function instrumentJsLoops(source: string, checkCall: string): string {
  const check = checkCall.trim().endsWith(";")
    ? checkCall.trim()
    : `${checkCall.trim()};`;
  const code = classifyCode(source);
  const skipWhileAt = new Set<number>();
  const edits: Array<{ start: number; end: number; text: string }> = [];

  let i = 0;
  while (i < source.length) {
    if (!code[i]) {
      i += 1;
      continue;
    }
    const keyword = matchKeywordAt(source, code, i);
    if (!keyword) {
      i += 1;
      continue;
    }
    if (keyword === "while" && skipWhileAt.has(i)) {
      i += keyword.length;
      continue;
    }

    if (keyword === "do") {
      const afterDo = skipWs(source, code, i + 2);
      const body = parseStatement(source, code, afterDo, check, edits);
      if (!body) {
        i += 2;
        continue;
      }
      const afterBody = skipWs(source, code, body.end);
      if (matchKeywordAt(source, code, afterBody) === "while") {
        skipWhileAt.add(afterBody);
      }
      i = afterDo;
      continue;
    }

    const afterKw = skipWs(source, code, i + keyword.length);
    if (source[afterKw] !== "(") {
      i += keyword.length;
      continue;
    }
    const closeParen = matchDelim(source, code, afterKw, "(", ")");
    if (closeParen < 0) {
      i += keyword.length;
      continue;
    }
    const bodyStart = skipWs(source, code, closeParen + 1);
    const body = parseStatement(source, code, bodyStart, check, edits);
    i = body ? bodyStart : i + keyword.length;
  }

  return applyEdits(source, edits);
}

function parseStatement(
  source: string,
  code: boolean[],
  start: number,
  check: string,
  edits: Array<{ start: number; end: number; text: string }>,
): { end: number } | null {
  if (start >= source.length) return null;
  if (source[start] === "{") {
    edits.push({ start: start + 1, end: start + 1, text: ` ${check} ` });
    const close = matchDelim(source, code, start, "{", "}");
    return close >= 0 ? { end: close + 1 } : { end: start + 1 };
  }
  if (source[start] === ";") {
    edits.push({ start, end: start + 1, text: `{ ${check} }` });
    return { end: start + 1 };
  }
  const nested = matchKeywordAt(source, code, start);
  if (nested === "while" || nested === "for" || nested === "do") {
    edits.push({ start, end: start, text: `{ ${check} ` });
    const nestedEnd = skipNestedStatement(source, code, start);
    if (nestedEnd > start) {
      edits.push({ start: nestedEnd, end: nestedEnd, text: " }" });
      return { end: nestedEnd };
    }
  }
  const end = scanSimpleStatement(source, code, start);
  if (end <= start) return { end: start };
  edits.push({
    start,
    end,
    text: `{ ${check} ${source.slice(start, end)} }`,
  });
  return { end };
}

function skipNestedStatement(
  source: string,
  code: boolean[],
  start: number,
): number {
  const keyword = matchKeywordAt(source, code, start);
  if (keyword === "do") {
    const afterDo = skipWs(source, code, start + 2);
    const bodyEnd = statementExtent(source, code, afterDo);
    const afterBody = skipWs(source, code, bodyEnd);
    if (matchKeywordAt(source, code, afterBody) === "while") {
      const afterWhile = skipWs(source, code, afterBody + 5);
      if (source[afterWhile] === "(") {
        const close = matchDelim(source, code, afterWhile, "(", ")");
        if (close >= 0) {
          const semi = skipWs(source, code, close + 1);
          return source[semi] === ";" ? semi + 1 : close + 1;
        }
      }
    }
    return bodyEnd;
  }
  if (keyword === "while" || keyword === "for") {
    const afterKw = skipWs(source, code, start + keyword.length);
    if (source[afterKw] !== "(") return start;
    const close = matchDelim(source, code, afterKw, "(", ")");
    if (close < 0) return start;
    return statementExtent(source, code, skipWs(source, code, close + 1));
  }
  return start;
}

function statementExtent(
  source: string,
  code: boolean[],
  start: number,
): number {
  if (source[start] === "{") {
    const close = matchDelim(source, code, start, "{", "}");
    return close >= 0 ? close + 1 : start + 1;
  }
  if (source[start] === ";") return start + 1;
  const nested = matchKeywordAt(source, code, start);
  if (nested === "while" || nested === "for" || nested === "do") {
    return skipNestedStatement(source, code, start);
  }
  return scanSimpleStatement(source, code, start);
}

function scanSimpleStatement(
  source: string,
  code: boolean[],
  start: number,
): number {
  let i = start;
  let paren = 0;
  let brace = 0;
  let bracket = 0;
  while (i < source.length) {
    if (!code[i]) {
      i += 1;
      continue;
    }
    const ch = source[i]!;
    if (ch === "(") paren += 1;
    else if (ch === ")" && paren > 0) paren -= 1;
    else if (ch === "{") brace += 1;
    else if (ch === "}" && brace > 0) brace -= 1;
    else if (ch === "[") bracket += 1;
    else if (ch === "]" && bracket > 0) bracket -= 1;
    else if (
      ch === ";" &&
      paren === 0 &&
      brace === 0 &&
      bracket === 0
    ) {
      return i + 1;
    }
    i += 1;
  }
  return source.length;
}

function matchKeywordAt(
  source: string,
  code: boolean[],
  i: number,
): (typeof KEYWORDS)[number] | null {
  if (!code[i]) return null;
  if (i > 0 && code[i - 1] && isIdentChar(source[i - 1]!)) return null;
  for (const keyword of KEYWORDS) {
    if (!source.startsWith(keyword, i)) continue;
    const end = i + keyword.length;
    if (end < source.length && code[end] && isIdentChar(source[end]!)) {
      continue;
    }
    for (let k = 0; k < keyword.length; k++) {
      if (!code[i + k]) return null;
    }
    return keyword;
  }
  return null;
}

function isIdentChar(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch);
}

function skipWs(source: string, code: boolean[], i: number): number {
  let n = i;
  while (n < source.length) {
    if (!code[n]) {
      n += 1;
      continue;
    }
    const ch = source[n]!;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      n += 1;
      continue;
    }
    break;
  }
  return n;
}

function matchDelim(
  source: string,
  code: boolean[],
  openIndex: number,
  open: string,
  close: string,
): number {
  if (source[openIndex] !== open) return -1;
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    if (!code[i]) continue;
    if (source[i] === open) depth += 1;
    else if (source[i] === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function applyEdits(
  source: string,
  edits: Array<{ start: number; end: number; text: string }>,
): string {
  if (edits.length === 0) return source;
  const ordered = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let out = source;
  for (const edit of ordered) {
    out = `${out.slice(0, edit.start)}${edit.text}${out.slice(edit.end)}`;
  }
  return out;
}

type Mode =
  | { k: "code"; braces: number }
  | { k: "line" }
  | { k: "block" }
  | { k: "sq" }
  | { k: "dq" }
  | { k: "template" }
  | { k: "regex" };

function classifyCode(source: string): boolean[] {
  const code = Array<boolean>(source.length).fill(false);
  const stack: Mode[] = [{ k: "code", braces: 0 }];
  let lastOperand = false;
  let i = 0;
  while (i < source.length) {
    const mode = stack[stack.length - 1]!;
    const ch = source[i]!;
    const next = source[i + 1] ?? "";

    if (mode.k === "line") {
      if (ch === "\n") stack.pop();
      i += 1;
      continue;
    }
    if (mode.k === "block") {
      if (ch === "*" && next === "/") {
        stack.pop();
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (mode.k === "sq") {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "'") stack.pop();
      i += 1;
      continue;
    }
    if (mode.k === "dq") {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === '"') stack.pop();
      i += 1;
      continue;
    }
    if (mode.k === "template") {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "`") {
        stack.pop();
        i += 1;
        continue;
      }
      if (ch === "$" && next === "{") {
        stack.push({ k: "code", braces: 1 });
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (mode.k === "regex") {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "/") stack.pop();
      i += 1;
      continue;
    }

    code[i] = true;
    if (ch === "/" && next === "/") {
      code[i] = false;
      stack.push({ k: "line" });
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      code[i] = false;
      stack.push({ k: "block" });
      i += 1;
      continue;
    }
    if (ch === "/" && !lastOperand) {
      stack.push({ k: "regex" });
      lastOperand = true;
      i += 1;
      continue;
    }
    if (ch === "'") {
      stack.push({ k: "sq" });
      lastOperand = true;
      i += 1;
      continue;
    }
    if (ch === '"') {
      stack.push({ k: "dq" });
      lastOperand = true;
      i += 1;
      continue;
    }
    if (ch === "`") {
      stack.push({ k: "template" });
      lastOperand = true;
      i += 1;
      continue;
    }
    if (ch === "{") {
      mode.braces += 1;
      lastOperand = false;
      i += 1;
      continue;
    }
    if (ch === "}") {
      if (mode.braces > 0) mode.braces -= 1;
      if (mode.braces === 0 && stack.length > 1) {
        stack.pop();
        lastOperand = true;
        i += 1;
        continue;
      }
      lastOperand = true;
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    lastOperand = /[A-Za-z0-9_$)\]']/.test(ch);
    i += 1;
  }
  return code;
}
