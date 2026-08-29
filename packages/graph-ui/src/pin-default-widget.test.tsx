import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PinDefaultPreviewWidget } from "./pin-default-widget";

afterEach(() => {
  cleanup();
});

describe("PinDefaultPreviewWidget", () => {
  it("sizes string fields at text-base with a 12rem truncation cap", () => {
    const { container } = render(
      <PinDefaultPreviewWidget
        preview={{ kind: "string", text: "Hello World" }}
      />,
    );
    const field = container.querySelector("[data-pin-default='string']");
    expect(field).not.toBeNull();
    expect(field?.textContent).toBe("Hello World");
    expect(field?.className).toMatch(/\btext-base\b/);
    expect(field?.className).toMatch(/\bh-8\b/);
    expect(field?.className).toMatch(/--graph-pin-default-max-width,12rem/);
    expect(field?.className).toMatch(/\btruncate\b/);
  });

  it("lets type-name and numeric fields grow without a max-width cap", () => {
    const { container, rerender } = render(
      <PinDefaultPreviewWidget
        preview={{ kind: "classRef", text: "CameraComponent" }}
      />,
    );
    const typeName = container.querySelector("[data-pin-default='classRef']");
    expect(typeName?.className).toMatch(/whitespace-nowrap/);
    expect(typeName?.className).not.toMatch(/--graph-pin-default-max-width/);
    expect(typeName?.className).not.toMatch(/\btruncate\b/);

    rerender(
      <PinDefaultPreviewWidget preview={{ kind: "vec3", text: "1, 2, 3" }} />,
    );
    const numeric = container.querySelector("[data-pin-default='vec3']");
    expect(numeric?.className).toMatch(/whitespace-nowrap/);
    expect(numeric?.className).not.toMatch(/--graph-pin-default-max-width/);
  });

  it("sizes bool and color swatches at size-5", () => {
    const { container, rerender } = render(
      <PinDefaultPreviewWidget preview={{ kind: "bool", checked: true }} />,
    );
    const bool = container.querySelector("[data-pin-default='bool']");
    expect(bool?.className).toMatch(/\bsize-5\b/);
    expect(bool?.querySelector("svg")?.getAttribute("class")).toMatch(
      /\bsize-3\.5\b/,
    );

    rerender(
      <PinDefaultPreviewWidget
        preview={{ kind: "color", rgb: "rgb(255, 0, 0)" }}
      />,
    );
    const color = container.querySelector("[data-pin-default='color']");
    expect(color?.className).toMatch(/\bsize-5\b/);
  });
});
