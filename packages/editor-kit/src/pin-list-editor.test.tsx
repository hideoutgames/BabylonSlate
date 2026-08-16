import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PinListEditor, type PinListRow } from "./pin-list-editor";

if (typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init?: MouseEventInit) {
      super(type, init);
    }
  }
  Object.defineProperty(window, "PointerEvent", {
    value: PointerEventPolyfill,
  });
}

const rows: PinListRow[] = [
  { id: "a", name: "amount", type: "float", direction: "in" },
  { id: "b", name: "result", type: "bool", direction: "out" },
];

describe("PinListEditor", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders compact color+name rows without per-row field groups", () => {
    render(<PinListEditor rows={rows} onChange={() => {}} />);
    expect(screen.getByTestId("pin-list-editor")).toBeTruthy();
    expect(screen.getByTestId("pin-row-a")).toBeTruthy();
    expect(screen.getByDisplayValue("amount")).toBeTruthy();
    expect(screen.queryByLabelText("Optional")).toBeNull();
    const swatch = screen
      .getByTestId("pin-row-a")
      .querySelector("[data-type-color-swatch]");
    expect((swatch as HTMLElement).style.backgroundColor).toBe(
      "var(--pin-float)",
    );
  });

  it("moves and removes rows", () => {
    const onChange = vi.fn();
    render(<PinListEditor rows={rows} onChange={onChange} />);
    screen.getByTestId("pin-a-move-down").click();
    expect(onChange.mock.calls[0]![0].map((row: PinListRow) => row.id)).toEqual(
      ["b", "a"],
    );
    onChange.mockClear();
    screen.getByRole("button", { name: "Remove amount" }).click();
    expect(onChange).toHaveBeenCalledWith([rows[1]]);
    expect(screen.queryAllByText("Remove")).toEqual([]);
  });

  it("keeps typeClassId on object pins and exposes a Class Type picker", async () => {
    const onChange = vi.fn();
    render(
      <PinListEditor
        rows={[
          {
            id: "a",
            name: "target",
            type: "object",
            direction: "in",
            typeClassId: "Hero",
          },
        ]}
        selectedId="a"
        classEntries={[{ id: "Hero", name: "Hero" }, { id: "Actor", name: "Actor" }]}
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId("pin-a-class-type")).toBeTruthy();
    expect(screen.getByTestId("pin-a-class-type").textContent).toContain("Hero");
    expect(screen.getByTestId("pin-a-class-type").textContent).toContain("Class");
    expect(
      screen
        .getByTestId("pin-a-class-type")
        .querySelector("[data-type-family]")
        ?.getAttribute("data-type-family"),
    ).toBe("class");
    screen.getByTestId("pin-a-class-type").click();
    await waitFor(() => {
      expect(screen.getByTestId("search-item-Actor")).toBeTruthy();
    });
    screen.getByTestId("search-item-Actor").click();
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ id: "a", typeClassId: "Actor" }),
    ]);
  });

  it("adds an input or output pin", () => {
    const onChange = vi.fn();
    render(
      <PinListEditor rows={[]} onChange={onChange} showDirection />,
    );
    fireEvent.change(screen.getByPlaceholderText("name"), {
      target: { value: "hit" },
    });
    screen.getByRole("button", { name: "Add Output" }).click();
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({
        name: "hit",
        type: "float",
        direction: "out",
      }),
    ]);
  });

  it("shows optional and default on the selected row", () => {
    const onChange = vi.fn();
    render(
      <PinListEditor
        rows={rows.slice(0, 1)}
        selectedId="a"
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId("pin-a-optional"));
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ id: "a", optional: true }),
    ]);
  });

  it("adds an input pin with direction", () => {
    const onChange = vi.fn();
    render(
      <PinListEditor rows={rows} onChange={onChange} showDirection />,
    );
    fireEvent.change(screen.getByPlaceholderText("name"), {
      target: { value: "score" },
    });
    fireEvent.click(screen.getByTestId("pin-add-input"));
    expect(onChange).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ name: "score", direction: "in" }),
      ]),
    );
  });

  it("hides add and move controls when readOnly", () => {
    render(<PinListEditor rows={rows} onChange={() => {}} readOnly />);
    expect(screen.queryByTestId("pin-add")).toBeNull();
    expect(screen.queryByTestId("pin-a-move-up")).toBeNull();
    expect(screen.getByTestId("pin-a-name")).toHaveProperty("disabled", true);
  });
});
