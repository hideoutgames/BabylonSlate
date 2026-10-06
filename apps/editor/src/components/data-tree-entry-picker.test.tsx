import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DataTreeEntryField } from "./data-tree-entry-picker";

afterEach(cleanup);

it("searches full paths to distinguish duplicate leaf names and preserves the exact chosen string", () => {
  const onChange = vi.fn();
  render(<DataTreeEntryField value="Weapons/Missing" onChange={onChange} includeRoot entries={[
    { id: "first", path: "Weapons/Iron Sword", effectiveDefinitionGuid: "weapon" },
    { id: "second", path: "Quest Items/Iron Sword", effectiveDefinitionGuid: "quest" },
  ]} testId="entry" />);
  expect(screen.getByRole("combobox", { name: "Entry Path" }).textContent).toContain("Missing Entry (Weapons/Missing)");
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("combobox", { name: "Entry Path" }));
  fireEvent.change(screen.getByTestId("entry-picker-query"), { target: { value: "Quest Items" } });
  expect(screen.queryByTestId("search-item-Weapons/Iron Sword")).toBeNull();
  fireEvent.click(screen.getByTestId("search-item-Quest Items/Iron Sword"));
  expect(onChange).toHaveBeenCalledWith("Quest Items/Iron Sword");
});

it("offers the virtual root only when allowed and does not emit disabled edits", () => {
  const onChange = vi.fn();
  const view = render(<DataTreeEntryField value="" onChange={onChange} entries={[]} includeRoot testId="entry" />);
  fireEvent.click(screen.getByRole("combobox", { name: "Entry Path" }));
  fireEvent.click(screen.getByTestId("search-item-/"));
  expect(onChange).toHaveBeenCalledWith("");
  view.rerender(<DataTreeEntryField value="" onChange={onChange} entries={[]} disabled testId="entry" />);
  expect(screen.getByRole("combobox", { name: "Entry Path" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(screen.getByRole("combobox", { name: "Entry Path" }));
  expect(screen.queryByTestId("search-item-/")).toBeNull();
  expect(onChange).toHaveBeenCalledTimes(1);
});
