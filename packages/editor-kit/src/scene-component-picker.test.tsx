import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SceneComponentPicker } from "./scene-component-picker";

afterEach(() => {
  cleanup();
});

const components = [
  {
    actorId: "hero",
    componentId: "hero-cam",
    actorName: "Hero",
    componentTitle: "Camera",
    classId: "CameraComponent",
  },
  {
    actorId: "lamp",
    componentId: "lamp-light",
    actorName: "Lamp",
    componentTitle: "Light",
    classId: "LightComponent",
  },
  {
    actorId: "side",
    componentId: "side-cam",
    actorName: "Side",
    componentTitle: "Camera",
    classId: "CameraComponent",
  },
];

describe("SceneComponentPicker", () => {
  it("filters to allowedClassIds in source and can clear the reference", () => {
    const onPick = vi.fn();
    render(
      <SceneComponentPicker
        open
        onOpenChange={() => {}}
        components={components}
        allowedClassIds={["CameraComponent"]}
        onPick={onPick}
      />,
    );
    expect(screen.getByTestId("search-item-hero:hero-cam")).toBeTruthy();
    expect(screen.getByTestId("search-item-side:side-cam")).toBeTruthy();
    expect(screen.queryByTestId("search-item-lamp:lamp-light")).toBeNull();
    expect(screen.getByTestId("search-item-hero:hero-cam").textContent).toContain(
      "Hero",
    );
    expect(screen.getByTestId("search-item-hero:hero-cam").textContent).toContain(
      "CameraComponent",
    );
    expect(screen.getByTestId("search-item-hero:hero-cam").textContent).not.toContain(
      "Engine",
    );
    screen.getByTestId("search-item-__none__").click();
    expect(onPick).toHaveBeenCalledWith(null);
  });

  it("passes the picked actor and component ids through", () => {
    const onPick = vi.fn();
    render(
      <SceneComponentPicker
        open
        onOpenChange={() => {}}
        components={components}
        allowedClassIds={["CameraComponent"]}
        allowNone={false}
        onPick={onPick}
      />,
    );
    screen.getByTestId("search-item-side:side-cam").click();
    expect(onPick).toHaveBeenCalledWith({
      actorId: "side",
      componentId: "side-cam",
    });
  });
});
