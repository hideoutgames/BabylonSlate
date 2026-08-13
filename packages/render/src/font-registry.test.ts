import { describe, expect, it } from "vitest";
import {
  FontRegistry,
  type FontFaceHost,
  type FontFaceLike,
} from "./font-registry";

function mockHost(options: { fail?: boolean } = {}): FontFaceHost {
  const faces: FontFaceLike[] = [];
  return {
    create(family) {
      return {
        family,
        load: async () => {
          if (options.fail) throw new Error("decode failed");
          return { family, load: async () => faces[0]! };
        },
      };
    },
    add(face) {
      faces.push(face);
    },
    async load() {
      if (options.fail) throw new Error("decode failed");
      return faces;
    },
  };
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
});
