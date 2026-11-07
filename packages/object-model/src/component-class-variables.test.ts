import { describe, expect, it, vi } from "vitest";
import { supportsOverlayVisualStyle } from "@haptic/core";
import { Actor, ActorComponent, MaterialObject } from "./objects";

// Counts class lookups, so a read that looks the class up again is caught.
vi.mock("@haptic/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@haptic/core")>();
  return { ...actual, supportsOverlayVisualStyle: vi.fn(actual.supportsOverlayVisualStyle) };
});

describe("ActorComponent class-dependent variables", () => {
  it.each([
    ["2DTextComponent", 1, [1, 1, 1, 1]],
    ["2DSliderComponent", 1, [1, 1, 1, 1]],
    ["2DProgressBarComponent", 1, [1, 1, 1, 1]],
    ["ColliderComponent", undefined, undefined],
    ["MeshComponent", undefined, undefined],
  ])("%s reads unset opacity as %s and tint as %j", (classId, opacity, tint) => {
    const component = new ActorComponent({ classId });
    expect(component.getVariable("opacity")).toEqual(opacity);
    expect(component.getVariable("tint")).toEqual(tint);
    component.setVariable("opacity", 0.25);
    expect(component.getVariable("opacity")).toBe(0.25);
  });

  it.each(["MeshComponent", "DynamicRuntimeMeshComponent"])("%s owns a read-only materialObject", (classId) => {
    const owner = new Actor({ classId: "Actor" });
    const component = new ActorComponent({ classId, variables: { materialGuid: "material" } });
    component.owner = owner;
    const material = component.getVariable("materialObject");
    expect(material).toBeInstanceOf(MaterialObject);
    component.setVariable("materialObject", null);
    expect(component.getVariable("materialObject")).toBe(material);
  });

  it("stores materialObject as a plain variable on other classes", () => {
    const component = new ActorComponent({ classId: "ColliderComponent" });
    component.setVariable("materialObject", "plain");
    expect(component.getVariable("materialObject")).toBe("plain");
  });

  it("looks its class up once, not on every read", () => {
    const lookups = vi.mocked(supportsOverlayVisualStyle);
    lookups.mockClear();
    const component = new ActorComponent({ classId: "ColliderComponent", variables: { friction: 0.5 } });
    for (let read = 0; read < 10; read++) component.getVariable("friction");
    expect(lookups).toHaveBeenCalledTimes(1);
  });
});
