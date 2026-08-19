import { describe, expect, it } from "vitest";
import { encodePngRgba } from "./png";

describe("encodePngRgba", () => {
  it("encodes a solid RGBA fixture as a PNG", () => {
    const rgba = Uint8Array.of(10, 20, 30, 255);
    const png = encodePngRgba(1, 1, rgba);
    expect([...png.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  });
});
