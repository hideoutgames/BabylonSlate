import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useThumbnailUrls } from "./use-thumbnail-urls";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

let created = 0;
const revoked: string[] = [];
const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };

beforeEach(() => {
  created = 0;
  revoked.length = 0;
  URL.createObjectURL = vi.fn(() => `blob:${++created}`);
  URL.revokeObjectURL = vi.fn((url: string) => {
    revoked.push(url);
  });
});

afterEach(() => {
  cleanup();
  URL.createObjectURL = original.create;
  URL.revokeObjectURL = original.revoke;
});

type Props = { guids: string[]; versions: Record<string, number>; enabled: boolean };

function renderUrls(load: (guid: string) => Promise<Uint8Array | null>, initial: Props) {
  return renderHook(
    ({ guids, versions, enabled }: Props) => useThumbnailUrls(guids, load, versions, enabled),
    { initialProps: initial },
  );
}

describe("useThumbnailUrls", () => {
  it("reloads only a bumped thumbnail and keeps the other images meanwhile", async () => {
    const load = vi.fn(async () => PNG);
    const { result, rerender } = renderUrls(load, { guids: ["a", "b"], versions: {}, enabled: true });
    await waitFor(() => expect(result.current).toEqual({ a: "blob:1", b: "blob:2" }));
    load.mockClear();

    let finish!: (bytes: Uint8Array) => void;
    load.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    rerender({ guids: ["a", "b"], versions: { b: 1 }, enabled: true });
    expect(load).toHaveBeenCalledExactlyOnceWith("b");
    // While the new image loads, both cards keep showing theirs.
    expect(result.current).toEqual({ a: "blob:1", b: "blob:2" });
    expect(revoked).toEqual([]);

    await act(async () => finish(PNG));
    expect(result.current).toEqual({ a: "blob:1", b: "blob:3" });
    expect(revoked).toEqual(["blob:2"]);
  });

  it("releases replaced URLs when React renders only a later commit of the same sync", async () => {
    const load = vi.fn(async (): Promise<Uint8Array | null> => PNG);
    const { result, rerender } = renderUrls(load, { guids: ["a", "b", "c", "d"], versions: {}, enabled: true });
    await waitFor(() => expect(result.current).toEqual({ a: "blob:1", b: "blob:2", c: "blob:3", d: "blob:4" }));

    // The first batch replaces a-d; the second only adds e and drops nothing.
    const held: Array<() => void> = [];
    load.mockImplementation((guid: string) => guid === "e"
      ? Promise.resolve(PNG)
      : new Promise((resolve) => { held.push(() => resolve(PNG)); }));
    rerender({ guids: ["a", "b", "c", "d", "e"], versions: { a: 1, b: 1, c: 1, d: 1 }, enabled: true });
    expect(held).toHaveLength(4);
    // Both commits land before React renders, so it renders only the second map.
    await act(async () => {
      for (const release of held) release();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(result.current).toEqual({ a: "blob:5", b: "blob:6", c: "blob:7", d: "blob:8", e: "blob:9" });
    expect(revoked).toEqual(["blob:1", "blob:2", "blob:3", "blob:4"]);
  });

  it("releases the URL of a guid that leaves the list, and every URL when disabled", async () => {
    const load = vi.fn(async () => PNG);
    const { result, rerender } = renderUrls(load, { guids: ["a", "b"], versions: {}, enabled: true });
    await waitFor(() => expect(result.current).toEqual({ a: "blob:1", b: "blob:2" }));

    rerender({ guids: ["a"], versions: {}, enabled: true });
    await waitFor(() => expect(result.current).toEqual({ a: "blob:1" }));
    expect(revoked).toEqual(["blob:2"]);
    expect(load).toHaveBeenCalledTimes(2);

    rerender({ guids: ["a"], versions: {}, enabled: false });
    await waitFor(() => expect(result.current).toEqual({}));
    expect(revoked).toEqual(["blob:2", "blob:1"]);
  });
});
