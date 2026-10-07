import { cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SerializedComponent } from "@babylonslate/core";
import { PropertyGrid } from "@babylonslate/editor-kit";
import { componentPropertyRows } from "./component-property-rows";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function cameraEditor(projectionMode = "perspective") {
  let committed: SerializedComponent = {
    id: "camera",
    classId: "CameraComponent",
    properties: { nearClip: 0.1, farClip: 1000, fieldOfView: 60, projectionMode },
  };
  function Editor() {
    const [component, setComponent] = useState(committed);
    return <PropertyGrid rows={componentPropertyRows("actor", component, (property, value) => {
      committed = { ...component, properties: { ...component.properties, [property]: value } };
      setComponent(committed);
    }, {
      sortingLayers: ["Default"],
      collisionLayers: ["Default"],
      physicsWorld: "3d",
      assetLabel: () => undefined,
      onPickAsset: () => {},
    })} />;
  }
  return { ...render(<Editor />), current: () => committed.properties };
}

describe("camera Details editing", () => {
  it("can reach whole orthographic sizes from the slider's fractional minimum", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 100, 20));
    const editor = cameraEditor("orthographic");
    const slider = await editor.findByRole("slider", { name: "Orthographic Size" });
    fireEvent.keyDown(slider, { key: "Home" });
    for (let step = 0; step < 9; step += 1) fireEvent.keyDown(slider, { key: "ArrowRight" });
    expect(editor.current().orthographicSize).toBe(1);
    expect((editor.getByTestId("property-actor-camera-orthographicSize") as HTMLInputElement).value).toBe("1");
  });

  it.each(["perspective", "orthographic"])("shows controls used by %s projection without validation warnings", (projectionMode) => {
    const editor = cameraEditor(projectionMode);
    expect(Boolean(editor.queryByTestId("property-actor-camera-fieldOfView"))).toBe(projectionMode === "perspective");
    expect(Boolean(editor.queryByTestId("property-actor-camera-orthographicSize"))).toBe(projectionMode === "orthographic");
    expect(editor.queryByText(/Near Clip must/)).toBeNull();
    expect(editor.queryByText(/Far Clip must/)).toBeNull();
  });

  it.each([
    { property: "nearClip", value: "5", expected: 5 },
    { property: "farClip", value: "50", expected: 50 },
  ])("retains valid $property edits", ({ property, value, expected }) => {
    const editor = cameraEditor();
    const input = editor.getByTestId(`property-actor-camera-${property}`);
    fireEvent.change(input, { target: { value } });
    fireEvent.blur(input);
    expect(editor.current()[property]).toBe(expected);
  });

  it.each([
    { property: "nearClip", value: "1001" },
    { property: "farClip", value: "0.01" },
  ])("prevents $property from crossing the other clipping plane", ({ property, value }) => {
    const editor = cameraEditor();
    const input = editor.getByTestId(`property-actor-camera-${property}`);
    fireEvent.change(input, { target: { value } });
    fireEvent.blur(input);
    expect(editor.current().nearClip).toBeGreaterThan(0);
    expect(editor.current().nearClip).toBeLessThan(editor.current().farClip as number);
    expect(Number((input as HTMLInputElement).value)).toBeCloseTo(editor.current()[property] as number, 2);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(editor.getByRole("alert").textContent).toMatch(/Clip must/);
  });

  it.each([
    { typed: "-90", expected: 1 },
    { typed: "1", expected: 1 },
    { typed: "179", expected: 179 },
  ])("commits FOV $typed as $expected", ({ typed, expected }) => {
    const editor = cameraEditor();
    const input = editor.getByTestId("property-actor-camera-fieldOfView");
    fireEvent.change(input, { target: { value: typed } });
    fireEvent.blur(input);
    expect(editor.current().fieldOfView).toBe(expected);
  });
});
