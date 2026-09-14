import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AddComponentDialog } from "./add-component-dialog";
import { projectAddComponentItems, type AddComponentItem } from "../panels/add-component-catalog";

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

describe("AddComponentDialog", () => {
  it("shows the class icon and color when choosing a nested ActorComponent subclass", () => {
    const onSelect = vi.fn();
    const projectItems = projectAddComponentItems([
      { header: { guid: "health", name: "Health", type: "Class", parentClass: "ActorComponent" } },
      { header: { guid: "regen", name: "RegenHealth", type: "Class", parentClass: "Health" } },
    ]);
    render(<AddComponentDialog open onOpenChange={vi.fn()} onSelect={onSelect} projectItems={projectItems} />);
    const row = screen.getByTestId("add-component-catalog-item-class-RegenHealth");
    const icon = row.querySelector("svg[data-type-icon]");
    expect(icon?.getAttribute("data-type-icon")).toBe("ActorComponent");
    expect(icon?.getAttribute("stroke")).toBe("var(--asset-animation)");
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith({ classId: "RegenHealth", properties: {} });
  });

  it("passes classId and property overrides when a project Model is picked", () => {
    const onSelect = vi.fn();
    render(
      <AddComponentDialog
        open
        onOpenChange={vi.fn()}
        onSelect={onSelect}
        projectItems={[projectModel]}
      />,
    );
    fireEvent.click(screen.getByTestId("add-component-catalog-item-asset-hero"));
    expect(onSelect).toHaveBeenCalledWith({
      classId: "MeshComponent",
      properties: { assetGuid: "hero" },
    });
  });

  it("still reports engine class picks as classId with no extra properties", () => {
    const onSelect = vi.fn();
    render(
      <AddComponentDialog
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
