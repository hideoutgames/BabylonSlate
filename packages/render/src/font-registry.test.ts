import { describe, expect, it } from "vitest";
import {
  FontRegistry,
  type FontFaceHost,
  type FontFaceLike,
} from "./font-registry";

type MockFontHost = FontFaceHost & { faces: FontFaceLike[]; fail: boolean };

function mockHost(options: { fail?: boolean } = {}): MockFontHost {
  const faces: FontFaceLike[] = [];
  const host: MockFontHost = {
    faces,
    fail: options.fail === true,
    create(family) {
      return {
        family,
        load: async () => {
          if (host.fail) throw new Error("decode failed");
          return { family, load: async () => faces[0]! };
        },
      };
    },
    add(face) {
      faces.push(face);
    },
    delete(face) {
      const index = faces.indexOf(face);
      if (index >= 0) faces.splice(index, 1);
    },
    async load() {
      if (host.fail) throw new Error("decode failed");
      return faces;
    },
  };
  return host;
}

describe("FontRegistry", () => {
  it("awaits FontFace load before reporting ready", async () => {
    const registry = new FontRegistry(mockHost());
    const ok = await registry.register({
      guid: "font-1",
      family: "Display Face",
      bytes: new Uint8Array([1, 2, 3]).buffer,
    });
    expect(ok).toBe(true);
    expect(registry.isReady("font-1")).toBe(true);
    expect(registry.consumeDirty()).toBe(true);
    expect(registry.getWarnings()).toEqual([]);
  });

  it("records a warning instead of substituting Arial", async () => {
    const registry = new FontRegistry(mockHost({ fail: true }));
    const ok = await registry.register({
      guid: "font-1",
      family: "Missing",
      bytes: new Uint8Array([1]).buffer,
    });
    expect(ok).toBe(false);
    expect(registry.isReady("font-1")).toBe(false);
    expect(registry.getWarnings()[0]?.message).toMatch(/Missing/);
  });

  it("warns when the family is empty or no FontFace host exists", async () => {
    const empty = new FontRegistry(mockHost());
    expect(
      await empty.register({
        guid: "blank",
        family: "  ",
        bytes: new Uint8Array([1]).buffer,
      }),
    ).toBe(false);
    const noHost = new FontRegistry(null);
    expect(
      await noHost.register({
        guid: "x",
        family: "Display",
        bytes: new Uint8Array([1]).buffer,
      }),
    ).toBe(false);
    expect(noHost.getWarnings()[0]?.message).toMatch(/no FontFace host/);
  });

  it("registerAll awaits every face before reporting ready", async () => {
    const registry = new FontRegistry(mockHost());
    const ok = await registry.registerAll([
      {
        guid: "a",
        family: "Display",
        bytes: new Uint8Array([1]).buffer,
      },
      {
        guid: "b",
        family: "Fallback Face",
        bytes: new Uint8Array([2]).buffer,
      },
    ]);
    expect(ok).toBe(true);
    expect(registry.isReady("a")).toBe(true);
    expect(registry.isReady("b")).toBe(true);
  });

  it("adds one document face per font content, including concurrent and repeated registrations", async () => {
    const host = mockHost();
    const registry = new FontRegistry(host);
    const entry = (bytes: BufferSource) => ({ guid: "font-1", family: "Display", bytes });
    expect(
      await Promise.all([
        registry.register(entry(new Uint8Array([1, 2, 3]).buffer)),
        registry.register(entry(new Uint8Array([1, 2, 3]).buffer)),
      ]),
    ).toEqual([true, true]);
    expect(registry.consumeDirty()).toBe(true);
    expect(await registry.registerAll([entry(new Uint8Array([9, 1, 2, 3]).subarray(1))])).toBe(true);
    expect(host.faces).toHaveLength(1);
    expect(registry.consumeDirty()).toBe(false);
  });

  it("replaces a font's face only after changed content loads", async () => {
    const host = mockHost();
    const registry = new FontRegistry(host);
    await registry.register({ guid: "font-1", family: "Display", bytes: new Uint8Array([1]).buffer });
    const [original] = host.faces;
    host.fail = true;
    expect(await registry.register({ guid: "font-1", family: "Display", bytes: new Uint8Array([2]).buffer })).toBe(false);
    expect(host.faces).toEqual([original]);
    host.fail = false;
    expect(await registry.register({ guid: "font-1", family: "Display", bytes: new Uint8Array([3]).buffer })).toBe(true);
    expect(host.faces).toHaveLength(1);
    expect(host.faces[0]).not.toBe(original);
  });

  it("removes only its own faces on dispose, including a registration still loading", async () => {
    const host = mockHost();
    const sibling = new FontRegistry(host);
    const registry = new FontRegistry(host);
    const entry = { guid: "font-1", family: "Display", bytes: new Uint8Array([1]).buffer };
    await sibling.register(entry);
    await registry.register(entry);
    const loading = registry.register({ ...entry, guid: "font-2" });
    registry.dispose();
    await loading;
    expect(await registry.register({ ...entry, guid: "font-3" })).toBe(false);
    expect(host.faces).toHaveLength(1);
    sibling.dispose();
    expect(host.faces).toEqual([]);
  });
});
