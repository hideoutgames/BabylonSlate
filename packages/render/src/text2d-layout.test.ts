import { describe, expect, it } from "vitest";
import {
  combineText2DEffects,
  layoutText2D,
  layoutText2DFromProperties,
  type GlyphMetrics,
  type GlyphMetricsProvider,
  type Text2DLayoutItem,
} from "./text2d-layout";

function provider(
  overrides: Partial<Record<string, Partial<GlyphMetrics>>> = {},
): GlyphMetricsProvider {
  return {
    measureGlyph(ch, style) {
      const world = style.size / 100;
      const preset = overrides[ch];
      return {
        width: preset?.width ?? world * 0.5,
        height: preset?.height ?? world,
        bearingX: 0,
        bearingY: preset?.bearingY ?? 0,
        advance: preset?.advance ?? world * 0.5,
        source: preset?.source ?? "bitmap",
        inkBounds: preset?.inkBounds,
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

  it("aligns left and right to wrap-box borders when wrapWidth is set", () => {
    const left = layoutText2D({
      text: "Hi",
      rich: false,
      size: 32,
      color: [1, 1, 1],
      alignment: "left",
      wrapWidth: 200,
      wrapHeight: 64,
      verticalAlignment: "center",
      bold: false,
      italic: false,
      underline: false,
      outline: 0,
      outlineColor: [0, 0, 0],
      pixelsPerUnit: 100,
      metrics: provider(),
    });
    expect(left.items[0]?.x).toBeCloseTo(-0.92);
    expect(left.items[1]?.x).toBeCloseTo(-0.76);

    const right = layoutText2D({
      text: "Hi",
      rich: false,
      size: 32,
      color: [1, 1, 1],
      alignment: "right",
      wrapWidth: 200,
      wrapHeight: 64,
      verticalAlignment: "center",
      bold: false,
      italic: false,
      underline: false,
      outline: 0,
      outlineColor: [0, 0, 0],
      pixelsPerUnit: 100,
      metrics: provider(),
    });
    expect(right.items[0]?.x).toBeCloseTo(0.76);
    expect(right.items[1]?.x).toBeCloseTo(0.92);
  });

  it("pins the first or last line to wrap-box top or bottom", () => {
    const top = layoutText2D({
      text: "Hi",
      rich: false,
      size: 32,
      color: [1, 1, 1],
      alignment: "center",
      wrapWidth: 200,
      wrapHeight: 64,
      verticalAlignment: "top",
      bold: false,
      italic: false,
      underline: false,
      outline: 0,
      outlineColor: [0, 0, 0],
      pixelsPerUnit: 100,
      metrics: provider(),
    });
    expect(top.items[0]?.y).toBeCloseTo(0.16);

    const bottom = layoutText2D({
      text: "Hi",
      rich: false,
      size: 32,
      color: [1, 1, 1],
      alignment: "center",
      wrapWidth: 200,
      wrapHeight: 64,
      verticalAlignment: "bottom",
      bold: false,
      italic: false,
      underline: false,
      outline: 0,
      outlineColor: [0, 0, 0],
      pixelsPerUnit: 100,
      metrics: provider(),
    });
    expect(bottom.items[0]?.y).toBeCloseTo(-0.16);
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

  it("lets extra lines overflow wrapHeight; wrapWidth still drives breaks", () => {
    const tall = layoutText2DFromProperties(
      {
        text: "AAAA",
        wrapWidth: 32,
        wrapHeight: 8,
        size: 32,
      },
      { rich: false, pixelsPerUnit: 100, metrics: provider() },
    );
    const rows = new Set(glyphs(tall.layout.items).map((item) => item.y.toFixed(3)));
    expect(rows.size).toBe(2);
    expect(tall.layout.height).toBeGreaterThan(8 / 100);
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
        A: { width: 0.16, height: 0.32, advance: 0.16, bearingY: -0.04, source: "msdf" },
        B: { width: 0.16, height: 0.32, advance: 0.16, bearingY: -0.04, source: "bitmap" },
      }),
    });
    expect(layout.items.map((item) => item.kind)).toEqual(["glyph", "image", "glyph"]);
    expect(layout.items[0]?.source).toBe("msdf");
    expect(layout.items[1]?.kind).toBe("image");
    expect(layout.items[1]?.y).toBeCloseTo(-0.04);
    expect(layout.items[2]?.source).toBe("bitmap");
  });

  it.each(["", "\n"])("centers images on each line's visible text across breaks (%j)", (separator) => {
    const { layout } = layoutText2DFromProperties(
      { text: `A [img=first size=14]${separator}B[img=second size=14]`, size: 32, wrapWidth: 48, wrapHeight: 0 },
      {
        rich: true,
        pixelsPerUnit: 100,
        metrics: provider({
          A: { height: 0.4, bearingY: 0.04, inkBounds: { top: 0.14, bottom: -0.02 } },
          B: { height: 0.2, bearingY: -0.05 },
        }),
      },
    );
    const images = layout.items.filter((item) => item.kind === "image");
    // The first row is centered at 0.1; its visible text spans 0.12 to 0.28.
    expect(images[0]?.y).toBeCloseTo(0.2);
    // The second row is centered at -0.2 with a -0.05 glyph bearing.
    expect(images[1]?.y).toBeCloseTo(-0.25);
    expect(glyphs(layout.items).find((item) => item.ch === "A")?.y).toBeCloseTo(0.14);
  });

  it("keeps different-sized images centered when a line contains only images and spaces", () => {
    const { layout } = layoutText2DFromProperties(
      { text: "[img=small size=14] [img=large size=48]", wrapWidth: 0, wrapHeight: 0 },
      { rich: true, pixelsPerUnit: 100, metrics: provider() },
    );
    const images = layout.items.filter((item) => item.kind === "image");
    expect(images.map((item) => item.y)).toEqual([0, 0]);
    expect(images.map((item) => item.height)).toEqual([0.14, 0.48]);
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

  it("keeps reveal underline segments continuous across character spacing", () => {
    const { layout } = layoutText2DFromProperties(
      { text: "[u]ABC", appearModes: ["fade"], wrapWidth: 0, wrapHeight: 0 },
      { rich: true, pixelsPerUnit: 100, metrics: provider({
        A: { width: 0.08, advance: 0.12 },
        B: { width: 0.08, advance: 0.12 },
        C: { width: 0.08, advance: 0.12 },
      }) },
    );
    const lines = layout.items.filter((item) => item.kind === "underline");
    expect(lines.map((line) => line.index)).toEqual([0, 1, 2]);
    for (const [index, width] of [0.12, 0.12, 0.08].entries()) expect(lines[index]!.width).toBeCloseTo(width);
    for (const [index, x] of [0.06, 0.18, 0.28].entries()) expect(lines[index]!.x).toBeCloseTo(x);
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
      },
    );
    expect(later.rotation).toBeGreaterThan(0);
  });

  it("writes the same sample into a reused output", () => {
    const effects = { shake: 1, waveSpeed: 2, waveIntensity: 1, hover: 1, rotate: 45 };
    const context = { time: 0.7, index: 3, fontSize: 0.32, hoverPhase: 0.2, rotatePhase: 0.4 };
    const out = { x: 9, y: 9, rotation: 9 };
    expect(combineText2DEffects(effects, context, out)).toBe(out);
    expect(out).toEqual(combineText2DEffects(effects, context));
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
        paused: true,
        last: live,
      },
    );
    expect(frozen).toEqual(live);
  });

  it("keeps shake gentle and continuous between frames without synchronizing letters", () => {
    const effects = { shake: 1, waveSpeed: 0, waveIntensity: 0, hover: 0, rotate: 0 };
    const context = { time: 0, index: 0, fontSize: 0.32, hoverPhase: 0, rotatePhase: 0 };
    const first = combineText2DEffects(effects, context);
    let previous = first;
    let travel = 0;
    for (let frame = 1; frame <= 180; frame++) {
      const sample = combineText2DEffects(effects, { ...context, time: frame / 60 });
      // At 32 px / 100 ppu, a normal shake stays within 1.5 px of rest
      // and moves less than half a pixel between 60 Hz frames.
      expect(Math.hypot(sample.x, sample.y)).toBeLessThan(0.015);
      const movement = Math.hypot(sample.x - previous.x, sample.y - previous.y);
      expect(movement).toBeLessThan(0.005);
      travel += movement;
      previous = sample;
    }
    expect(travel).toBeGreaterThan(0.05);
    expect(combineText2DEffects(effects, context)).toEqual(first);
    expect(combineText2DEffects(effects, { ...context, index: 1 })).not.toEqual(first);
    const stronger = combineText2DEffects({ ...effects, shake: 2 }, context);
    expect(stronger.x).toBeCloseTo(first.x * 2);
    expect(stronger.y).toBeCloseTo(first.y * 2);
  });
});
