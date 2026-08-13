import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ClassPicker } from "./class-picker";

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
});
