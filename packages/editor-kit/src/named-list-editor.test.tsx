import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NamedListEditor } from "./named-list-editor";

afterEach(() => {
  cleanup();
});

describe("NamedListEditor", () => {
  it("edits, adds, removes, and reorders string rows", () => {
    const onChange = vi.fn();
    render(
      <NamedListEditor
        values={["Default", "Foreground"]}
        onChange={onChange}
        title="Sorting Layers"
      />,
    );

    fireEvent.change(screen.getByTestId("named-list-0-value"), {
      target: { value: "Background" },
    });
    expect(onChange).toHaveBeenCalledWith(["Background", "Foreground"]);

    onChange.mockClear();
    fireEvent.change(screen.getByTestId("named-list-add-value"), {
      target: { value: "UI" },
    });
    fireEvent.click(screen.getByTestId("named-list-add"));
    expect(onChange).toHaveBeenCalledWith(["Default", "Foreground", "UI"]);

    onChange.mockClear();
    const up = screen.getByTestId("named-list-1-move-up");
    expect(up.className).toMatch(/icon-sm|size-7/);
    fireEvent.click(up);
    expect(onChange).toHaveBeenCalledWith(["Foreground", "Default"]);

    onChange.mockClear();
    fireEvent.click(screen.getByTestId("named-list-0-remove"));
    expect(onChange).toHaveBeenCalledWith(["Foreground"]);
  });

  it("removes a row with a trash icon, not a Remove label", () => {
    render(
      <NamedListEditor values={["Default"]} onChange={() => {}} />,
    );

    const remove = screen.getByRole("button", { name: "Remove row 1" });
    expect(remove).toBe(screen.getByTestId("named-list-0-remove"));
    expect(screen.queryAllByText("Remove")).toEqual([]);
    expect(remove.className).toMatch(/icon-sm|size-7/);
  });

  it("clusters move and remove on a compact nowrap row", () => {
    render(
      <NamedListEditor values={["Default"]} onChange={() => {}} />,
    );

    const remove = screen.getByTestId("named-list-0-remove");
    const cluster = remove.parentElement;
    expect(cluster?.className).toMatch(/gap-0/);
    const row = cluster?.parentElement;
    expect(row?.className).toMatch(/flex-nowrap/);
    expect(row?.className).toMatch(/gap-1/);
    expect(row?.parentElement?.className).toMatch(/px-1/);
    expect(row?.parentElement?.className).toMatch(/py-0\.5/);
    expect(row?.parentElement?.className).not.toMatch(/\bp-2\b/);
  });

  it("renders a custom item control", () => {
    const onChange = vi.fn();
    render(
      <NamedListEditor
        values={["guid-a"]}
        onChange={onChange}
        renderItem={({ value, onChange: change }) => (
          <button
            type="button"
            data-testid="custom-item"
            onClick={() => change("guid-b")}
          >
            {value}
          </button>
        )}
      />,
    );
    fireEvent.click(screen.getByTestId("custom-item"));
    expect(onChange).toHaveBeenCalledWith(["guid-b"]);
  });

  it("uses a custom add action instead of a typed name field", () => {
    const onAdd = vi.fn();
    render(
      <NamedListEditor
        values={["guid-a"]}
        onChange={() => {}}
        onAdd={onAdd}
        addLabel="Add Fallback"
      />,
    );
    expect(screen.queryByTestId("named-list-add-value")).toBeNull();
    fireEvent.click(screen.getByTestId("named-list-add"));
    expect(onAdd).toHaveBeenCalled();
  });
});
