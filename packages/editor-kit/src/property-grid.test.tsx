import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { PropertyGrid, type PropertyRow } from "./property-grid";
import { EditorReadOnlyContext } from "./editor-read-only";
import { AssetOpenProvider } from "./asset-picker-control";
import {
  formatEventMemberName,
  formatEventTitle,
  humanizePropertyLabel,
} from "./humanize-property-label";
import { dispatchPointerEvent } from "./test-support/pointer-events";

describe("PropertyGrid", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows readable Boolean states and toggles from the value label", () => {
    const onChange = vi.fn();
    const row: PropertyRow = {
      kind: "boolean",
      id: "enabled",
      label: "Enabled",
      value: false,
      onChange,
    };
    const { rerender } = render(<PropertyGrid rows={[row]} />);
    expect(screen.getByRole("checkbox", { name: "Enabled" })).toBeTruthy();
    fireEvent.click(screen.getByText("Off"));
    expect(onChange).toHaveBeenCalledWith(true);
    rerender(<PropertyGrid rows={[{ ...row, value: true }]} />);
    expect(screen.getByText("On")).toBeTruthy();
    rerender(<PropertyGrid rows={[{ ...row, mixed: true, disabled: true }]} />);
    expect(screen.getByText("Mixed")).toBeTruthy();
    onChange.mockClear();
    fireEvent.click(screen.getByText("Mixed"));
    expect(onChange).not.toHaveBeenCalled();
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

    fireEvent.change(screen.getByRole("textbox", { name: "Position Y" }), {
      target: { value: "9" },
    });
    expect(onChange).toHaveBeenCalledWith([1, 9, 3]);
  });

  it("names compound color and slider controls with their property context", async () => {
    // Base UI's inset thumb needs a measured track before it becomes accessible.
    const bounds = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue(new DOMRect(0, 0, 100, 20));
    try {
      render(
        <PropertyGrid
          rows={[
            {
              kind: "color",
              id: "light-color",
              label: "Light Color",
              value: [1, 0, 0],
              onChange: () => {},
            },
            {
              kind: "slider",
              id: "intensity",
              label: "Intensity",
              value: 0.5,
              min: 0,
              max: 1,
              onChange: () => {},
            },
          ]}
        />,
      );
      expect(
        screen.getByRole("textbox", { name: "Light Color Hex" }),
      ).toBeTruthy();
      expect(await screen.findByRole("slider", { name: "Intensity" })).toBeTruthy();
    } finally {
      bounds.mockRestore();
    }
  });

  it("reports the edited axis separately for a shared vector and resets the entire row", () => {
    const onChange = vi.fn();
    const onAxisChange = vi.fn();
    render(
      <PropertyGrid
        rows={[
          {
            kind: "vector3",
            id: "position",
            label: "Position",
            value: [1, 2, 3],
            defaultValue: [0, 0, 0],
            onChange,
            onAxisChange,
          },
        ]}
      />,
    );
    fireEvent.change(screen.getByTestId("property-position-y"), {
      target: { value: "9" },
    });
    expect(onAxisChange).toHaveBeenCalledWith(1, 9);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("property-position-reset"));
    expect(onChange).toHaveBeenCalledWith([0, 0, 0]);
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

  it("shows a W axis when four axes are supplied", () => {
    const onChange = vi.fn();
    render(
      <PropertyGrid
        rows={[
          {
            kind: "vector3",
            id: "offset",
            label: "Offset",
            value: [1, 2, 3, 4],
            axes: ["X", "Y", "Z", "W"],
            onChange,
          },
        ]}
      />,
    );
    fireEvent.change(screen.getByTestId("property-offset-w"), {
      target: { value: "9" },
    });
    expect(onChange).toHaveBeenCalledWith([1, 2, 3, 9]);
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
          {
            kind: "text",
            id: "name",
            label: "Name",
            value: "A",
            onChange: () => {},
          },
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
          {
            kind: "boolean",
            id: "visible",
            label: "Visible",
            value: true,
            onChange: () => {},
          },
          {
            kind: "text",
            id: "name",
            label: "Name",
            value: "Cube",
            onChange: () => {},
          },
          {
            kind: "color",
            id: "tint",
            label: "Tint",
            value: [1, 0, 0],
            onChange: () => {},
          },
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
    expect(
      (screen.getByTestId("property-name") as HTMLInputElement).value,
    ).toBe("Cube");
    expect(
      (screen.getByTestId("property-tint") as HTMLInputElement).value,
    ).toBe("#ff0000");
    expect(
      (screen.getByTestId("property-tint-hex") as HTMLInputElement).value,
    ).toBe("#ff0000");
    screen.getByTestId("property-mesh").click();
    expect(onPick).toHaveBeenCalled();
  });

  it("shows an asset display label instead of the raw guid", () => {
    render(
      <PropertyGrid
        rows={[
          {
            kind: "asset",
            id: "mesh",
            label: "Mesh",
            value: "guid-rock",
            displayLabel: "Rock",
            placeholder: "None",
            onPick: () => {},
            onChange: () => {},
          },
        ]}
      />,
    );
    const button = screen.getByLabelText("Mesh");
    expect(button.textContent).toContain("Rock");
    expect(button.textContent).not.toContain("guid-rock");
    expect(button.getAttribute("id")).toBe("property-mesh");
  });

  it("shows Open Asset beside an openable asset picker", () => {
    const openAsset = vi.fn();
    render(
      <AssetOpenProvider
        value={{
          canOpen: (guid) => guid === "guid-grass",
          openAsset,
        }}
      >
        <PropertyGrid
          rows={[
            {
              kind: "asset",
              id: "texture",
              label: "Texture",
              value: "guid-grass",
              displayLabel: "Grass",
              displayType: "Texture",
              visual: { assetType: "Texture" },
              placeholder: "None",
              onPick: () => {},
              onChange: () => {},
            },
          ]}
        />
      </AssetOpenProvider>,
    );
    screen.getByTestId("property-texture-open").click();
    expect(openAsset).toHaveBeenCalledWith("guid-grass");
    expect(screen.getByTestId("property-texture").textContent).toContain(
      "Grass",
    );
  });

  it("humanizes camelCase property keys as Title Case", () => {
    expect(humanizePropertyLabel("meshKind")).toBe("Mesh Kind");
    expect(humanizePropertyLabel("fixedTimestepMs")).toBe("Fixed Timestep MS");
    expect(humanizePropertyLabel("Name")).toBe("Name");
  });

  it("keeps 2D/3D acronyms and Title Cases Details labels", () => {
    expect(humanizePropertyLabel("2D camera width")).toBe("2D Camera Width");
    expect(humanizePropertyLabel("2 d camera width")).toBe("2D Camera Width");
    expect(humanizePropertyLabel("2dCameraWidth")).toBe("2D Camera Width");
    expect(humanizePropertyLabel("2DCameraWidth")).toBe("2D Camera Width");
    expect(humanizePropertyLabel("cameraBounds2D")).toBe("Camera Bounds 2D");
    expect(humanizePropertyLabel("3D (Havok)")).toBe("3D (Havok)");
    expect(humanizePropertyLabel("Execute JavaScript")).toBe(
      "Execute JavaScript",
    );
  });

  it("formats Event member names and node titles", () => {
    expect(formatEventMemberName("on hit")).toBe("On Hit");
    expect(formatEventMemberName("beginPlay")).toBe("Begin Play");
    expect(formatEventMemberName("Event beginPlay")).toBe("Begin Play");
    expect(formatEventMemberName("eventBeginPlay")).toBe("Begin Play");
    expect(formatEventTitle("on hit")).toBe("Event On Hit");
    expect(formatEventTitle("Event Begin Play")).toBe("Event Begin Play");
    expect(formatEventTitle("camera2D")).toBe("Event Camera 2D");
    expect(formatEventTitle("On Begin Overlap", "Collider")).toBe(
      "Event On Begin Overlap (Collider)",
    );
    expect(formatEventTitle("On Foo", "Inherited")).toBe(
      "Event On Foo (Inherited)",
    );
    expect(formatEventTitle("Begin Play")).toBe("Event Begin Play");
  });

  it("hides reset on disabled rows even when a default is present", () => {
    render(
      <PropertyGrid
        rows={[
          {
            kind: "number",
            id: "speed",
            label: "Speed",
            value: 5,
            defaultValue: 1,
            disabled: true,
            onChange: () => {},
          },
        ]}
      />,
    );
    expect(screen.queryByTestId("property-speed-reset")).toBeNull();
  });

  it("keeps read-only text selectable for native copy without edits or resets", () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    render(<PropertyGrid rows={[{
      kind: "text", id: "entry-id", label: "Entry ID", value: "first-tint",
      defaultValue: "other", readOnly: true, onChange, onCommit,
    }]} />);
    const input = screen.getByRole("textbox", { name: "Entry ID" }) as HTMLInputElement;
    expect(input.disabled).toBe(false);
    expect(input.readOnly).toBe(true);
    fireEvent.focus(input);
    expect(input.value.slice(input.selectionStart!, input.selectionEnd!)).toBe("first-tint");
    fireEvent.change(input, { target: { value: "changed" } });
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /^Reset / })).toBeNull();
  });

  it.each(["explicit", "inherited"])("keeps %s read-only live values current while blocking edits, picks, and resets", (policy) => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    const onPick = vi.fn();
    const rows: PropertyRow[] = [
      { kind: "text", id: "name", label: "Name", value: "Hero", defaultValue: "Actor", onChange, onCommit },
      { kind: "number", id: "health", label: "Health", value: 10, defaultValue: 100, onChange, onCommit },
      { kind: "vector3", id: "position", label: "Position", value: [1, 2, 3], onChange, onCommit },
      { kind: "boolean", id: "alive", label: "Alive", value: true, onChange },
      { kind: "enum", id: "mode", label: "Mode", value: "idle", options: [{ value: "idle", label: "Idle" }], onChange },
      { kind: "asset", id: "target", label: "Target", value: "actor-1", onChange, onPick },
    ];
    const grid = (values: PropertyRow[]) => <EditorReadOnlyContext.Provider value={policy === "inherited"}>
      <PropertyGrid rows={values} readOnly={policy === "explicit"} />
    </EditorReadOnlyContext.Provider>;
    const { rerender } = render(grid(rows));
    for (const id of ["name", "health", "position-x", "position-y", "position-z", "target", "mode"]) {
      expect((screen.getByTestId(`property-${id}`) as HTMLInputElement | HTMLButtonElement).disabled).toBe(true);
    }
    const checkbox = screen.getByRole("checkbox");
    expect(checkbox.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByTestId("property-target"));
    // Even a programmatic change/blur must not escape the read-only contract.
    fireEvent.change(screen.getByTestId("property-name"), { target: { value: "Changed" } });
    fireEvent.blur(screen.getByTestId("property-name"));
    expect(screen.queryByRole("button", { name: /^Reset / })).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();

    rerender(grid(rows.map((row) => row.id === "health" ? { ...row, value: 11 } as PropertyRow : row)));
    expect((screen.getByTestId("property-health") as HTMLInputElement).value).toBe("11");
    expect(checkbox.getAttribute("aria-checked")).toBe("true");
    expect(rows.every((row) => row.disabled === undefined)).toBe(true);
  });

  it("renders a bounded slider beside the numeric field", () => {
    const onChange = vi.fn();
    render(
      <PropertyGrid
        rows={[
          {
            kind: "slider",
            id: "friction",
            label: "Friction",
            value: 0.5,
            min: 0,
            max: 1,
            onChange,
          },
        ]}
      />,
    );
    expect(screen.getByTestId("property-friction-slider")).toBeTruthy();
    fireEvent.change(screen.getByTestId("property-friction"), {
      target: { value: "0.25" },
    });
    expect(onChange).toHaveBeenCalledWith(0.25);
  });

  it("renders flag bits and toggles a mask value", () => {
    const onChange = vi.fn();
    render(
      <PropertyGrid
        rows={[
          {
            kind: "flags",
            id: "layer",
            label: "Layer",
            value: 1,
            bitCount: 4,
            onChange,
          },
        ]}
      />,
    );
    expect(
      screen.getByTestId("property-layer-bit-0").getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.getByTestId("property-layer-bit-1").getAttribute("aria-pressed"),
    ).toBe("false");
    fireEvent.click(screen.getByTestId("property-layer-bit-1"));
    expect(onChange).toHaveBeenCalledWith(3);
  });

  it("selects text row values on tap so typing overwrites them", async () => {
    render(
      <PropertyGrid
        rows={[
          {
            kind: "text",
            id: "name",
            label: "Name",
            value: "Cube",
            onChange: () => {},
          },
        ]}
      />,
    );
    const input = screen.getByTestId("property-name") as HTMLInputElement;
    dispatchPointerEvent(input, "pointerdown", { pointerType: "touch" });
    input.focus();
    input.setSelectionRange(1, 1);
    dispatchPointerEvent(input, "pointerup", { pointerType: "touch" });

    await waitFor(() => {
      expect(input.selectionStart).toBe(0);
      expect(input.selectionEnd).toBe(input.value.length);
    });
  });

  it("shows units verbatim after the humanized label, beside the label accessory", () => {
    render(
      <PropertyGrid
        rows={[
          {
            kind: "number",
            id: "lifetime",
            label: "lifetime",
            unit: "s",
            labelAccessory: <button type="button">Value Mode</button>,
            value: 1,
            onChange: () => {},
          },
          {
            kind: "number",
            id: "duration",
            label: "Duration",
            unit: "ms",
            value: 250,
            onChange: () => {},
          },
        ]}
      />,
    );

    expect(screen.getByRole("textbox", { name: "Lifetime (s)" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Duration (ms)" })).toBeTruthy();
    expect(screen.queryByText(/\(S\)|\(MS\)/)).toBeNull();
    expect(
      within(screen.getByTestId("property-row-lifetime")).getByRole("button", {
        name: "Value Mode",
      }),
    ).toBeTruthy();
  });

  it("keeps a range ordered when Min passes Max or Max passes Min", () => {
    const onChange = vi.fn();
    render(
      <PropertyGrid
        rows={[
          {
            kind: "range",
            id: "lifetime",
            label: "Lifetime",
            value: [1, 2],
            onChange,
          },
        ]}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Lifetime Min" }), {
      target: { value: "5" },
    });
    expect(onChange).toHaveBeenLastCalledWith([5, 5]);
    fireEvent.change(screen.getByRole("textbox", { name: "Lifetime Max" }), {
      target: { value: "0" },
    });
    expect(onChange).toHaveBeenLastCalledWith([0, 0]);
  });

  it("edits and resets an RGBA color as one value", () => {
    const onChange = vi.fn();
    render(
      <PropertyGrid
        rows={[
          {
            kind: "color4",
            id: "tint",
            label: "Tint",
            value: [0, 1, 0, 0.5],
            defaultValue: [1, 1, 1, 1],
            onChange,
          },
        ]}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: "Tint Alpha" }), {
      target: { value: "0.25" },
    });
    expect(onChange).toHaveBeenLastCalledWith([0, 1, 0, 0.25]);
    fireEvent.change(screen.getByRole("textbox", { name: "Tint Hex" }), {
      target: { value: "#ff0000" },
    });
    expect(onChange).toHaveBeenLastCalledWith([1, 0, 0, 0.5]);

    onChange.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Reset Tint" }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith([1, 1, 1, 1]);
  });
});
