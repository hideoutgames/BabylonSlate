import { describe, expect, it } from "vitest";
import { loadLatest } from "./load-latest";

describe("loadLatest", () => {
  it("ignores a stale load after cancel", async () => {
    const applied: string[] = [];
    let resolveFirst: (value: string) => void = () => {};
    const first = new Promise<string>((resolve) => {
      resolveFirst = resolve;
    });
    const cancel = loadLatest(() => first, (value) => {
      applied.push(value);
    });
    cancel();
    resolveFirst("stale");
    await first;
    expect(applied).toEqual([]);
  });

  it("applies the load that is still current", async () => {
    const applied: string[] = [];
    await new Promise<void>((resolve) => {
      loadLatest(
        async () => "fresh",
        (value) => {
          applied.push(value);
          resolve();
        },
      );
    });
    expect(applied).toEqual(["fresh"]);
  });
});
