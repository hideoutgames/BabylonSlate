/**
 * The Math Expression language: a whitelist tokenizer and a recursive-descent parser into an AST.
 * Nothing here is ever copied into generated code; `emit.ts` re-emits the AST with generated names.
 */

/** Longest formula the node accepts, in characters. */
export const MATH_EXPRESSION_MAX_LENGTH = 4000;
/** Deepest nesting of parentheses, calls, unary minus and powers. */
export const MATH_EXPRESSION_MAX_DEPTH = 32;
/** Most statements in one formula. */
export const MATH_EXPRESSION_MAX_STATEMENTS = 64;
/** Longest variable name. */
export const MATH_EXPRESSION_MAX_NAME_LENGTH = 64;

/** A 0-based character offset into the formula. */
export type MathPosition = number;

export type MathBinaryOperator = "+" | "-" | "*" | "/" | "%" | "^";
export type MathAxis = "x" | "y" | "z" | "w";

export type MathExpr =
  | { kind: "number"; value: number; text: string; pos: MathPosition }
  | { kind: "name"; name: string; pos: MathPosition }
  | { kind: "negate"; arg: MathExpr; pos: MathPosition }
  | { kind: "binary"; op: MathBinaryOperator; left: MathExpr; right: MathExpr; pos: MathPosition }
  | { kind: "call"; name: string; args: MathExpr[]; pos: MathPosition }
  | { kind: "member"; object: MathExpr; axis: MathAxis; pos: MathPosition };

/** `name = expr` (an output), `let name = expr` (internal), or a bare expression (the only statement). */
export type MathStatement =
  | { kind: "assign"; name: string; local: boolean; expr: MathExpr; pos: MathPosition }
  | { kind: "expr"; expr: MathExpr; pos: MathPosition };

export type MathProgram = { statements: MathStatement[] };

export type MathExpressionErrorCode = "mathExpression.parse" | "mathExpression.limit" | "mathExpression.type" | "mathExpression.name";

/** A formula error at a character offset (`pos`), with its 1-based line and column. */
export type MathExpressionError = {
  code: MathExpressionErrorCode;
  message: string;
  pos: MathPosition;
  line: number;
  column: number;
};

export type MathParseResult = { ok: true; program: MathProgram } | { ok: false; error: MathExpressionError };

type TokenKind = "number" | "name" | "op" | "(" | ")" | "," | "." | "=" | "sep" | "end";
type Token = { kind: TokenKind; text: string; pos: MathPosition };

/** The 1-based line and column of `pos` in `source`. */
export function mathPositionLineColumn(source: string, pos: MathPosition): { line: number; column: number } {
  let line = 1;
  let start = 0;
  for (let i = 0; i < pos && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) {
      line++;
      start = i + 1;
    }
  }
  return { line, column: pos - start + 1 };
}

class MathSyntaxError extends Error {
  readonly code: MathExpressionErrorCode;
  readonly pos: MathPosition;
  constructor(code: MathExpressionErrorCode, message: string, pos: MathPosition) {
    super(message);
    this.code = code;
    this.pos = pos;
  }
}

const NUMBER = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*/;
const OPERATORS = "+-*/%^";

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === " " || ch === "\t" || ch === "\r") {
      i++;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      // A comment runs to the end of its line.
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "\n" || ch === ";") {
      tokens.push({ kind: "sep", text: ch, pos: i });
      i++;
      continue;
    }
    const rest = source.slice(i);
    const number = NUMBER.exec(rest);
    if (number) {
      tokens.push({ kind: "number", text: number[0], pos: i });
      i += number[0].length;
      continue;
    }
    const name = NAME.exec(rest);
    if (name) {
      tokens.push({ kind: "name", text: name[0], pos: i });
      i += name[0].length;
      continue;
    }
    if (OPERATORS.includes(ch)) {
      tokens.push({ kind: "op", text: ch, pos: i });
      i++;
      continue;
    }
    if (ch === "(" || ch === ")" || ch === "," || ch === "." || ch === "=") {
      tokens.push({ kind: ch, text: ch, pos: i });
      i++;
      continue;
    }
    throw new MathSyntaxError("mathExpression.parse", `Unexpected character '${printable(ch)}'`, i);
  }
  tokens.push({ kind: "end", text: "", pos: source.length });
  return tokens;
}

function printable(ch: string): string {
  const code = ch.codePointAt(0) ?? 0;
  return code < 32 || code === 127 ? `U+${code.toString(16).toUpperCase().padStart(4, "0")}` : ch;
}

function describe(token: Token): string {
  if (token.kind === "end") return "the end of the formula";
  if (token.kind === "sep") return token.text === ";" ? "';'" : "the end of the line";
  return `'${token.text}'`;
}

const AXES: ReadonlySet<string> = new Set(["x", "y", "z", "w"]);

class Parser {
  private index = 0;
  private depth = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.index]!;
  }

  private next(): Token {
    return this.tokens[this.index++]!;
  }

  /** Line breaks inside an expression that cannot end yet (after an operator, inside parentheses). */
  private skipLineBreaks(): void {
    while (this.peek().kind === "sep" && this.peek().text === "\n") this.index++;
  }

  private expect(kind: TokenKind, what: string): Token {
    const token = this.peek();
    if (token.kind !== kind) throw new MathSyntaxError("mathExpression.parse", `Expected ${what} but found ${describe(token)}`, token.pos);
    return this.next();
  }

  private enter(pos: MathPosition): void {
    if (++this.depth > MATH_EXPRESSION_MAX_DEPTH) {
      throw new MathSyntaxError("mathExpression.limit", `The formula nests more than ${MATH_EXPRESSION_MAX_DEPTH} levels deep`, pos);
    }
  }

  private leave(): void {
    this.depth--;
  }

  program(): MathProgram {
    const statements: MathStatement[] = [];
    for (;;) {
      while (this.peek().kind === "sep") this.index++;
      if (this.peek().kind === "end") break;
      if (statements.length === MATH_EXPRESSION_MAX_STATEMENTS) {
        throw new MathSyntaxError("mathExpression.limit", `The formula has more than ${MATH_EXPRESSION_MAX_STATEMENTS} statements`, this.peek().pos);
      }
      statements.push(this.statement());
      const after = this.peek();
      if (after.kind !== "sep" && after.kind !== "end") {
        throw new MathSyntaxError("mathExpression.parse", `Expected an operator or the end of the statement but found ${describe(after)}`, after.pos);
      }
    }
    return { statements };
  }

  private statement(): MathStatement {
    const first = this.peek();
    const local = first.kind === "name" && first.text === "let";
    if (local) this.next();
    const target = this.peek();
    if (target.kind === "name" && this.tokens[this.index + 1]?.kind === "=") {
      this.name(target);
      this.index += 2;
      this.skipLineBreaks();
      return { kind: "assign", name: target.text, local, expr: this.expression(), pos: target.pos };
    }
    if (local) throw new MathSyntaxError("mathExpression.parse", "Expected a name and '=' after 'let'", target.pos);
    return { kind: "expr", expr: this.expression(), pos: first.pos };
  }

  private name(token: Token): void {
    if (token.text.length > MATH_EXPRESSION_MAX_NAME_LENGTH) {
      throw new MathSyntaxError("mathExpression.limit", `Names are at most ${MATH_EXPRESSION_MAX_NAME_LENGTH} characters long`, token.pos);
    }
  }

  private expression(): MathExpr {
    let left = this.term();
    for (;;) {
      const token = this.peek();
      if (token.kind !== "op" || (token.text !== "+" && token.text !== "-")) return left;
      this.next();
      this.skipLineBreaks();
      left = { kind: "binary", op: token.text, left, right: this.term(), pos: token.pos };
    }
  }

  private term(): MathExpr {
    let left = this.unary();
    for (;;) {
      const token = this.peek();
      if (token.kind !== "op" || (token.text !== "*" && token.text !== "/" && token.text !== "%")) return left;
      this.next();
      this.skipLineBreaks();
      left = { kind: "binary", op: token.text, left, right: this.unary(), pos: token.pos };
    }
  }

  /** Unary minus binds looser than `^`: `-a^2` is `-(a^2)`. */
  private unary(): MathExpr {
    const token = this.peek();
    if (token.kind === "op" && token.text === "-") {
      this.next();
      this.skipLineBreaks();
      this.enter(token.pos);
      const arg = this.unary();
      this.leave();
      return { kind: "negate", arg, pos: token.pos };
    }
    return this.power();
  }

  /** `^` is right-associative and its exponent may be negated: `a^-b^c` is `a^(-(b^c))`. */
  private power(): MathExpr {
    const base = this.postfix();
    const token = this.peek();
    if (token.kind !== "op" || token.text !== "^") return base;
    this.next();
    this.skipLineBreaks();
    this.enter(token.pos);
    const exponent = this.unary();
    this.leave();
    return { kind: "binary", op: "^", left: base, right: exponent, pos: token.pos };
  }

  private postfix(): MathExpr {
    let expr = this.primary();
    while (this.peek().kind === ".") {
      const dot = this.next();
      const axis = this.peek();
      if (axis.kind !== "name" || !AXES.has(axis.text)) {
        throw new MathSyntaxError("mathExpression.parse", `Expected x, y, z or w after '.' but found ${describe(axis)}`, axis.pos);
      }
      this.next();
      expr = { kind: "member", object: expr, axis: axis.text as MathAxis, pos: dot.pos };
    }
    return expr;
  }

  private primary(): MathExpr {
    const token = this.peek();
    if (token.kind === "number") {
      this.next();
      const value = Number(token.text);
      if (!Number.isFinite(value)) throw new MathSyntaxError("mathExpression.parse", `The number ${token.text} is too large`, token.pos);
      return { kind: "number", value, text: token.text, pos: token.pos };
    }
    if (token.kind === "name") {
      this.next();
      this.name(token);
      if (token.text === "let") throw new MathSyntaxError("mathExpression.parse", "'let' starts a statement", token.pos);
      if (this.peek().kind !== "(") return { kind: "name", name: token.text, pos: token.pos };
      this.next();
      this.enter(token.pos);
      const args: MathExpr[] = [];
      this.skipLineBreaks();
      if (this.peek().kind !== ")") {
        for (;;) {
          this.skipLineBreaks();
          args.push(this.expression());
          this.skipLineBreaks();
          if (this.peek().kind !== ",") break;
          this.next();
        }
      }
      this.expect(")", "',' or ')'");
      this.leave();
      return { kind: "call", name: token.text, args, pos: token.pos };
    }
    if (token.kind === "(") {
      this.next();
      this.enter(token.pos);
      this.skipLineBreaks();
      const inner = this.expression();
      this.skipLineBreaks();
      this.expect(")", "')'");
      this.leave();
      return inner;
    }
    throw new MathSyntaxError("mathExpression.parse", `Expected a number, a name or '(' but found ${describe(token)}`, token.pos);
  }
}

/** A formula error with its line and column. */
export function mathExpressionError(source: string, code: MathExpressionErrorCode, message: string, pos: MathPosition): MathExpressionError {
  return { code, message, pos, ...mathPositionLineColumn(source, pos) };
}

/** Tokenizes and parses `source`; never throws. */
export function parseMathExpression(source: string): MathParseResult {
  if (source.length > MATH_EXPRESSION_MAX_LENGTH) {
    return {
      ok: false,
      error: mathExpressionError(source, "mathExpression.limit", `The formula is longer than ${MATH_EXPRESSION_MAX_LENGTH} characters`, MATH_EXPRESSION_MAX_LENGTH),
    };
  }
  try {
    return { ok: true, program: new Parser(tokenize(source)).program() };
  } catch (error) {
    if (error instanceof MathSyntaxError) return { ok: false, error: mathExpressionError(source, error.code, error.message, error.pos) };
    throw error;
  }
}
