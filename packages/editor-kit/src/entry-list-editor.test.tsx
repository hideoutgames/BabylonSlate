import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EntryListEditor } from "./entry-list-editor";

afterEach(() => {
  cleanup();
});

describe("EntryListEditor", () => {
  it("adds, removes, and reorders typed rows", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <EntryListEditor
        items={[false]}
        onChange={onChange}
        onCreate={() => true}
        addLabel="Add Item"
        renderItem={({ item, onChange: change }) => (
          <button type="button" data-testid="entry-toggle" onClick={() => change(!item)}>
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
