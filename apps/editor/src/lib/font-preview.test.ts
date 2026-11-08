import { afterAll, describe, expect, it } from "vitest";
import { textDrawsSame } from "./font-preview";

/** What the fake canvas paints for a CSS font: the alpha of its first pixel. */
let paint: (font: string) => number = () => 0;

describe("textDrawsSame", () => {
  afterAll(() => Reflect.deleteProperty(globalThis, "document"));

  it("cannot compare without a 2D canvas", () => {
    expect(textDrawsSame("像", '"Ark Pixel", sans-serif', "sans-serif")).toBeNull();
  });

  it("tells a face that draws the character from one that leaves it to the generic", () => {
    (globalThis as { document?: unknown }).document = {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext() {
          let painted = 0;
          return {
            font: "",
            textBaseline: "alphabetic",
            fillStyle: "",
            clearRect() { painted = 0; },
            fillText() { painted = paint(this.font); },
            getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, painted, 0, 0, 0, 0]) }),
          };
        },
      }),
    };
    // The custom face paints its own glyph: the pixels differ from the generic's.
    paint = (font) => (font.includes("Ark Pixel") ? 255 : 128);
    expect(textDrawsSame("像", '"Ark Pixel", sans-serif', "sans-serif")).toBe(false);
    // The custom face lacks it: both stacks paint the generic's glyph.
    paint = () => 128;
    expect(textDrawsSame("한", '"Ark Pixel", sans-serif', "sans-serif")).toBe(true);
  });
});
