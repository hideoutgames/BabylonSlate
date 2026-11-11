import { describe, expect, it } from "vitest";
import { TickWait } from "./tick-wait";

describe("TickWait", () => {
  it("resumes its waiters in the stack that settles it, in the order they waited", () => {
    let settle!: (value: number) => void;
    const wait = TickWait.start<number>((resolve) => { settle = resolve; });
    const seen: string[] = [];
    wait.then((value) => { seen.push(`first ${value}`); });
    wait.then((value) => { seen.push(`second ${value}`); });
    expect(seen).toEqual([]);
    settle(3);
    // No await: a Promise would not have called back yet.
    expect(seen).toEqual(["first 3", "second 3"]);
    wait.then((value) => { seen.push(`late ${value}`); });
    expect(seen).toEqual(["first 3", "second 3", "late 3"]);
  });

  it("chains like a Promise: results pass on, a throw rejects the next wait, and a rejection skips to its handler", () => {
    const seen: unknown[] = [];
    TickWait.from(1)
      .then((value) => value + 1)
      .then((value) => { throw new Error(`failed at ${value}`); })
      .then(() => { seen.push("skipped"); })
      .then(undefined, (error) => { seen.push((error as Error).message); return "recovered"; })
      .then((value) => { seen.push(value); });
    expect(seen).toEqual(["failed at 2", "recovered"]);
  });

  it("follows a wait a callback returns: another TickWait at once, a Promise when it settles", async () => {
    let settleInner!: (value: string) => void;
    const inner = TickWait.start<string>((resolve) => { settleInner = resolve; });
    const seen: string[] = [];
    TickWait.from("outer").then(() => inner).then((value) => { seen.push(value); });
    TickWait.from("outer").then(() => Promise.resolve("promised")).then((value) => { seen.push(value); });
    settleInner("inner");
    expect(seen).toEqual(["inner"]);
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual(["inner", "promised"]);
  });

  it("is awaitable, and settles once", async () => {
    let settle!: (value: string) => void;
    let fail!: (error: unknown) => void;
    const wait = TickWait.start<string>((resolve, reject) => { settle = resolve; fail = reject; });
    settle("first");
    fail(new Error("ignored"));
    settle("ignored");
    expect(await wait).toBe("first");
  });
});
