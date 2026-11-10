import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PinShapeGlyph } from "./pin-shape-glyph";

function barStrokes(element: Element): string[] {
  return [...element.querySelectorAll("rect")].map((bar) => bar.getAttribute("stroke") ?? "");
}

describe("PinShapeGlyph", () => {
  it.each(["list", "map"] as const)("keeps a filled %s pin's bars outlined in their own colour", (shape) => {
    const { container } = render(<PinShapeGlyph shape={shape} connected color="var(--pin-float)" />);
    const strokes = barStrokes(container.firstElementChild!);
    expect(strokes.length).toBeGreaterThan(0);
    expect(new Set(strokes)).toEqual(new Set(["currentColor"]));
  });

  it("draws filled list chrome without an outline when outlined is off", () => {
    const { container } = render(<PinShapeGlyph shape="list" connected outlined={false} color="var(--pin-float)" />);
    expect(new Set(barStrokes(container.firstElementChild!))).toEqual(new Set(["none"]));
  });
});
