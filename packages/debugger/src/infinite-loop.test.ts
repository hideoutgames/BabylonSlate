import { describe, expect, it } from "vitest";
import {
  InfiniteLoopError,
  createInfiniteLoopGuard,
  instrumentJsLoops,
  isInfiniteLoopError,
} from "./infinite-loop";

describe("InfiniteLoopError", () => {
  it("is recognised by type rather than by its message", () => {
    expect(isInfiniteLoopError(new InfiniteLoopError())).toBe(true);
    expect(isInfiniteLoopError(new Error("Infinite loop detected"))).toBe(false);
  });
});

describe("createInfiniteLoopGuard", () => {
  it("throws after loopCount checks in one tick", () => {
    const guard = createInfiniteLoopGuard({ enabled: true, loopCount: 3 });
    guard.check();
    guard.check();
    guard.check();
    expect(() => guard.check()).toThrow(InfiniteLoopError);
  });

  it("resets the count at the start of a new tick", () => {
    const guard = createInfiniteLoopGuard({ enabled: true, loopCount: 2 });
    guard.check();
    guard.check();
    expect(() => guard.check()).toThrow(InfiniteLoopError);
    guard.reset();
    expect(() => {
      guard.check();
      guard.check();
    }).not.toThrow();
  });

  it("no-ops when detection is disabled", () => {
    const guard = createInfiniteLoopGuard({ enabled: false, loopCount: 1 });
    expect(() => {
      for (let i = 0; i < 20; i++) guard.check();
    }).not.toThrow();
  });
});

describe("instrumentJsLoops", () => {
  const check = "ctx.checkInfiniteLoop()";

  it("injects a check into a while body", () => {
    const out = instrumentJsLoops("while (true) { x++; }", check);
    expect(out).toContain("while (true) {");
    expect(out).toContain("ctx.checkInfiniteLoop();");
    expect(out.indexOf("ctx.checkInfiniteLoop()")).toBeLessThan(out.indexOf("x++"));
  });

  it("injects a check into a for body", () => {
    const out = instrumentJsLoops("for (;;) { x++; }", check);
    expect(out).toContain("for (;;) {");
    expect(out).toContain("ctx.checkInfiniteLoop();");
  });

  it("injects a check into a do-while body", () => {
    const out = instrumentJsLoops("do { x++; } while (true);", check);
    expect(out).toMatch(/do\s*\{/);
    expect(out).toContain("ctx.checkInfiniteLoop();");
    expect(out.indexOf("ctx.checkInfiniteLoop()")).toBeLessThan(out.indexOf("x++"));
  });

  it("wraps an empty while (true); so the check still runs", () => {
    const out = instrumentJsLoops("while (true);", check);
    expect(out).toContain("ctx.checkInfiniteLoop();");
    expect(out).not.toMatch(/while\s*\(\s*true\s*\)\s*;/);
  });

  it("injects a check into nested while bodies", () => {
    const out = instrumentJsLoops(
      "while (a) { while (b) { x++; } }",
      check,
    );
    expect(out.match(/ctx\.checkInfiniteLoop\(\);/g)?.length).toBe(2);
  });

  it("does not rewrite loops that appear in strings or comments", () => {
    const source = [
      `const a = "while (true) { }";`,
      `const b = 'for (;;) { }';`,
      `// while (true) { x++; }`,
      `/* do { y++; } while (true); */`,
      `x++;`,
    ].join("\n");
    const out = instrumentJsLoops(source, check);
    expect(out).toBe(source);
  });

  it("leaves regex literals, including ones after return, and property names alone", () => {
    const source = [
      `const key = Symbol.for("k");`,
      `const looksLikeLoop = (s) => { return /while (x) {/.test(s); };`,
      `const slashes = /[/)]while (y) {/;`,
    ].join("\n");
    expect(instrumentJsLoops(source, check)).toBe(source);
  });

  function run(body: string): { result: unknown; checks: number } {
    let checks = 0;
    const ctx = { checkInfiniteLoop: () => void (checks += 1) };
    const result = new Function("ctx", instrumentJsLoops(body, check))(ctx) as unknown;
    return { result, checks };
  }

  it.each([
    {
      name: "a loop after a postfix increment and division",
      body: "let n = 0; n++ / 2; while (n < 4) n++; return n;",
      result: 4,
      checks: 3,
    },
    {
      name: "a header regex whose character class holds / and )",
      body: "let n = 0; while (/[/)]/.test('a)') && n < 2) n++; return n;",
      result: 2,
      checks: 2,
    },
    {
      name: "an unbraced if body followed by another statement",
      body: [
        "let used = 0, cleaned = 0;",
        "for (const ok of [true, false, true]) if (ok) { used++; } cleaned++;",
        "return [used, cleaned];",
      ].join("\n"),
      result: [2, 1],
      checks: 3,
    },
    {
      name: "an unbraced body ended by a line break",
      body: "let n = 3, after = 0\nwhile (n) n--\nafter++\nreturn [n, after]",
      result: [0, 1],
      checks: 3,
    },
    {
      name: "an unbraced body before an outer else",
      body: "let n = 2, other = 0; if (n > 5) while (n) n--; else other = 1; return [n, other];",
      result: [2, 1],
      checks: 0,
    },
    {
      name: "a loop inside another loop's header",
      body: [
        "let total = 0;",
        "for (const x of [3].map((n) => { while (n > 1) n--; return n; })) total += x;",
        "return total;",
      ].join("\n"),
      result: 1,
      checks: 3,
    },
    {
      name: "do-while with a template substitution or an unbraced if/else body",
      body: [
        "let n = 3, s = '', odd = 0, even = 0;",
        "do { s += `${n}`; } while (--n);",
        "n = 3;",
        "do if (n % 2) odd++; else even++; while (--n);",
        "return [s, odd, even];",
      ].join("\n"),
      result: ["321", 2, 1],
      checks: 6,
    },
  ])("guards $name without changing what runs", ({ body, result, checks }) => {
    expect(run(body)).toEqual({ result, checks });
  });

  it("guards for await bodies", async () => {
    let checks = 0;
    const ctx = { checkInfiniteLoop: () => void (checks += 1) };
    const body =
      "return (async () => { let t = 0; for await (const x of [1, 2]) t += x; return t; })();";
    const start = new Function("ctx", instrumentJsLoops(body, check)) as (
      context: typeof ctx,
    ) => Promise<number>;
    await expect(start(ctx)).resolves.toBe(3);
    expect(checks).toBe(2);
  });
});
