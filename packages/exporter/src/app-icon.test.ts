import { describe, expect, it } from "vitest";
import { appIconPng, brandPlayerIndexHtml, encodeIcns, encodeIco } from "./app-icon";
import { appIconImages, pngHeader } from "./test-support/app-icon-images";

const images = appIconImages();

describe("App Icon files", () => {
  it("write a Windows ICO whose directory points at each size's PNG, 256 written as 0", () => {
    const ico = encodeIco(images);
    const view = new DataView(ico.buffer, ico.byteOffset, ico.byteLength);
    expect([view.getUint16(0, true), view.getUint16(2, true), view.getUint16(4, true)]).toEqual([0, 1, 7]);
    const entries = [...Array(7).keys()].map((index) => {
      const entry = 6 + 16 * index;
      const length = view.getUint32(entry + 8, true);
      const offset = view.getUint32(entry + 12, true);
      return { width: ico[entry], height: ico[entry + 1], bitCount: view.getUint16(entry + 6, true), data: ico.subarray(offset, offset + length) };
    });
    expect(entries.map((entry) => [entry.width, entry.height, entry.bitCount])).toEqual(
      [[16, 16, 32], [24, 24, 32], [32, 32, 32], [48, 48, 32], [64, 64, 32], [128, 128, 32], [0, 0, 32]]);
    expect(entries.map((entry) => entry.data)).toEqual([16, 24, 32, 48, 64, 128, 256].map((size) => images.get(size)));
  });

  it("write a macOS ICNS of PNG elements at 1x and 2x with every length counted", () => {
    const icns = encodeIcns(images);
    const view = new DataView(icns.buffer, icns.byteOffset, icns.byteLength);
    const ascii = (offset: number) => String.fromCharCode(...icns.subarray(offset, offset + 4));
    expect(ascii(0)).toBe("icns");
    expect(view.getUint32(4)).toBe(icns.byteLength);
    const elements: [string, Uint8Array][] = [];
    for (let offset = 8; offset < icns.byteLength; offset += view.getUint32(offset + 4)) {
      elements.push([ascii(offset), icns.subarray(offset + 8, offset + view.getUint32(offset + 4))]);
    }
    expect(elements).toEqual([
      ["icp4", images.get(16)], ["ic11", images.get(32)], ["icp5", images.get(32)], ["ic12", images.get(64)], ["ic07", images.get(128)],
      ["ic13", images.get(256)], ["ic08", images.get(256)], ["ic14", images.get(512)], ["ic09", images.get(512)], ["ic10", images.get(1024)],
    ]);
  });

  it("refuse a missing size or an image that is not a PNG of its size", () => {
    expect(() => encodeIcns(new Map([...images].filter(([size]) => size !== 1024)))).toThrow("The App Icon has no 1024 × 1024 image.");
    expect(() => appIconPng(new Map([[48, pngHeader(64)]]), 48)).toThrow("The App Icon's 48 × 48 image is not a PNG of that size.");
    expect(() => appIconPng(new Map([[48, pngHeader(48, 47)]]), 48)).toThrow("not a PNG of that size");
    expect(() => appIconPng(new Map([[48, new Uint8Array(40)]]), 48)).toThrow("not a PNG of that size");
  });
});

describe("Player page branding", () => {
  const page = "<!doctype html><html><head>\n  <title>Game</title>\n</head><body></body></html>";

  it("title the page with the game's name, escaped, and link the icon only when there is one", () => {
    expect(brandPlayerIndexHtml(page, { title: " Rock & <Roll> ", icon: false }))
      .toBe("<!doctype html><html><head>\n  <title>Rock &amp; &lt;Roll&gt;</title>\n</head><body></body></html>");
    expect(brandPlayerIndexHtml(page, { title: "Orbit", icon: true }))
      .toBe("<!doctype html><html><head>\n  <title>Orbit</title>\n  <link rel=\"icon\" type=\"image/png\" href=\"./icon.png\" />\n</head><body></body></html>");
  });

  it("keep Game for a blank name and leave a page without a title or head as it is", () => {
    expect(brandPlayerIndexHtml(page, { title: "  ", icon: false })).toBe(page);
    expect(brandPlayerIndexHtml("<canvas></canvas>", { title: "$& Orbit", icon: true })).toBe("<canvas></canvas>");
    expect(brandPlayerIndexHtml("<title>Old</title>", { title: "$& Orbit", icon: false })).toBe("<title>$&amp; Orbit</title>");
  });
});
