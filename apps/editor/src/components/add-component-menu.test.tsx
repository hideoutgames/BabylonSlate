import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AddComponentMenu } from "./add-component-menu";
import type { AddComponentItem } from "../panels/add-component-catalog";

afterEach(() => {
  cleanup();
});

const projectModel: AddComponentItem = {
  id: "asset-hero",
  classId: "MeshComponent",
  label: "Hero",
  description: "Model",
  category: "Project",
  properties: { assetGuid: "hero" },
};

describe("AddComponentMenu", () => {
  it.each(["2d", "3d"] as const)("adds Movement to a %s world actor", (physicsWorld) => {
    const onSelect = vi.fn();
    render(<AddComponentMenu open onOpenChange={vi.fn()} onSelect={onSelect} physicsWorld={physicsWorld} />);
    const search = screen.getByTestId("add-component-catalog-search");
    fireEvent.change(search, { target: { value: "movement" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith({ classId: "MovementComponent" });
  });

  it("offers constraints in both physics worlds and restricts skeletal ragdolls to 3D", () => {
    const onSelect = vi.fn();
    const view = render(<AddComponentMenu open onOpenChange={vi.fn()} onSelect={onSelect} physicsWorld="2d" />);
    expect(screen.queryByTestId("add-component-catalog-item-RagdollComponent")).toBeNull();
    fireEvent.click(screen.getByTestId("add-component-catalog-item-PhysicsConstraintComponent"));
    expect(onSelect).toHaveBeenLastCalledWith({ classId: "PhysicsConstraintComponent" });
    view.rerender(<AddComponentMenu open onOpenChange={vi.fn()} onSelect={onSelect} physicsWorld="3d" />);
    fireEvent.click(screen.getByTestId("add-component-catalog-item-RagdollComponent"));
    expect(onSelect).toHaveBeenLastCalledWith({ classId: "RagdollComponent" });
  });

  it("passes classId and property overrides when a project Model is picked from search", () => {
    const onSelect = vi.fn();
    render(
      <AddComponentMenu
        open
        onOpenChange={vi.fn()}
        onSelect={onSelect}
        projectItems={[projectModel]}
      />,
    );
    const search = screen.getByTestId("add-component-catalog-search");
    fireEvent.change(search, { target: { value: "hero" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith({
      classId: "MeshComponent",
      properties: { assetGuid: "hero" },
    });
  });

  it("still reports engine class picks as classId with no extra properties", () => {
    const onSelect = vi.fn();
    render(
      <AddComponentMenu
        open
        onOpenChange={vi.fn()}
        onSelect={onSelect}
        projectItems={[]}
      />,
    );
    fireEvent.click(
      screen.getByTestId("add-component-catalog-item-LightComponent"),
    );
    expect(onSelect).toHaveBeenCalledWith({ classId: "LightComponent" });
  });
});
