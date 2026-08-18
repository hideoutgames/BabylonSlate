import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DEVICE_PRESETS } from "./presets";
import {
  clamp01,
  createDefaultPlayHud,
  flattenLaidOut,
  insetRect,
  layoutUserInterface,
  normalizeLayout,
  pinLayout,
  previewRect,
  roundRect,
  stretchLayout,
  ZERO_INSETS,
} from "./index";

const parent = { x: 0, y: 0, width: 800, height: 600 };

describe("previewRect tables", () => {
  it("pins a pixel widget to the top-left", () => {
    expect(
      roundRect(previewRect(parent, pinLayout("left", "top", 160, 40, 24, 16))),
    ).toEqual({ x: 24, y: 16, width: 160, height: 40 });
  });

  it("sizes percent width against the parent", () => {
    const rect = previewRect(parent, {
      ...pinLayout("left", "top", 50, 40),
      widthUnit: "percent",
    });
    expect(rect.width).toBe(400);
    expect(rect.height).toBe(40);
  });

  it("stretches with layout padding", () => {
    expect(
      roundRect(
        previewRect(
          parent,
          stretchLayout({ left: 16, right: 24, top: 8, bottom: 12 }),
        ),
      ),
    ).toEqual({ x: 16, y: 8, width: 760, height: 580 });
  });

  it("treats safe-area insets as a padded parent", () => {
    const safe = insetRect(parent, { left: 0, right: 0, top: 24, bottom: 20 });
    expect(previewRect(safe, stretchLayout(ZERO_INSETS))).toEqual(safe);
  });
});

describe("layoutUserInterface", () => {
  it("does not letterbox the design canvas in the viewport", () => {
    const doc = createDefaultPlayHud("HUD");
    const result = layoutUserInterface(doc, { width: 1194, height: 834 });
    expect(result.canvas).toEqual({ x: 0, y: 0, width: 1194, height: 834 });
    expect(result.tree?.rect.x).toBe(0);
    expect(result.tree?.rect.y).toBe(0);
  });

  it("keeps design-space rects when designSpace is set", () => {
    const doc = createDefaultPlayHud("HUD");
    const result = layoutUserInterface(
      doc,
      { width: 1194, height: 834 },
      { designSpace: true },
    );
    expect(result.scale).toBe(1);
    expect(result.canvas).toEqual({
      x: 0,
      y: 0,
      width: 1194,
      height: 834,
    });
    expect(result.tree?.rect.width).toBe(1194);
  });

  it("is deterministic across device presets", () => {
    const doc = createDefaultPlayHud("HUD");
    for (const preset of DEVICE_PRESETS) {
      const viewport = { width: preset.width, height: preset.height };
      const a = layoutUserInterface(doc, viewport, { safeArea: preset.safeArea });
      const b = layoutUserInterface(doc, viewport, { safeArea: preset.safeArea });
      expect(flattenLaidOut(a.tree).map((node) => roundRect(node.rect))).toEqual(
        flattenLaidOut(b.tree).map((node) => roundRect(node.rect)),
      );
    }
  });

  it("keeps transformCenter in [0, 1]", () => {
    fc.assert(
      fc.property(
        fc.record({
          x: fc.double(),
          y: fc.double(),
        }),
        (pivot) => {
          const next = normalizeLayout({
            ...pinLayout("left", "top", 10, 10),
            transformCenter: pivot,
          });
          expect(next.transformCenter.x).toBe(clamp01(next.transformCenter.x));
          expect(next.transformCenter.y).toBe(clamp01(next.transformCenter.y));
        },
      ),
    );
  });
});
