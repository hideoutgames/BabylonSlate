import { describe, expect, it } from "vitest";
import { encodeBabpack } from "./babpack";
import { createHttpPackSource, createMemoryPackSource } from "./pack-source";

describe("pack sources", () => {
  it("reads an asset from an in-memory pack", async () => {
    const bytes = new TextEncoder().encode("payload");
    const pack = await encodeBabpack([{ guid: "a", bytes }]);
    const source = createMemoryPackSource(pack);
    expect(await source.read("a")).toEqual(bytes);
  });

  it("uses HTTP range bytes when the server returns 206", async () => {
    const bytes = new TextEncoder().encode("abcdefghij");
    const pack = await encodeBabpack([{ guid: "a", bytes }]);
    const decoded = (await import("./babpack")).decodeBabpack(pack);
    const entry = decoded.entries[0]!;
    const fetchFn: typeof fetch = async (_url, init) => {
      const range = String(
        (init?.headers as Record<string, string> | undefined)?.Range ?? "",
      );
      expect(range).toBe(`bytes=${entry.offset}-${entry.offset + entry.length - 1}`);
      const slice = pack.subarray(entry.offset, entry.offset + entry.length);
      return new Response(slice, {
        status: 206,
        headers: { "Content-Range": `bytes ${entry.offset}-${entry.offset + entry.length - 1}/${pack.byteLength}` },
      });
    };
    const source = createHttpPackSource("boot.babpack", undefined, fetchFn);
    expect(await source.read("a")).toEqual(bytes);
  });

  it("range-capable servers never need a whole-pack GET", async () => {
    const bytes = new TextEncoder().encode("range-first");
    const pack = await encodeBabpack([{ guid: "a", bytes }]);
    const decoded = (await import("./babpack")).decodeBabpack(pack);
    const entry = decoded.entries[0]!;
    const fetches: Array<{ range: string | null }> = [];
    const fetchFn: typeof fetch = async (_url, init) => {
      const range =
        (init?.headers as Record<string, string> | undefined)?.Range ?? null;
      fetches.push({ range });
      if (!range) {
        throw new Error("range-capable server must not receive a whole GET");
      }
      const match = /^bytes=(\d+)-(\d+)$/.exec(range);
      expect(match).not.toBeNull();
      const start = Number(match![1]);
      const end = Number(match![2]) + 1;
      return new Response(pack.subarray(start, end), {
        status: 206,
        headers: {
          "Content-Range": `bytes ${start}-${end - 1}/${pack.byteLength}`,
        },
      });
    };
    const source = createHttpPackSource("boot.babpack", undefined, fetchFn);
    expect(await source.read("a")).toEqual(bytes);
    expect(fetches.every((item) => item.range)).toBe(true);
    expect(entry.length).toBe(bytes.byteLength);
  });

  it("falls back to a whole-pack fetch when the server ignores Range", async () => {
    const bytes = new TextEncoder().encode("whole-body");
    const pack = await encodeBabpack([{ guid: "a", bytes }]);
    let rangeAsked = false;
    const fetchFn: typeof fetch = async (_url, init) => {
      if (init?.headers && "Range" in (init.headers as Record<string, string>)) {
        rangeAsked = true;
        return new Response(pack, { status: 200 });
      }
      return new Response(pack, { status: 200 });
    };
    const source = createHttpPackSource("boot.babpack", undefined, fetchFn);
    expect(await source.read("a")).toEqual(bytes);
    expect(rangeAsked).toBe(true);
  });
});
