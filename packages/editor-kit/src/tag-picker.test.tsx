import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTag, type TagContainer, type TagDefinition, type TagRegistry } from "@babylonslate/core";
import { TagPicker, TagProvider } from "./tag-picker";
import { dispatchPointerEvent } from "./test-support/pointer-events";

function pick(row: Element) {
  act(() => {
    dispatchPointerEvent(row, "pointerdown");
    dispatchPointerEvent(row, "pointerup");
  });
}

const entries: TagDefinition[] = [
  { id: 1, path: "State", parentId: 0 },
  { id: 2, path: "State.Moving", parentId: 1 },
  { id: 3, path: "State.Moving.Running", parentId: 2 },
  { id: 4, path: "State.Idle", parentId: 1 },
  { id: 5, path: "Damage", parentId: 0 },
];

afterEach(cleanup);

function MultiplePicker() {
  const [value, setValue] = useState<TagContainer>({ Tags: [3] });
  return <TagPicker mode="multiple" value={value} onChange={setValue} entries={entries} />;
}

describe("TagPicker", () => {
  it.each([[true, 4], [false, 0]])("applies the primary Tag when mixed=%s", (mixed, expected) => {
    const onChange = vi.fn();
    render(<TagPicker mode="single" value={4} mixed={Boolean(mixed)} onChange={onChange} entries={entries} />);
    fireEvent.click(screen.getByRole("button", { name: "Select Tag" }));
    pick(screen.getByText("Idle").closest('[role="treeitem"]')!);
    expect(onChange).toHaveBeenCalledWith(expected);
  });

  it("keeps an explicit registry separate from the surrounding creation handler", async () => {
    const onProjectCreate = vi.fn(() => 6);
    const onLocalCreate = vi.fn(() => 101);
    const onChange = vi.fn();
    const localEntries = [{ id: 100, path: "Local", parentId: 0 }];
    const { rerender } = render(<TagProvider entries={entries} onCreate={onProjectCreate}>
      <TagPicker mode="single" value={0} onChange={onChange} entries={localEntries} />
    </TagProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Select Tag" }));
    expect(screen.getByPlaceholderText("Example.Tag").hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Create" }).hasAttribute("disabled")).toBe(true);
    rerender(<TagProvider entries={entries} onCreate={onProjectCreate}>
      <TagPicker mode="single" value={0} onChange={onChange} entries={localEntries} onCreate={onLocalCreate} />
    </TagProvider>);
    fireEvent.change(screen.getByPlaceholderText("Example.Tag"), { target: { value: "Local.New" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(101));
    expect(onLocalCreate).toHaveBeenCalledWith("Local.New");
    expect(onProjectCreate).not.toHaveBeenCalled();
  });

  it("returns focus to its opener on Escape even when the opener was not focused", async () => {
    render(<TagPicker mode="single" value={0} onChange={() => {}} entries={entries} />);
    const trigger = screen.getByRole("button", { name: "Select Tag" });
    fireEvent.click(trigger);
    const search = screen.getByRole("textbox", { name: "Search Tags" });
    act(() => search.focus());
    fireEvent.keyDown(search, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("selects a category subtree, deselects its children, and clears the container", () => {
    render(<MultiplePicker />);
    fireEvent.click(screen.getByRole("button", { name: "Select Tags" }));
    expect(screen.getByRole("checkbox", { name: "State.Moving Selection" }).getAttribute("aria-checked")).toBe("mixed");
    const moving = screen.getByText("Moving").closest('[role="treeitem"]')!;
    pick(moving);
    expect(screen.getByRole("checkbox", { name: "State.Moving Selection" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("checkbox", { name: "State.Moving.Running Selection" }).getAttribute("aria-checked")).toBe("true");
    pick(moving);
    expect(screen.getByRole("checkbox", { name: "State.Moving.Running Selection" }).getAttribute("aria-checked")).toBe("false");
    pick(screen.getByText("State").closest('[role="treeitem"]')!);
    expect(screen.getByRole("checkbox", { name: "State.Idle Selection" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("checkbox", { name: "Damage Selection" }).getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Deselect All" }));
    expect(screen.getByText("0 Selected")).toBeTruthy();
  });

  it("searches full paths while retaining ancestors and emits only the chosen single Tag", () => {
    const onChange = vi.fn();
    render(<TagPicker mode="single" value={4} onChange={onChange} entries={entries} />);
    expect(screen.getByRole("button", { name: "Select Tag" }).textContent).toContain("State.Idle");
    fireEvent.click(screen.getByRole("button", { name: "Select Tag" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search Tags" }), { target: { value: "moving.running" } });
    const tree = screen.getByRole("tree", { name: "Tags" });
    expect(within(tree).getByText("State")).toBeTruthy();
    expect(within(tree).getByText("Moving")).toBeTruthy();
    expect(within(tree).queryByText("Idle")).toBeNull();
    pick(within(tree).getByText("Running").closest('[role="treeitem"]')!);
    expect(onChange).toHaveBeenCalledWith(3);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("navigates the hierarchy without changing selection until Enter", () => {
    const onChange = vi.fn();
    render(<TagPicker mode="single" value={0} onChange={onChange} entries={entries} />);
    fireEvent.click(screen.getByRole("button", { name: "Select Tag" }));
    const tree = screen.getByRole("tree", { name: "Tags" });
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(tree, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(1);
  });

  it("creates and selects a persistent Tag and its implicit categories", async () => {
    function PersistentPicker() {
      const [registry, setRegistry] = useState<TagRegistry>({ tags: entries, nextId: 6 });
      const [value, setValue] = useState(0);
      return <TagProvider entries={registry.tags} onCreate={(path) => {
        const created = createTag(registry, path);
        setRegistry(created.registry);
        return created.tag;
      }}><TagPicker mode="single" value={value} onChange={setValue} /></TagProvider>;
    }
    render(<PersistentPicker />);
    fireEvent.click(screen.getByRole("button", { name: "Select Tag" }));
    fireEvent.change(screen.getByPlaceholderText("Example.Tag"), { target: { value: "Ability.Fire.Burst" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Select Tag" }).textContent).toContain("Ability.Fire.Burst"));
    fireEvent.click(screen.getByRole("button", { name: "Select Tag" }));
    expect(screen.getByRole("tree", { name: "Tags" }).textContent).toContain("Ability");
    expect(screen.getByRole("tree", { name: "Tags" }).textContent).toContain("Fire");
  });

  it("keeps invalid names and failed creation in the popup without changing selection", async () => {
    const onCreate = vi.fn(() => Promise.reject(new Error("Storage Unavailable")));
    const onChange = vi.fn();
    render(<TagPicker mode="single" value={0} onChange={onChange} entries={entries} onCreate={onCreate} />);
    fireEvent.click(screen.getByRole("button", { name: "Select Tag" }));
    const input = screen.getByPlaceholderText("Example.Tag");
    fireEvent.change(input, { target: { value: "State..New" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(onCreate).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "State.New" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(screen.getByText("Storage Unavailable")).toBeTruthy());
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
