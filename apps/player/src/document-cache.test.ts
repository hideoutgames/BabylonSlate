import { describe, expect, it } from "vitest";
import { DocumentCache } from "./document-cache";

const documentOf = (bytes: number) => ({ bytes: new Uint8Array(bytes), document: { bytes }, value: undefined });

describe("DocumentCache", () => {
  it("answers only for the revision it holds", () => {
    const cache = new DocumentCache();
    const entry = documentOf(10);
    cache.set("scene", "r1", entry);
    expect(cache.get("scene", "r1")?.document).toBe(entry.document);
    expect(cache.get("scene", "r2")).toBeUndefined();
    cache.set("scene", "r2", documentOf(20));
    expect(cache.get("scene", "r1")).toBeUndefined();
    // Replacing an entry releases its cost.
    expect(cache.bytes).toBe(60);
  });

  it("costs each entry three times its bytes and evicts the least recently used past the budget", () => {
    // Three 10-byte documents cost 90 bytes: a 100-byte budget holds three, not four.
    const cache = new DocumentCache(100);
    cache.set("a", "r", documentOf(10));
    cache.set("b", "r", documentOf(10));
    cache.set("c", "r", documentOf(10));
    expect(cache.bytes).toBe(90);
    // Using "a" makes "b" the least recently used.
    expect(cache.get("a", "r")).toBeDefined();
    cache.set("d", "r", documentOf(10));
    expect(["a", "b", "c", "d"].filter(guid => cache.has(guid))).toEqual(["a", "c", "d"]);
    expect(cache.bytes).toBe(90);
    // One large document pushes out as many as it needs.
    cache.set("e", "r", documentOf(20));
    expect(["a", "c", "d", "e"].filter(guid => cache.has(guid))).toEqual(["d", "e"]);
    expect(cache.bytes).toBe(90);
  });

  it("does not keep a document larger than the whole budget, nor evict others for it", () => {
    const cache = new DocumentCache(100);
    cache.set("small", "r", documentOf(10));
    cache.set("huge", "r", documentOf(34));
    expect(cache.has("huge")).toBe(false);
    expect(cache.has("small")).toBe(true);
    expect(cache.bytes).toBe(30);
  });
});
