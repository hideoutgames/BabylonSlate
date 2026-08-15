import { describe, expect, it } from "vitest";
import { registerPackedFonts } from "./fonts";

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
});
