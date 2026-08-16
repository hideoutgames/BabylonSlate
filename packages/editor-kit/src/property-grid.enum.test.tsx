import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
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
});
