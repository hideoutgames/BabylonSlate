import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SceneActorPicker } from "./scene-actor-picker";

afterEach(() => {
  cleanup();
});

const actors = [
  { actorId: "hero", actorName: "Hero", classId: "Player", group: "Camera Actors" },
  { actorId: "lamp", actorName: "Lamp", classId: "Actor" },
];

describe("SceneActorPicker", () => {
  it("lists each actor under its group with its class and can clear the reference", () => {
    const onPick = vi.fn();
    render(<SceneActorPicker open onOpenChange={() => {}} actors={actors} onPick={onPick} />);
    expect(screen.getByTestId("search-item-hero").textContent).toContain("Hero");
    expect(screen.getByTestId("search-item-hero").textContent).toContain("Player");
    expect(screen.getByText("Camera Actors")).toBeTruthy();
    expect(screen.getByText("Actors")).toBeTruthy();
    screen.getByTestId("search-item-__none__").click();
    expect(onPick).toHaveBeenCalledWith(null);
  });

  it("passes the picked actor id through and offers no None when it is not allowed", () => {
    const onPick = vi.fn();
    render(<SceneActorPicker open onOpenChange={() => {}} actors={actors} allowNone={false} onPick={onPick} />);
    expect(screen.queryByTestId("search-item-__none__")).toBeNull();
    screen.getByTestId("search-item-lamp").click();
    expect(onPick).toHaveBeenCalledWith("lamp");
  });
});
