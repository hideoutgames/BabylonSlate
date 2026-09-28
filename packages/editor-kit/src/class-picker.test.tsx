import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ClassPicker } from "./class-picker";
import { AssetCreateProvider, type AssetCreateApi } from "./asset-create-context";

afterEach(() => {
  cleanup();
});

describe("ClassPicker", () => {
  const classes = [
    { id: "GameInstance", name: "Game Instance", group: "Engine" },
    { id: "MyGame", name: "My Game", group: "Project", description: "assets/MyGame.class.babasset" },
    { id: "Actor", name: "Actor", group: "Engine" },
  ];

  it("filters to the provided list and can clear the reference", () => {
    const onPick = vi.fn();
    render(
      <ClassPicker
        open
        onOpenChange={() => {}}
        classes={classes.filter((entry) => entry.group === "Engine" || entry.id === "MyGame")}
        onPick={onPick}
      />,
    );
    expect(screen.getByTestId("search-item-MyGame")).toBeTruthy();
    screen.getByTestId("search-item-__none__").click();
    expect(onPick).toHaveBeenCalledWith(null);
  });

  it("passes the picked class id through", () => {
    const onPick = vi.fn();
    render(
      <ClassPicker
        open
        onOpenChange={() => {}}
        classes={classes}
        allowNone={false}
        onPick={onPick}
      />,
    );
    screen.getByTestId("search-item-MyGame").click();
    expect(onPick).toHaveBeenCalledWith("MyGame");
  });

  it("shows Class as the type line instead of Engine or Project", () => {
    render(
      <ClassPicker
        open
        onOpenChange={() => {}}
        classes={[
          { id: "main", name: "main.class", group: "Project" },
          { id: "Actor", name: "Actor", group: "Engine" },
        ]}
        allowNone={false}
        onPick={() => {}}
      />,
    );
    const projectRow = screen.getByTestId("search-item-main");
    expect(projectRow.textContent).toContain("main");
    expect(projectRow.textContent).not.toContain("main.class");
    expect(projectRow.textContent).toContain("Class");
    expect(projectRow.textContent).not.toContain("Project");
    const engineRow = screen.getByTestId("search-item-Actor");
    expect(engineRow.textContent).toContain("Class");
    expect(engineRow.textContent).not.toContain("Engine");
    expect(projectRow.querySelector("[data-type-family]")?.getAttribute("data-type-family")).toBe(
      "class",
    );
  });
});

describe("ClassPicker Create New Class", () => {
  const classes = [
    { id: "GameInstance", name: "Game Instance", group: "Engine" },
    { id: "MyGame", name: "My Game", group: "Project" },
  ];

  it("creates a child of createBaseClass named after the search text and picks its class id", async () => {
    const createClass = vi.fn(async () => "Arcade_Game");
    const api: AssetCreateApi = {
      canCreate: () => true,
      typeLabel: (type) => type,
      createAsset: vi.fn(async () => "unused"),
      createClass,
    };
    const onPick = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <AssetCreateProvider value={api}>
        <ClassPicker
          open
          onOpenChange={onOpenChange}
          classes={classes}
          createBaseClass="GameInstance"
          onPick={onPick}
        />
      </AssetCreateProvider>,
    );
    const row = screen.getByTestId("search-item-__create__Class");
    expect(row.textContent).toContain("Create New Class");
    expect(row.textContent).toContain("Child of Game Instance");
    fireEvent.change(screen.getByTestId("class-picker-query"), {
      target: { value: "Arcade Game" },
    });
    fireEvent.click(screen.getByTestId("search-item-__create__Class"));

    await waitFor(() => expect(onPick).toHaveBeenCalledWith("Arcade_Game"));
    expect(createClass).toHaveBeenCalledWith({
      parentClass: "GameInstance",
      name: "Arcade Game",
    });
    expect(api.createAsset).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("offers no create row to type and parent choosers without createBaseClass", () => {
    render(
      <AssetCreateProvider
        value={{
          canCreate: () => true,
          typeLabel: (type) => type,
          createAsset: async () => "unused",
          createClass: async () => "unused",
        }}
      >
        <ClassPicker open onOpenChange={() => {}} classes={classes} onPick={() => {}} />
      </AssetCreateProvider>,
    );
    expect(screen.getByTestId("search-item-MyGame")).toBeTruthy();
    expect(screen.queryByTestId("search-item-__create__Class")).toBeNull();
  });
});
