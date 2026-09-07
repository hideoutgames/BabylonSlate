import { cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { SerializedComponent } from "@babylonslate/core";
import { PropertyGrid } from "@babylonslate/editor-kit";
import { componentPropertyRows } from "./component-property-rows";

afterEach(cleanup);

function cameraEditor() {
  let committed: SerializedComponent = {
    id: "camera",
    classId: "CameraComponent",
    properties: { nearClip: 0.1, farClip: 1000, fieldOfView: 60 },
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
