import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PropertyGrid, humanizePropertyLabel, type PropertyRow } from "./property-grid";
import { dispatchPointerEvent } from "./test-support/pointer-events";

describe("PropertyGrid", () => {
  afterEach(() => {
    cleanup();
  });

  it("edits a vector3 row per axis", () => {
    const onChange = vi.fn();
    const rows: PropertyRow[] = [
      {
        kind: "vector3",
        id: "position",
        label: "Position",
        value: [1, 2, 3],
        onChange,
      },
    ];
    render(<PropertyGrid rows={rows} />);

    fireEvent.change(screen.getByTestId("property-position-y"), {
      target: { value: "9" },
    });
    expect(onChange).toHaveBeenCalledWith([1, 9, 3]);
  });

  it("hides the Z axis when only two axes are supplied", () => {
    const rows: PropertyRow[] = [
      {
        kind: "vector3",
        id: "position",
        label: "Position",
        value: [1, 2, 3],
        axes: ["X", "Y"],
        onChange: () => {},
      },
    ];
    render(<PropertyGrid rows={rows} />);
    expect(screen.queryByTestId("property-position-z")).toBeNull();
  });

  it("enables reset only when a row differs from its default", () => {
    const onChange = vi.fn();
    const rows: PropertyRow[] = [
      {
        kind: "number",
        id: "speed",
        label: "Speed",
        value: 5,
        defaultValue: 1,
        onChange,
      },
      {
        kind: "number",
        id: "mass",
        label: "Mass",
        value: 1,
        defaultValue: 1,
        onChange: () => {},
      },
    ];
    render(<PropertyGrid rows={rows} />);

    expect(
      (screen.getByTestId("property-mass-reset") as HTMLButtonElement).disabled,
    ).toBe(true);
    screen.getByTestId("property-speed-reset").click();
    expect(onChange).toHaveBeenCalledWith(1);
  });

  it("omits reset for rows without a default", () => {
    render(
      <PropertyGrid
        rows={[
          { kind: "text", id: "name", label: "Name", value: "A", onChange: () => {} },
        ]}
      />,
    );
    expect(screen.queryByTestId("property-name-reset")).toBeNull();
  });

  it("commits a number scrub once on drag end", () => {
    const onCommit = vi.fn();
    render(
      <PropertyGrid
        rows={[
          {
            kind: "number",
            id: "speed",
            label: "Speed",
            value: 0,
            sensitivity: 1,
            onChange: () => {},
            onCommit,
          },
        ]}
      />,
    );
    const scrub = screen.getByTestId("property-speed-scrub");
    dispatchPointerEvent(scrub, "pointerdown", { clientX: 0 });
    dispatchPointerEvent(scrub, "pointermove", { clientX: 4 });
    dispatchPointerEvent(scrub, "pointerup", { clientX: 4 });
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("renders boolean, text, color and asset rows", () => {
    const onPick = vi.fn();
    render(
      <PropertyGrid
        rows={[
          { kind: "boolean", id: "visible", label: "Visible", value: true, onChange: () => {} },
          { kind: "text", id: "name", label: "Name", value: "Cube", onChange: () => {} },
          { kind: "color", id: "tint", label: "Tint", value: [1, 0, 0], onChange: () => {} },
          {
            kind: "asset",
            id: "mesh",
            label: "Mesh",
            value: null,
            placeholder: "None",
            onPick,
            onChange: () => {},
          },
        ]}
      />,
    );

    expect(screen.getByTestId("property-visible")).toBeTruthy();
    expect((screen.getByTestId("property-name") as HTMLInputElement).value).toBe(
      "Cube",
    );
    expect((screen.getByTestId("property-tint") as HTMLInputElement).value).toBe(
      "#ff0000",
    );
    screen.getByTestId("property-mesh").click();
    expect(onPick).toHaveBeenCalled();
  });

  it("humanizes camelCase property keys", () => {
    expect(humanizePropertyLabel("meshKind")).toBe("Mesh kind");
    expect(humanizePropertyLabel("fixedTimestepMs")).toBe("Fixed timestep ms");
    expect(humanizePropertyLabel("Name")).toBe("Name");
  });

  it("uses a compact icon reset instead of the word Reset", () => {
    render(
      <PropertyGrid
        rows={[
          {
            kind: "number",
            id: "speed",
            label: "Speed",
            value: 5,
            defaultValue: 1,
            onChange: () => {},
          },
        ]}
      />,
    );
    const reset = screen.getByTestId("property-speed-reset");
    expect(reset.textContent).not.toMatch(/Reset/i);
    expect(reset.getAttribute("aria-label")).toBe("Reset Speed");
  });

  it("stacks the title above its control", () => {
    render(
      <PropertyGrid
        rows={[
          { kind: "text", id: "name", label: "Name", value: "Cube", onChange: () => {} },
        ]}
      />,
    );
    const row = screen.getByTestId("property-row-name");
    expect(row.getAttribute("data-orientation")).toBe("vertical");
    expect(row.className).toContain("flex-col");
    expect(row.textContent).toContain("Name");
    const title = row.querySelector('[data-slot="field-label"]');
    const control = screen.getByTestId("property-name");
    expect(title).not.toBeNull();
    expect(
      Boolean(
        title!.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    ).toBe(true);
  });

  it("keeps reset on the title line", () => {
    render(
      <PropertyGrid
        rows={[
          {
            kind: "number",
            id: "speed",
            label: "Speed",
            value: 5,
            defaultValue: 1,
            onChange: () => {},
          },
        ]}
      />,
    );
    const title = screen
      .getByTestId("property-row-speed")
      .querySelector('[data-slot="field-label"]');
    const reset = screen.getByTestId("property-speed-reset");
    expect(title?.parentElement).toContain(reset);
  });

  it("does not repeat the property title in the number scrub handle", () => {
    render(
      <PropertyGrid
        rows={[
          {
            kind: "number",
            id: "speed",
            label: "Speed",
            value: 5,
            onChange: () => {},
          },
        ]}
      />,
    );
    expect(screen.getByTestId("property-row-speed").textContent).toContain("Speed");
    expect(screen.getByTestId("property-speed-scrub").textContent).not.toMatch(
      /Speed/i,
    );
  });

  it("keeps vector axes on one nowrap row", () => {
    render(
      <PropertyGrid
        rows={[
          {
            kind: "vector3",
            id: "position",
            label: "Position",
            value: [1, 2, 3],
            onChange: () => {},
          },
        ]}
      />,
    );
    const x = screen.getByTestId("property-position-x");
    const group = x.closest("[data-testid='property-vector3-position']");
    expect(group).not.toBeNull();
    expect(group!.className).toContain("flex-nowrap");
    expect(group!.className).not.toContain("flex-wrap");
  });

  it("colors vector axis scrub labels", () => {
    render(
      <PropertyGrid
        rows={[
          {
            kind: "vector3",
            id: "position",
            label: "Position",
            value: [1, 2, 3],
            onChange: () => {},
          },
        ]}
      />,
    );
    expect(screen.getByTestId("property-position-x-scrub").className).toContain(
      "text-axis-x",
    );
    expect(screen.getByTestId("property-position-y-scrub").className).toContain(
      "text-axis-y",
    );
    expect(screen.getByTestId("property-position-z-scrub").className).toContain(
      "text-axis-z",
    );
  });
});
