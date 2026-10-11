import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NamedListEditor } from "./named-list-editor";

function StatefulList({ initial }: { initial: string[] }) {
  const [values, setValues] = useState(initial);
  return <NamedListEditor values={values} onChange={setValues} />;
}

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

  it("keeps the edited row focused while typing and after reordering", () => {
    render(<StatefulList initial={["Default", "Foreground"]} />);
    const input = screen.getByTestId("named-list-0-value") as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: "Defaults" } });
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("Defaults");

    fireEvent.click(screen.getByTestId("named-list-0-move-down"));
    expect(screen.getByTestId("named-list-1-value")).toBe(input);
    expect(input.value).toBe("Defaults");
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
