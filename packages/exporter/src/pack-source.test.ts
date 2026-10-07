import { describe, expect, it } from "vitest";
import { encodeBabpack } from "./babpack";
import { createHttpPackSource, createMemoryPackSource } from "./pack-source";

describe("pack sources", () => {
  it("rejects an incorrectly labelled partial response and counts its actual body", async () => {
    const source = createHttpPackSource("boot.babpack", undefined, async () => new Response(new Uint8Array(8), { status: 206, headers: { "Content-Range": "bytes 10-17/100" } }));
    await expect(source.read("a")).rejects.toThrow(/range response/);
    expect(source.getReadMetrics?.()).toMatchObject({ actualBytesRead: 8, rangeReads: 1 });
  });
  it("rejects corrupted in-memory payloads against the packed hash", async () => {
    const pack = await encodeBabpack([{ guid: "a", bytes: new Uint8Array([1, 2]) }]);
    pack[pack.length - 1] = 9;
    await expect(createMemoryPackSource(pack).read("a")).rejects.toThrow(/Corrupt/);
  });

  it.each([true, false])("shares the index probe across simultaneous reads (range-capable=%s)", async (rangesSupported) => {
    const pack = await encodeBabpack([{ guid: "a", bytes: new Uint8Array([1]) }, { guid: "b", bytes: new Uint8Array([2]) }]);
    const ranges: string[] = [];
    const source = createHttpPackSource("boot.babpack", undefined, async (_url, init) => {
      const range = new Headers(init?.headers).get("Range") ?? "";
      ranges.push(range);
      await Promise.resolve();
      if (!rangesSupported) return new Response(pack, { status: 200 });
      const match = /^bytes=(\d+)-(\d+)$/.exec(range)!;
      return new Response(pack.subarray(Number(match[1]), Number(match[2]) + 1), { status: 206, headers: { "Content-Range": `bytes ${match[1]}-${match[2]}/${pack.byteLength}` } });
    });
    expect(await Promise.all([source.read("a"), source.read("b")])).toEqual([new Uint8Array([1]), new Uint8Array([2])]);
    expect(ranges.filter((range) => range === "bytes=0-7")).toHaveLength(1);
    expect(ranges).toHaveLength(rangesSupported ? 4 : 1);
  });

  it("retries an index request after a shared failure", async () => {
    const pack = await encodeBabpack([{ guid: "a", bytes: new Uint8Array([1]) }]);
    let attempts = 0;
    const source = createHttpPackSource("boot.babpack", undefined, async () => {
      if (++attempts === 1) throw new Error("Offline");
      return new Response(pack, { status: 200 });
    });
    const failures = await Promise.allSettled([source.read("a"), source.read("a")]);
    expect(failures.every((result) => result.status === "rejected")).toBe(true);
    expect(await source.read("a")).toEqual(new Uint8Array([1]));
    expect(attempts).toBe(2);
  });
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
    const ranges: string[] = [];
    const fetchFn: typeof fetch = async (_url, init) => {
      const range = String(
        (init?.headers as Record<string, string> | undefined)?.Range ?? "",
      );
      ranges.push(range);
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
    expect(ranges[0]).toBe("bytes=0-7");
    expect(ranges).toContain(
      `bytes=${entry.offset}-${entry.offset + entry.length - 1}`,
    );
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
    expect(source.getReadMetrics?.()).toMatchObject({ fullReads: 1, actualBytesRead: pack.byteLength, requestedBytes: 8 });
  });
});
