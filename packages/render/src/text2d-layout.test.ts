import { describe, expect, it } from "vitest";
import {
  combineText2DEffects,
  layoutText2D,
  type GlyphMetricsProvider,
  type Text2DLayoutItem,
} from "./text2d-layout";

function provider(
  overrides: Partial<Record<string, { width: number; height: number; advance: number; source?: "bitmap" | "msdf" }>> = {},
): GlyphMetricsProvider {
  return {
    measureGlyph(ch, style) {
      const world = style.size / 100;
      const preset = overrides[ch];
      return {
        width: preset?.width ?? world * 0.5,
        height: preset?.height ?? world,
        bearingX: 0,
        bearingY: 0,
        advance: preset?.advance ?? world * 0.5,
        source: preset?.source ?? "bitmap",
      };
    },
    measureImage(_guid, sizePx) {
      const height = sizePx / 100;
      return { width: height, height };
    },
  };
}

function glyphs(items: Text2DLayoutItem[]) {
  return items.filter((item) => item.kind === "glyph");
}

describe("layoutText2D", () => {
  it("places glyphs on a line and centers the AABB on the actor origin", () => {
    const layout = layoutText2D({
      text: "Hi",
      rich: false,
      size: 32,
      color: [1, 1, 1],
      alignment: "left",
      wrapWidth: 0,
      bold: false,
      italic: false,
      underline: false,
      outline: 0,
      outlineColor: [0, 0, 0],
      pixelsPerUnit: 100,
      metrics: provider(),
    });
    expect(glyphs(layout.items)).toHaveLength(2);
    expect(layout.width).toBeCloseTo(0.32);
    expect(layout.height).toBeCloseTo(0.32);
    expect(layout.items[0]?.x).toBeCloseTo(0.08);
    expect(layout.items[1]?.x).toBeCloseTo(0.24);
    expect(layout.items[0]?.y).toBeCloseTo(0);
  });

  it("shifts each line for center and right alignment", () => {
    const center = layoutText2D({
      text: "Hi",
      rich: false,
      size: 32,
      color: [1, 1, 1],
      alignment: "center",
      wrapWidth: 0,
      bold: false,
      italic: false,
      underline: false,
      outline: 0,
      outlineColor: [0, 0, 0],
      pixelsPerUnit: 100,
      metrics: provider(),
    });
    expect(center.items[0]?.x).toBeCloseTo(-0.08);
    expect(center.items[1]?.x).toBeCloseTo(0.08);

    const right = layoutText2D({
      text: "Hi",
      rich: false,
      size: 32,
      color: [1, 1, 1],
      alignment: "right",
      wrapWidth: 0,
      bold: false,
      italic: false,
      underline: false,
      outline: 0,
      outlineColor: [0, 0, 0],
      pixelsPerUnit: 100,
      metrics: provider(),
    });
    expect(right.items[0]?.x).toBeCloseTo(-0.24);
    expect(right.items[1]?.x).toBeCloseTo(-0.08);
  });

  it("wraps on wrapWidth and newlines", () => {
    const wrapped = layoutText2D({
      text: "AAAA",
      rich: false,
      size: 32,
      color: [1, 1, 1],
      alignment: "left",
      wrapWidth: 32,
      bold: false,
      italic: false,
      underline: false,
      outline: 0,
      outlineColor: [0, 0, 0],
      pixelsPerUnit: 100,
      metrics: provider(),
    });
    const rows = new Set(glyphs(wrapped.items).map((item) => item.y.toFixed(3)));
    expect(rows.size).toBe(2);

    const broken = layoutText2D({
      text: "A\nB",
      rich: false,
      size: 32,
      color: [1, 1, 1],
      alignment: "left",
      wrapWidth: 0,
      bold: false,
      italic: false,
      underline: false,
      outline: 0,
      outlineColor: [0, 0, 0],
      pixelsPerUnit: 100,
      metrics: provider(),
    });
    expect(glyphs(broken.items)[0]?.ch).toBe("A");
    expect(glyphs(broken.items)[1]?.ch).toBe("B");
    expect(glyphs(broken.items)[1]?.y).toBeLessThan(glyphs(broken.items)[0]!.y);
  });

  it("layouts rich-text images and keeps missing MSDF glyphs on the bitmap path", () => {
    const layout = layoutText2D({
      text: "A[img=tex-1 size=14]B",
      rich: true,
      size: 32,
      color: [1, 1, 1],
      alignment: "left",
      wrapWidth: 0,
      bold: false,
      italic: false,
      underline: false,
      outline: 0,
      outlineColor: [0, 0, 0],
      pixelsPerUnit: 100,
      metrics: provider({
        A: { width: 0.16, height: 0.32, advance: 0.16, source: "msdf" },
        B: { width: 0.16, height: 0.32, advance: 0.16, source: "bitmap" },
      }),
    });
    expect(layout.items.map((item) => item.kind)).toEqual(["glyph", "image", "glyph"]);
    expect(layout.items[0]?.source).toBe("msdf");
    expect(layout.items[1]?.kind).toBe("image");
    expect(layout.items[2]?.source).toBe("bitmap");
  });

  it("staggers hover and rotate phases per glyph", () => {
    const layout = layoutText2D({
      text: "[hover][rotate=45]AB",
      rich: true,
      size: 32,
      color: [1, 1, 1],
      alignment: "left",
      wrapWidth: 0,
      bold: false,
      italic: false,
      underline: false,
      outline: 0,
      outlineColor: [0, 0, 0],
      pixelsPerUnit: 100,
      metrics: provider(),
    });
    const [a, b] = glyphs(layout.items);
    expect(a?.hoverPhase).not.toBe(b?.hoverPhase);
    expect(a?.rotatePhase).not.toBe(b?.rotatePhase);
    expect(a?.effects.rotate).toBe(45);
    expect(a?.effects.hover).toBe(1);
  });

  it("underlines with a shared line Y and ignores letter effects", () => {
    const layout = layoutText2D({
      text: "[u][wave=2]Ag",
      rich: true,
      size: 32,
      color: [1, 1, 1],
      alignment: "left",
      wrapWidth: 0,
      bold: false,
      italic: false,
      underline: false,
      outline: 0,
      outlineColor: [0, 0, 0],
      pixelsPerUnit: 100,
      metrics: provider({
        A: { width: 0.16, height: 0.32, advance: 0.16 },
        g: { width: 0.16, height: 0.2, advance: 0.16 },
      }),
    });
    const underlines = layout.items.filter((item) => item.kind === "underline");
    expect(underlines).toHaveLength(1);
    expect(underlines[0]?.y).toBeCloseTo(-layout.height / 2, 1);
    expect(underlines[0]?.effects).toEqual({
      shake: 0,
      waveSpeed: 0,
      waveIntensity: 0,
      hover: 0,
      rotate: 0,
    });
    expect(glyphs(layout.items)[0]?.effects.waveSpeed).toBe(2);
  });
});

describe("combineText2DEffects", () => {
  it("adds stacked shake, wave, hover, and rotate", () => {
    const first = combineText2DEffects(
      { shake: 1, waveSpeed: 2, waveIntensity: 1, hover: 1, rotate: 45 },
      {
        time: 0,
        index: 0,
        fontSize: 0.32,
        hoverPhase: 0,
        rotatePhase: 0,
        noise: () => 1,
      },
    );
    expect(first.x).not.toBe(0);
    expect(first.y).not.toBe(0);
    expect(first.rotation).toBe(0);

    const later = combineText2DEffects(
      { shake: 0, waveSpeed: 2, waveIntensity: 1, hover: 0, rotate: 45 },
      {
        time: Math.PI / 4,
        index: 0,
        fontSize: 0.32,
        hoverPhase: 0,
        rotatePhase: 0,
        noise: () => 0,
      },
    );
    expect(later.rotation).toBeGreaterThan(0);
  });

  it("returns a frozen rest pose when paused after a previous sample", () => {
    const live = combineText2DEffects(
      { shake: 0, waveSpeed: 2, waveIntensity: 1, hover: 0, rotate: 0 },
      {
        time: 1,
        index: 0,
        fontSize: 0.32,
        hoverPhase: 0,
        rotatePhase: 0,
        noise: () => 0,
      },
    );
    const frozen = combineText2DEffects(
      { shake: 0, waveSpeed: 2, waveIntensity: 1, hover: 0, rotate: 0 },
      {
        time: 4,
        index: 0,
        fontSize: 0.32,
        hoverPhase: 0,
        rotatePhase: 0,
        noise: () => 0,
        paused: true,
        last: live,
      },
    );
    expect(frozen).toEqual(live);
  });
});
