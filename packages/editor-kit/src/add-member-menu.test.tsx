import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ADD_MEMBER_EMPTY_ID, AddMemberMenu } from "./add-member-menu";

const items = [
  { id: "a", name: "Apply Damage", description: "Interface · Damageable", overwritten: false, kind: "interface" },
  { id: "b", name: "Tick", description: "Parent · Actor", overwritten: true, kind: "parent" },
];

function renderMenu(onCreateEmpty = vi.fn(), onPick = vi.fn()) {
  render(
    <AddMemberMenu open onOpenChange={() => {}} items={items} onCreateEmpty={onCreateEmpty} onPick={onPick}>
      <button type="button">Add</button>
    </AddMemberMenu>,
  );
  return { onCreateEmpty, onPick };
}

describe("AddMemberMenu", () => {
  afterEach(cleanup);

  it("creates an empty member from the New row", () => {
    const { onCreateEmpty, onPick } = renderMenu();
    screen.getByTestId(`search-item-${ADD_MEMBER_EMPTY_ID}`).click();
    expect(onCreateEmpty).toHaveBeenCalledOnce();
    expect(onPick).not.toHaveBeenCalled();
  });

  it("picks an overridable member and omits ones already overridden", () => {
    const { onPick } = renderMenu();
    expect(screen.queryByTestId("search-item-b")).toBeNull();
    screen.getByTestId("search-item-a").click();
    expect(onPick).toHaveBeenCalledWith("a");
  });

  it("keeps the New row while searching by source", () => {
    renderMenu();
    fireEvent.change(screen.getByTestId("add-function-menu-query"), { target: { value: "damageable" } });
    expect(screen.getByTestId(`search-item-${ADD_MEMBER_EMPTY_ID}`)).toBeTruthy();
    expect(screen.getByTestId("search-item-a")).toBeTruthy();
  });
});
