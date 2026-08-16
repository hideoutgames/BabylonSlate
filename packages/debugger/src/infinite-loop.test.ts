import { describe, expect, it } from "vitest";
import {
  DEFAULT_INFINITE_LOOP_COUNT,
  INFINITE_LOOP_DIAGNOSTIC_CODE,
  INFINITE_LOOP_ERROR_MESSAGE,
  InfiniteLoopError,
  createInfiniteLoopGuard,
  instrumentJsLoops,
  isInfiniteLoopError,
} from "./infinite-loop";

describe("InfiniteLoopError", () => {
  it("uses a stable name and Infinite loop detected message", () => {
    const error = new InfiniteLoopError();
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("InfiniteLoopError");
    expect(error.message).toBe(INFINITE_LOOP_ERROR_MESSAGE);
    expect(error.message).toBe("Infinite loop detected");
    expect(INFINITE_LOOP_DIAGNOSTIC_CODE).toBe("runtime.infinite_loop");
    expect(DEFAULT_INFINITE_LOOP_COUNT).toBe(1_000_000);
    expect(isInfiniteLoopError(error)).toBe(true);
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
});
