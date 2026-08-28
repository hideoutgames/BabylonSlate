import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { PinShapeGlyph, pinShapeForContainer } from "./pin-shape-glyph";

describe("pinShapeForContainer", () => {
  it("maps Array to list bars, Map to the map glyph, and Single to a circle", () => {
    expect(pinShapeForContainer("array")).toBe("list");
    expect(pinShapeForContainer("map")).toBe("map");
    expect(pinShapeForContainer("single")).toBe("circle");
    expect(pinShapeForContainer(undefined)).toBe("circle");
  });
});

describe("PinShapeGlyph", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders list bars and a distinct two-column map glyph", () => {
    const { rerender, container } = render(
      <PinShapeGlyph shape="list" data-testid="glyph" />,
    );
    const list = container.querySelector('[data-testid="glyph"]');
    expect(list?.getAttribute("data-pin-shape")).toBe("list");
    expect(list?.querySelectorAll("rect").length).toBe(3);

    rerender(<PinShapeGlyph shape="map" data-testid="glyph" />);
    const map = container.querySelector('[data-testid="glyph"]');
    expect(map?.getAttribute("data-pin-shape")).toBe("map");
    expect(map?.querySelectorAll("rect").length).toBe(6);
  });
});
