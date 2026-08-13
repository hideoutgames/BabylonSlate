import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  normalizeGoldenText,
  readGolden,
  writeGolden,
} from "@babylonslate/test-kit";
import { DEVICE_PRESETS } from "./presets";
import {
  clamp01,
  createDefaultUserInterface,
  createWidget,
  flattenLaidOut,
  layoutUserInterface,
  normalizeLayout,
  pinLayout,
  roundRect,
  stretchLayout,
} from "./index";

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));
const UPDATE = process.env.UPDATE_GOLDENS === "1";

function sampleHud() {
  const doc = createDefaultUserInterface("HUD");
  const header = createWidget(
    "header",
    "Text",
    "Title",
    stretchLayout({ left: 24, right: 24, top: 16, bottom: 0 }),
  );
  header.props.text = "Score";
  header.layout.anchorMin = { x: 0, y: 1 };
  header.layout.anchorMax = { x: 1, y: 1 };
  header.layout.offsetMin = { x: 24, y: -48 };
  header.layout.offsetMax = { x: -24, y: -8 };
  const stick = createWidget(
    "stick",
    "TouchJoystick",
    "Move Stick",
    pinLayout({ x: 0.12, y: 0.18 }, { x: 160, y: 160 }),
  );
  doc.widgets.canvas!.children = ["header", "stick"];
  doc.widgets.header = header;
  doc.widgets.stick = stick;
  return doc;
}

describe("layout goldens", () => {
  it("matches committed rects across device presets", () => {
    const doc = sampleHud();
    const samples = DEVICE_PRESETS.map((preset) => {
      const result = layoutUserInterface(
        doc,
        { width: preset.width, height: preset.height },
        { safeArea: preset.safeArea },
      );
      const widgets = Object.fromEntries(
        flattenLaidOut(result.tree).map((node) => [
          node.id,
          {
            rect: roundRect(node.rect),
            pivot: {
              x: Number(node.pivot.x.toFixed(3)),
              y: Number(node.pivot.y.toFixed(3)),
            },
          },
        ]),
      );
      return {
        preset: preset.id,
        viewport: { width: preset.width, height: preset.height },
        scale: Number(result.scale.toFixed(6)),
        canvas: roundRect(result.canvas),
        widgets,
      };
    });
    const serialized = `${JSON.stringify(samples, null, 2)}\n`;
    const relative = "__fixtures__/layout.golden.json";
    if (UPDATE) {
      writeGolden(FIXTURE_DIR, relative, serialized);
    }
    expect(normalizeGoldenText(serialized)).toBe(
      normalizeGoldenText(readGolden(FIXTURE_DIR, relative)),
    );
  });
});

describe("layout properties", () => {
  it("is deterministic", () => {
    const doc = sampleHud();
    const viewport = { width: 1194, height: 834 };
    const a = layoutUserInterface(doc, viewport, {
      safeArea: DEVICE_PRESETS[0]!.safeArea,
    });
    const b = layoutUserInterface(doc, viewport, {
      safeArea: DEVICE_PRESETS[0]!.safeArea,
    });
    expect(a).toEqual(b);
  });

  it("keeps normalised anchors in [0, 1]", () => {
    fc.assert(
      fc.property(
        fc.record({
          anchorMin: fc.record({ x: fc.double(), y: fc.double() }),
          anchorMax: fc.record({ x: fc.double(), y: fc.double() }),
          offsetMin: fc.record({ x: fc.double(), y: fc.double() }),
          offsetMax: fc.record({ x: fc.double(), y: fc.double() }),
          pivot: fc.record({ x: fc.double(), y: fc.double() }),
        }),
        (slot) => {
          const next = normalizeLayout(slot);
          expect(next.anchorMin.x).toBeGreaterThanOrEqual(0);
          expect(next.anchorMin.x).toBeLessThanOrEqual(1);
          expect(next.anchorMin.y).toBeGreaterThanOrEqual(0);
          expect(next.anchorMin.y).toBeLessThanOrEqual(1);
          expect(next.anchorMax.x).toBeGreaterThanOrEqual(next.anchorMin.x);
          expect(next.anchorMax.x).toBeLessThanOrEqual(1);
          expect(next.anchorMax.y).toBeGreaterThanOrEqual(next.anchorMin.y);
          expect(next.anchorMax.y).toBeLessThanOrEqual(1);
          expect(clamp01(next.pivot.x)).toBe(next.pivot.x);
          expect(clamp01(next.pivot.y)).toBe(next.pivot.y);
        },
      ),
    );
  });
});
