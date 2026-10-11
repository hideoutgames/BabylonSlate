export const INFINITE_LOOP_ERROR_MESSAGE = "Infinite loop detected";
export const INFINITE_LOOP_DIAGNOSTIC_CODE = "runtime.infinite_loop";
export const DEFAULT_INFINITE_LOOP_COUNT = 1_000_000;

export interface ScriptLoopLocation {
  assetGuid: string;
  graphId: string;
  nodeId: string;
}

export class InfiniteLoopError extends Error {
  scriptLocation?: ScriptLoopLocation;
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

const LOOP_KEYWORDS = new Set(["while", "for", "do"]);

/** Words after which `/` starts a regular expression rather than a division. */
const REGEX_PREFIX_WORDS = new Set([
  "await",
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "return",
  "throw",
  "typeof",
  "void",
  "yield",
]);

/**
 * Reserved words that cannot appear inside an expression, so one at bracket
 * depth zero starts a new statement (automatic semicolon insertion).
 */
const STATEMENT_WORDS = new Set([
  "break",
  "case",
  "catch",
  "const",
  "continue",
  "debugger",
  "default",
  "do",
  "else",
  "finally",
  "for",
  "if",
  "return",
  "switch",
  "throw",
  "try",
  "var",
  "while",
  "with",
]);

type Edit = { start: number; end: number; text: string };

/**
 * Insert `checkCall` at the start of every `while` / `for` / `for await` / `do`
 * body, including loops written inside another loop's header.
 * A braced body gets the check after `{`, and an empty `while (true);` becomes
 * a braced body. Any other single-statement body is prefixed with
 * `if (check, false); else`, which runs the check every iteration without
 * having to find where the statement ends: semicolon insertion and a following
 * `else` keep their meaning.
 * Strings, comments, template text, and regex literals are left alone.
 */
export function instrumentJsLoops(source: string, checkCall: string): string {
  const call = checkCall.trim().replace(/[\s;]+$/, "");
  const check = `${call};`;
  const code = classifyCode(source);
  const doTrailers = new Set<number>();
  const edits: Edit[] = [];

  let i = 0;
  while (i < source.length) {
    const word = wordAt(source, code, i);
    if (!word) {
      i += 1;
      continue;
    }
    if (LOOP_KEYWORDS.has(word) && !isPropertyName(source, code, i)) {
      if (word === "do") {
        const bodyStart = skipWs(source, code, i + 2);
        if (source[bodyStart] !== ":") {
          guardBody(source, bodyStart, call, check, edits);
          const trailer = skipWs(
            source,
            code,
            statementEnd(source, code, bodyStart),
          );
          if (wordAt(source, code, trailer) === "while") doTrailers.add(trailer);
        }
      } else if (!doTrailers.has(i)) {
        const close = loopHeaderClose(source, code, i, word);
        if (close >= 0) {
          guardBody(source, skipWs(source, code, close + 1), call, check, edits);
        }
      }
    }
    // Keep scanning through the header and body so nested loops are guarded.
    i += word.length;
  }

  return applyEdits(source, edits);
}

function guardBody(
  source: string,
  start: number,
  call: string,
  check: string,
  edits: Edit[],
): void {
  if (start >= source.length) return;
  if (source[start] === "{") {
    edits.push({ start: start + 1, end: start + 1, text: ` ${check} ` });
  } else if (source[start] === ";") {
    edits.push({ start, end: start + 1, text: `{ ${check} }` });
  } else {
    edits.push({ start, end: start, text: `if (${call}, false); else ` });
  }
}

/** Index of the `)` closing a `while (` / `for (` / `for await (` header, or -1. */
function loopHeaderClose(
  source: string,
  code: boolean[],
  start: number,
  keyword: string,
): number {
  let open = skipWs(source, code, start + keyword.length);
  if (keyword === "for" && wordAt(source, code, open) === "await") {
    open = skipWs(source, code, open + 5);
  }
  return matchDelim(source, code, open, "(", ")");
}

/**
 * Index just past the statement that starts at `start`; used to find the
 * `while` that ends a `do` body. An expression statement ends at `;`, before
 * the enclosing `}`, or before a reserved word that only starts statements.
 */
function statementEnd(source: string, code: boolean[], start: number): number {
  if (start >= source.length) return source.length;
  const after = (index: number) => skipWs(source, code, index);
  const parenEnd = (index: number) => {
    const close = matchDelim(source, code, after(index), "(", ")");
    return close < 0 ? -1 : close + 1;
  };
  const blockEnd = (index: number) => {
    const close = matchDelim(source, code, after(index), "{", "}");
    return close < 0 ? source.length : close + 1;
  };
  if (source[start] === "{") return blockEnd(start);
  if (source[start] === ";") return start + 1;
  const word = wordAt(source, code, start);
  switch (word) {
    case "if": {
      const header = parenEnd(start + 2);
      if (header < 0) break;
      const thenEnd = statementEnd(source, code, after(header));
      const next = after(thenEnd);
      return wordAt(source, code, next) === "else"
        ? statementEnd(source, code, after(next + 4))
        : thenEnd;
    }
    case "for":
    case "while": {
      const close = loopHeaderClose(source, code, start, word);
      if (close < 0) break;
      return statementEnd(source, code, after(close + 1));
    }
    case "do": {
      const bodyEnd = statementEnd(source, code, after(start + 2));
      const trailer = after(bodyEnd);
      if (wordAt(source, code, trailer) !== "while") return bodyEnd;
      const header = parenEnd(trailer + 5);
      if (header < 0) return bodyEnd;
      const semicolon = after(header);
      return source[semicolon] === ";" ? semicolon + 1 : header;
    }
    case "switch": {
      const header = parenEnd(start + 6);
      if (header < 0) break;
      return blockEnd(header);
    }
    case "try": {
      let end = blockEnd(start + 3);
      let next = after(end);
      if (wordAt(source, code, next) === "catch") {
        const param = parenEnd(next + 5);
        end = blockEnd(param < 0 ? next + 5 : param);
        next = after(end);
      }
      if (wordAt(source, code, next) === "finally") end = blockEnd(next + 7);
      return end;
    }
    default: {
      if (word && !STATEMENT_WORDS.has(word)) {
        const colon = after(start + word.length);
        if (source[colon] === ":") {
          return statementEnd(source, code, after(colon + 1));
        }
      }
    }
  }
  return simpleStatementEnd(source, code, start);
}

function simpleStatementEnd(
  source: string,
  code: boolean[],
  start: number,
): number {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (!code[i]) continue;
    const ch = source[i]!;
    if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) return i;
      depth -= 1;
    } else if (depth === 0) {
      if (ch === ";") return i + 1;
      if (i > start) {
        const word = wordAt(source, code, i);
        if (
          word &&
          STATEMENT_WORDS.has(word) &&
          !isPropertyName(source, code, i)
        ) {
          return i;
        }
      }
    }
  }
  return source.length;
}

/** The identifier or keyword that starts at `i`, or null mid-word / outside code. */
function wordAt(source: string, code: boolean[], i: number): string | null {
  if (!code[i] || !isIdentChar(source[i]!)) return null;
  if (i > 0 && code[i - 1] && isIdentChar(source[i - 1]!)) return null;
  let end = i + 1;
  while (end < source.length && code[end] && isIdentChar(source[end]!)) {
    end += 1;
  }
  return source.slice(i, end);
}

/** `x.for(...)` / `obs.do(...)`: a word after `.` names a property. */
function isPropertyName(source: string, code: boolean[], i: number): boolean {
  let p = i - 1;
  while (p >= 0 && (!code[p] || isSpace(source[p]!))) p -= 1;
  return p >= 0 && source[p] === ".";
}

function isIdentChar(ch: string): boolean {
  return /[\p{ID_Continue}$]/u.test(ch);
}

function isSpace(ch: string): boolean {
  return /\s/.test(ch);
}

function skipWs(source: string, code: boolean[], i: number): number {
  let n = i;
  while (n < source.length && (!code[n] || isSpace(source[n]!))) n += 1;
  return n;
}

function matchDelim(
  source: string,
  code: boolean[],
  openIndex: number,
  open: string,
  close: string,
): number {
  if (source[openIndex] !== open || !code[openIndex]) return -1;
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

function applyEdits(source: string, edits: Edit[]): string {
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
  | { k: "regex"; inClass: boolean };

/**
 * Marks the characters that are code: not inside a string, comment, template
 * text, or regex literal. `/` divides after an operand (a name or literal other
 * than a keyword such as `return`, `)`, `]`, `}`, or postfix `++` / `--`) and
 * starts a regex anywhere else.
 */
function classifyCode(source: string): boolean[] {
  const code = Array<boolean>(source.length).fill(false);
  const stack: Mode[] = [{ k: "code", braces: 0 }];
  let lastOperand = false;
  let afterDot = false;
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
    if (mode.k === "sq" || mode.k === "dq") {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === (mode.k === "sq" ? "'" : '"')) stack.pop();
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
        // The `{` is code so it balances the `}` that ends the substitution.
        code[i + 1] = true;
        stack.push({ k: "code", braces: 1 });
        lastOperand = false;
        afterDot = false;
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
      // A regex literal cannot span lines; recover from a misread division.
      if (ch === "\n" || ch === "\r") {
        stack.pop();
        continue;
      }
      if (ch === "[") mode.inClass = true;
      else if (ch === "]") mode.inClass = false;
      else if (ch === "/" && !mode.inClass) stack.pop();
      i += 1;
      continue;
    }

    if (ch === "/" && (next === "/" || next === "*")) {
      stack.push({ k: next === "/" ? "line" : "block" });
      i += 2;
      continue;
    }
    code[i] = true;
    if (ch === "/" && !lastOperand) {
      stack.push({ k: "regex", inClass: false });
      lastOperand = true;
      afterDot = false;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      stack.push({ k: ch === "'" ? "sq" : ch === '"' ? "dq" : "template" });
      lastOperand = true;
      afterDot = false;
      i += 1;
      continue;
    }
    if (isIdentChar(ch)) {
      let end = i + 1;
      while (end < source.length && isIdentChar(source[end]!)) end += 1;
      code.fill(true, i, end);
      lastOperand = afterDot || !REGEX_PREFIX_WORDS.has(source.slice(i, end));
      afterDot = false;
      i = end;
      continue;
    }
    if (ch === "{") {
      mode.braces += 1;
      lastOperand = false;
      afterDot = false;
      i += 1;
      continue;
    }
    if (ch === "}") {
      if (mode.braces > 0) mode.braces -= 1;
      if (mode.braces === 0 && stack.length > 1) stack.pop();
      lastOperand = true;
      afterDot = false;
      i += 1;
      continue;
    }
    if (isSpace(ch)) {
      i += 1;
      continue;
    }
    if ((ch === "+" || ch === "-") && next === ch) {
      // Postfix `++` / `--` ends an operand; a prefix one precedes an operand.
      code[i + 1] = true;
      lastOperand = true;
      afterDot = false;
      i += 2;
      continue;
    }
    lastOperand = ch === ")" || ch === "]";
    afterDot = ch === ".";
    i += 1;
  }
  return code;
}
