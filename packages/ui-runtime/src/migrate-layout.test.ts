import { describe, expect, it } from "vitest";
import {
  isLegacyRectTransform,
  migrateLegacyLayout,
  migrateUserInterfacePayload,
} from "./migrate-layout";
import { pinLayout, stretchLayout } from "./types";
import { previewRect } from "./preview-rect";

describe("migrateLegacyLayout", () => {
  it("detects RectTransform payloads", () => {
    expect(
      isLegacyRectTransform({
        anchorMin: { x: 0.5, y: 0.5 },
        anchorMax: { x: 0.5, y: 0.5 },
        offsetMin: { x: -80, y: -80 },
        offsetMax: { x: 80, y: 80 },
        pivot: { x: 0.5, y: 0.5 },
      }),
    ).toBe(true);
    expect(isLegacyRectTransform(pinLayout("center", "center", 160, 160))).toBe(
      false,
    );
  });

  it("converts a centered pin into center alignment", () => {
    const next = migrateLegacyLayout({
      anchorMin: { x: 0.5, y: 0.5 },
      anchorMax: { x: 0.5, y: 0.5 },
      offsetMin: { x: -100, y: -50 },
      offsetMax: { x: 100, y: 50 },
      pivot: { x: 0.5, y: 0.5 },
    });
    expect(next.horizontalAlignment).toBe("center");
    expect(next.verticalAlignment).toBe("center");
    expect(next.width).toBe(200);
    expect(next.height).toBe(100);
    expect(next.widthUnit).toBe("px");
  });

  it("converts stretch anchors into percent size plus padding", () => {
    const next = migrateLegacyLayout({
      anchorMin: { x: 0, y: 0 },
      anchorMax: { x: 1, y: 1 },
      offsetMin: { x: 16, y: 12 },
      offsetMax: { x: -24, y: -8 },
      pivot: { x: 0.5, y: 0.5 },
    });
    expect(next.widthUnit).toBe("percent");
    expect(next.heightUnit).toBe("percent");
    const parent = { x: 0, y: 0, width: 1000, height: 1000 };
    const rect = previewRect(parent, next);
    expect(rect.x).toBeCloseTo(16, 5);
    expect(rect.width).toBeCloseTo(960, 5);
  });

  it("migrates widgets inside a UserInterface payload", () => {
    const payload = migrateUserInterfacePayload({
      name: "HUD",
      widgets: {
        canvas: {
          id: "canvas",
          layout: stretchLayout(),
        },
        stick: {
          id: "stick",
          layout: {
            anchorMin: { x: 0, y: 0 },
            anchorMax: { x: 0, y: 0 },
            offsetMin: { x: 0, y: 0 },
            offsetMax: { x: 160, y: 160 },
            pivot: { x: 0, y: 0 },
          },
        },
      },
    });
    const stick = (payload.widgets as Record<string, { layout: { horizontalAlignment: string } }>)
      .stick;
    expect(stick.layout.horizontalAlignment).toBe("left");
  });
});
