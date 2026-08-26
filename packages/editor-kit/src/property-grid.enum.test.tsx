import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PropertyGrid } from "./property-grid";

afterEach(() => {
  cleanup();
});

describe("PropertyGrid enum rows", () => {
  it("shows the option label rather than the stored value", () => {
    render(
      <PropertyGrid
        rows={[
          {
            id: "domain",
            kind: "enum",
            label: "Domain",
            value: "postProcess",
            options: [
              { value: "surface", label: "Surface" },
              { value: "postProcess", label: "Post Process" },
            ],
            onChange: () => {},
          },
        ]}
      />,
    );
    expect(screen.getByTestId("property-domain").textContent).toContain(
      "Post Process",
    );
  });

  it("falls back to the raw value when no option matches", () => {
    render(
      <PropertyGrid
        rows={[
          {
            id: "kind",
            kind: "enum",
            label: "Kind",
            value: "legacy",
            options: [{ value: "box", label: "Box" }],
            onChange: () => {},
          },
        ]}
      />,
    );
    expect(screen.getByTestId("property-kind").textContent).toContain("Legacy");
  });

  it("does not open options when the enum row is disabled", () => {
    render(
      <PropertyGrid
        rows={[
          {
            id: "mode",
            kind: "enum",
            label: "Mode",
            value: "a",
            disabled: true,
            options: [
              { value: "a", label: "Alpha" },
              { value: "b", label: "Beta" },
            ],
            onChange: () => {},
          },
        ]}
      />,
    );
    const trigger = screen.getByTestId("property-mode") as HTMLButtonElement;
    expect(trigger.disabled).toBe(true);
    fireEvent.click(trigger);
    expect(document.querySelector("[data-slot='select-content']")).toBeNull();
  });

  it("greys out a disabled enum option", () => {
    render(
      <PropertyGrid
        rows={[
          {
            id: "renderer",
            kind: "enum",
            label: "Renderer",
            value: "bitmap",
            description: "Pick a Font that has an MSDF atlas (JSON + PNG).",
            options: [
              { value: "bitmap", label: "Bitmap" },
              { value: "msdf", label: "MSDF", disabled: true },
            ],
            onChange: () => {},
          },
        ]}
      />,
    );
    expect(screen.getByText(/Pick a Font that has an MSDF atlas/)).toBeTruthy();
    fireEvent.click(screen.getByTestId("property-renderer"));
    const msdf = screen.getByRole("option", { name: "MSDF" });
    expect(msdf.getAttribute("data-disabled")).toBe("");
  });
});
