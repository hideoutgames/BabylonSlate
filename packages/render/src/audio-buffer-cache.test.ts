import { describe, expect, it } from "vitest";
import { AUDIO_DECODED_PCM_LRU_BYTES } from "@babylonslate/assets";
import { AudioBufferCache } from "./audio-buffer-cache";

describe("AudioBufferCache", () => {
  it("accounts decoded PCM separately from the texture cache ceiling", () => {
    const cache = new AudioBufferCache({ byteCeiling: 64 });
    cache.put("a", new Uint8Array(40), 40);
    expect(cache.get("a")?.byteLength).toBe(40);
    expect(cache.accountedBytes()).toBe(40);
    expect(AUDIO_DECODED_PCM_LRU_BYTES).toBe(256 * 1024 * 1024);
  });

  it("trims unpinned entries when the ceiling is lowered", () => {
    const evicted: string[] = [];
    const cache = new AudioBufferCache({
      byteCeiling: 100,
      onEvict: (guid) => evicted.push(guid),
    });
    cache.put("old", new Uint8Array(40), 40);
    cache.put("fresh", new Uint8Array(40), 40);
    cache.setByteCeiling(50);
    expect(evicted).toContain("old");
    expect(cache.get("fresh")?.byteLength).toBe(40);
    expect(cache.accountedBytes()).toBe(40);
  });

  it("skips eviction when the budget is disabled", () => {
    const evicted: string[] = [];
    const cache = new AudioBufferCache({
      byteCeiling: 50,
      onEvict: (guid) => evicted.push(guid),
    });
    cache.setBudgetEnabled(false);
    cache.put("a", new Uint8Array(40), 40);
    cache.put("b", new Uint8Array(40), 40);
    expect(evicted).toEqual([]);
    expect(cache.accountedBytes()).toBe(80);
  });

  it("evicts unpinned LRU entries when the ceiling is exceeded", () => {
    const evicted: string[] = [];
    const cache = new AudioBufferCache({
      byteCeiling: 50,
      onEvict: (guid) => evicted.push(guid),
    });
    cache.put("old", new Uint8Array(30), 30);
    cache.put("fresh", new Uint8Array(30), 30);
    expect(cache.get("old")).toBeUndefined();
    expect(cache.get("fresh")?.byteLength).toBe(30);
    expect(evicted).toEqual(["old"]);
    expect(cache.accountedBytes()).toBe(30);
  });

  it("pins active voices so their buffers survive LRU eviction", () => {
    const cache = new AudioBufferCache({ byteCeiling: 50 });
    cache.put("pinned", new Uint8Array(30), 30);
    cache.pin("pinned");
    cache.put("other", new Uint8Array(30), 30);
    expect(cache.get("pinned")?.byteLength).toBe(30);
    expect(cache.get("other")?.byteLength).toBe(30);
    expect(cache.accountedBytes()).toBe(60);
    cache.unpin("pinned");
    cache.put("third", new Uint8Array(30), 30);
    expect(cache.get("pinned")).toBeUndefined();
    cache.dispose();
    expect(cache.accountedBytes()).toBe(0);
    expect(cache.get("other")).toBeUndefined();
  });
});
