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

  it("removes a row with a trash icon, not a Remove label", () => {
    render(
      <EntryListEditor
        items={[false]}
        onChange={() => {}}
        onCreate={() => true}
        renderItem={({ item }) => <span>{String(item)}</span>}
      />,
    );

    const remove = screen.getByRole("button", { name: "Remove row 1" });
    expect(remove).toBe(screen.getByTestId("entry-list-0-remove"));
    expect(screen.queryAllByText("Remove")).toEqual([]);
    expect(remove.className).toMatch(/icon-sm|size-7/);
  });

  it("clusters move and remove on a compact nowrap row", () => {
    render(
      <EntryListEditor
        items={[false]}
        onChange={() => {}}
        onCreate={() => true}
        renderItem={({ item }) => <span>{String(item)}</span>}
      />,
    );

    const remove = screen.getByTestId("entry-list-0-remove");
    const cluster = remove.parentElement;
    expect(cluster?.className).toMatch(/gap-0/);
    const row = cluster?.parentElement;
    expect(row?.className).toMatch(/flex-nowrap/);
    expect(row?.className).toMatch(/gap-1/);
    expect(row?.parentElement?.className).toMatch(/px-1/);
    expect(row?.parentElement?.className).toMatch(/py-0\.5/);
    expect(row?.parentElement?.className).not.toMatch(/\bp-2\b/);
    expect(cluster?.className).toMatch(/self-center/);
    expect(row?.className).toMatch(/items-center/);
  });

  it("shows an item count in-line next to Add", () => {
    const { rerender } = render(
      <EntryListEditor
        items={[]}
        onChange={() => {}}
        onCreate={() => false}
        addLabel="Add Item"
        renderItem={({ item }) => <span>{String(item)}</span>}
      />,
    );
    const count = screen.getByTestId("entry-list-count");
    expect(count.textContent).toBe("0 items");
    expect(count.className).toMatch(/text-xs/);
    expect(screen.getByTestId("entry-list-add").parentElement).toBe(
      count.parentElement,
    );

    rerender(
      <EntryListEditor
        items={[false]}
        onChange={() => {}}
        onCreate={() => true}
        addLabel="Add Item"
        renderItem={({ item }) => <span>{String(item)}</span>}
      />,
    );
    expect(screen.getByTestId("entry-list-count").textContent).toBe("1 item");
  });

  it("uses the Map count noun next to Add Entry", () => {
    render(
      <EntryListEditor
        items={[{ key: "a", value: 1 }]}
        onChange={() => {}}
        onCreate={() => ({ key: "", value: 0 })}
        addLabel="Add Entry"
        countNoun={{ one: "entry", other: "entries" }}
        renderItem={({ item }) => <span>{String(item.key)}</span>}
      />,
    );
    expect(screen.getByTestId("entry-list-count").textContent).toBe("1 entry");
  });
});
