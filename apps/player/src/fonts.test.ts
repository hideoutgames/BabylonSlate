import { describe, expect, it } from "vitest";
import { packedFontEntries, registerPackedFonts } from "./fonts";

describe("registerPackedFonts", () => {
  it("constructs FontFace from packed bytes, not a blob URL", async () => {
    const bytes = new Uint8Array([0, 1, 2, 3]);
    const sources: unknown[] = [];
    class FakeFontFace {
      constructor(_family: string, source: unknown) {
        sources.push(source);
      }
      async load() {
        return this;
      }
    }
    const added: unknown[] = [];
    await registerPackedFonts(new Map([["font-1", bytes]]), {
      FontFace: FakeFontFace as unknown as typeof FontFace,
      fonts: { add: (face: unknown) => added.push(face) } as unknown as FontFaceSet,
    });
    expect(sources).toHaveLength(1);
    expect(sources[0]).toBeInstanceOf(Uint8Array);
    expect(typeof sources[0]).not.toBe("string");
    expect(added).toHaveLength(1);
  });

  it("maps packed font bytes onto FontRegistry entries", () => {
    expect(
      packedFontEntries({
        fontBytes: new Map([["font-1", new Uint8Array([1, 2])]]),
        fontFamilies: new Map([["font-1", "Display Face"]]),
      }),
    ).toEqual([
      {
        guid: "font-1",
        family: "Display Face",
        bytes: new Uint8Array([1, 2]),
      },
    ]);
  });

  it("registers FontFace with the authored family name when provided", async () => {
    const families: string[] = [];
    class FakeFontFace {
      constructor(family: string) {
        families.push(family);
      }
      async load() {
        return this;
      }
    }
    await registerPackedFonts(
      new Map([["font-1", new Uint8Array([1])]]),
      {
        FontFace: FakeFontFace as unknown as typeof FontFace,
        fonts: { add: () => {} } as unknown as FontFaceSet,
      },
      new Map([["font-1", "Display"]]),
    );
    expect(families).toEqual(["Display"]);
  });
});
