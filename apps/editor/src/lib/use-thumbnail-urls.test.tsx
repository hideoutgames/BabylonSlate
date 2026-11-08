import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useThumbnailUrls } from "./use-thumbnail-urls";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

type Props = {
  guids: readonly string[];
  versions: Record<string, number>;
  enabled: boolean;
};

const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
let created = 0;
// Each read waits here until the test lets it finish.
let pending: Map<string, (bytes: Uint8Array | null) => void>;
let load: ReturnType<typeof vi.fn<(guid: string) => Promise<Uint8Array | null>>>;
let revokeObjectURL: ReturnType<typeof vi.fn<(url: string) => void>>;
// Every map the hook returned, in render order.
let renders: Array<Record<string, string>>;
// URLs revoked while the latest rendered map still showed them.
let revokedWhileShown: string[];

beforeEach(() => {
  created = 0;
  pending = new Map();
  renders = [];
  revokedWhileShown = [];
  load = vi.fn((guid: string) => new Promise<Uint8Array | null>((resolve) => pending.set(guid, resolve)));
  revokeObjectURL = vi.fn((url: string) => {
    if (Object.values(renders.at(-1) ?? {}).includes(url)) revokedWhileShown.push(url);
  });
  URL.createObjectURL = vi.fn(() => `blob:${++created}`);
  URL.revokeObjectURL = revokeObjectURL;
});

afterEach(() => {
  cleanup();
  URL.createObjectURL = original.create;
  URL.revokeObjectURL = original.revoke;
});

function renderThumbnails(initialProps: Props) {
  return renderHook(
    ({ guids, versions, enabled }: Props) => {
      const urls = useThumbnailUrls(guids, load, versions, enabled);
      renders.push(urls);
      return urls;
    },
    { initialProps },
  );
}

/** Lets the named reads finish with a thumbnail, then lets the hook commit and render. */
async function finish(...guids: string[]) {
  await act(async () => {
    for (const guid of guids) {
      const resolve = pending.get(guid);
      if (!resolve) throw new Error(`${guid} was not requested`);
      pending.delete(guid);
      resolve(PNG);
    }
  });
}

function requested(): string[] {
  return load.mock.calls.map(([guid]) => guid);
}

describe("useThumbnailUrls", () => {
  it("keeps every other card's image and the regenerated card's old one until its new thumbnail is read", async () => {
    const guids = ["a", "b", "c"];
    const { result, rerender } = renderThumbnails({ guids, versions: {}, enabled: true });
    await finish("a", "b", "c");
    const before = result.current;
    expect(Object.keys(before)).toEqual(["a", "b", "c"]);
    load.mockClear();

    // A thumbnail written for an asset this list does not show reads nothing and keeps the same map.
    rerender({ guids, versions: { other: 1 }, enabled: true });
    await act(async () => {});
    expect(load).not.toHaveBeenCalled();
    expect(result.current).toBe(before);

    const rendered = renders.length;
    rerender({ guids, versions: { other: 1, b: 1 }, enabled: true });
    await act(async () => {});
    expect(requested()).toEqual(["b"]);
    expect(result.current).toEqual(before);

    await finish("b");
    expect(result.current).toEqual({ a: before.a, b: expect.any(String), c: before.c });
    expect(result.current.b).not.toBe(before.b);
    // No render in between went blank or lost a card.
    for (const urls of renders.slice(rendered)) {
      expect(urls).toMatchObject({ a: before.a, c: before.c, b: expect.any(String) });
    }
    expect(revokeObjectURL.mock.calls).toEqual([[before.b]]);
    expect(revokedWhileShown).toEqual([]);
  });

  it("shows first loads in batches of four as each batch is read", async () => {
    renderThumbnails({ guids: ["a", "b", "c", "d", "e", "f"], versions: {}, enabled: true });
    await act(async () => {});
    expect(requested()).toEqual(["a", "b", "c", "d"]);
    expect(renders.at(-1)).toEqual({});

    await finish("a", "b", "c", "d");
    expect(Object.keys(renders.at(-1)!)).toEqual(["a", "b", "c", "d"]);
    expect(requested()).toEqual(["a", "b", "c", "d", "e", "f"]);

    await finish("e", "f");
    expect(Object.keys(renders.at(-1)!)).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("releases the image of an asset that leaves the list once the list without it has rendered", async () => {
    const { result, rerender } = renderThumbnails({ guids: ["a", "b"], versions: {}, enabled: true });
    await finish("a", "b");
    const before = result.current;
    load.mockClear();

    rerender({ guids: ["a"], versions: {}, enabled: true });
    await act(async () => {});
    expect(load).not.toHaveBeenCalled();
    expect(result.current).toEqual({ a: before.a });
    expect(revokeObjectURL.mock.calls).toEqual([[before.b]]);
    expect(revokedWhileShown).toEqual([]);
  });

  it("clears and releases every image when disabled, and reads them again when enabled", async () => {
    const guids = ["a", "b"];
    const { result, rerender } = renderThumbnails({ guids, versions: {}, enabled: true });
    await finish("a", "b");
    const before = result.current;
    load.mockClear();

    rerender({ guids, versions: {}, enabled: false });
    await act(async () => {});
    expect(result.current).toEqual({});
    expect(revokeObjectURL.mock.calls.flat().sort()).toEqual([before.a, before.b].sort());
    expect(revokedWhileShown).toEqual([]);

    rerender({ guids, versions: {}, enabled: true });
    await act(async () => {});
    expect(requested()).toEqual(["a", "b"]);
    await finish("a", "b");
    expect(Object.keys(result.current)).toEqual(["a", "b"]);
  });

  it("releases every image on unmount and creates none for a read that finishes afterwards", async () => {
    const { result, rerender, unmount } = renderThumbnails({ guids: ["a"], versions: {}, enabled: true });
    await finish("a");
    const before = result.current;
    rerender({ guids: ["a", "b"], versions: {}, enabled: true });
    await act(async () => {});
    expect(requested()).toEqual(["a", "b"]);

    unmount();
    await finish("b");
    expect(revokeObjectURL.mock.calls).toEqual([[before.a]]);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });
});
