import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EntryListEditor } from "./entry-list-editor";
import { Button } from "@babylonslate/ui/components/button";
import { useState } from "react";

afterEach(() => {
  cleanup();
});

describe("EntryListEditor", () => {
  it("keeps row-local state with its identity after reordering", () => {
    function Row({ name }: { name: string }) {
      const [count, setCount] = useState(0);
      return <Button onClick={() => setCount(count + 1)}>{name}: {count}</Button>;
    }
    const props = {
      getItemKey: (item: string) => item,
      onAdd: () => {},
      onChange: () => {},
      renderItem: ({ item }: { item: string }) => <Row name={item} />,
    };
    const { rerender } = render(<EntryListEditor {...props} items={["a", "b"]} />);
    fireEvent.click(screen.getByRole("button", { name: "b: 0" }));
    rerender(<EntryListEditor {...props} items={["b", "a"]} />);
    expect(screen.getByRole("button", { name: "b: 1" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "a: 0" })).toBeTruthy();
  });
  it("delegates Add to a picker and lets its header edit the complete entry", () => {
    const onAdd = vi.fn();
    const onChange = vi.fn();
    const props = {
      items: [{ name: "Bloom", enabled: true }],
      onAdd,
      onChange,
      renderItem: ({ item }: { item: { name: string; enabled: boolean } }) => (
        <span>{item.enabled ? "Enabled" : "Disabled"}</span>
      ),
      renderItemHeader: ({
        item,
        onChange: change,
      }: {
        item: { name: string; enabled: boolean };
        onChange: (item: { name: string; enabled: boolean }) => void;
      }) => (
        <Button onClick={() => change({ ...item, name: "Vignette" })}>
          {item.name}
        </Button>
      ),
    };
    const { rerender } = render(<EntryListEditor {...props} />);
    fireEvent.click(screen.getByTestId("entry-list-add"));
    expect(onAdd).toHaveBeenCalledOnce();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Bloom" }));
    expect(onChange).toHaveBeenCalledWith([
      { name: "Vignette", enabled: true },
    ]);
    rerender(<EntryListEditor {...props} maxItems={1} />);
    expect(screen.getByTestId("entry-list-add")).toHaveProperty(
      "disabled",
      true,
    );
  });
  it("adds, removes, and reorders typed rows", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <EntryListEditor
        items={[false]}
        onChange={onChange}
        onCreate={() => true}
        addLabel="Add Item"
        renderItem={({ item, onChange: change }) => (
          <button
            type="button"
            data-testid="entry-toggle"
            onClick={() => change(!item)}
          >
            {String(item)}
          </button>
        )}
      />,
    );

    fireEvent.click(screen.getByTestId("entry-list-add"));
    expect(onChange).toHaveBeenCalledWith([false, true]);

    onChange.mockClear();
    fireEvent.click(screen.getByTestId("entry-list-0-remove"));
    expect(onChange).toHaveBeenCalledWith([]);

    rerender(
      <EntryListEditor
        items={[false, true]}
        onChange={onChange}
        onCreate={() => true}
        addLabel="Add Item"
        renderItem={({ item, index, onChange: change }) => (
          <button
            type="button"
            data-testid={`entry-${index}`}
            onClick={() => change(!item)}
          >
            {String(item)}
          </button>
        )}
      />,
    );
    onChange.mockClear();
    fireEvent.click(screen.getByTestId("entry-list-1-move-up"));
    expect(onChange).toHaveBeenCalledWith([true, false]);
  });
});
