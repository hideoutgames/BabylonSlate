import { cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { quaternionToEulerDegrees, type SerializedComponent } from "@babylonslate/core";
import { PropertyGrid } from "@babylonslate/editor-kit";
import { applyPrefabPropertyDefaults, componentPropertyRows } from "./component-property-rows";
import { defaultPropertiesFor } from "../panels/add-component-catalog";

if (typeof window !== "undefined" && typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init?: MouseEventInit) {
      super(type, init);
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

afterEach(cleanup);

function physicsEditor(classId: string, properties: Record<string, unknown>, world: "2d" | "3d" = "3d", prefab?: SerializedComponent) {
  let committed: SerializedComponent = {
    id: "physics", classId,
    properties: { ...defaultPropertiesFor(classId, world), ...properties },
  };
  function Editor() {
    const [component, setComponent] = useState(committed);
    return <PropertyGrid rows={applyPrefabPropertyDefaults(componentPropertyRows("actor", component, (property, value) => {
      committed = { ...component, properties: { ...component.properties, [property]: value } };
      setComponent(committed);
    }, {
      sortingLayers: ["Default"], collisionLayers: ["Default"], physicsWorld: world,
      assetLabel: () => undefined, onPickAsset: () => {},
    }), prefab)} />;
  }
  const view = render(<Editor />);
  return {
    ...view,
    current: () => JSON.parse(JSON.stringify(committed.properties)) as Record<string, unknown>,
    edit: (property: string, value: string) => {
      const input = view.getByTestId(`property-actor-physics-${property}`);
      fireEvent.change(input, { target: { value } });
      fireEvent.blur(input);
    },
  };
}

describe("physics Details authoring", () => {
  it("edits hinge anchors and degree limits while preserving the target", () => {
    const editor = physicsEditor("PhysicsConstraintComponent", { kind: "hinge", targetActorId: "ceiling" });
    editor.edit("anchorA-x", "2.5");
    expect(editor.queryByTestId("property-actor-physics-minAngle")).toBeNull();
    fireEvent.click(editor.getByTestId("property-actor-physics-limitsEnabled"));
    editor.edit("minAngle", "-30");
    editor.edit("maxAngle", "70");
    expect(editor.current()).toMatchObject({ targetActorId: "ceiling", anchorA: { x: 2.5, y: 0, z: 0 }, limitsEnabled: true, minAngle: -30, maxAngle: 70 });
    expect(editor.queryByTestId("property-actor-physics-distance")).toBeNull();
    expect(editor.queryByTestId("property-actor-physics-frameA-x")).toBeNull();
  });

  it("authors fixed frame rotations in degrees and stores normalized quaternions", () => {
    const editor = physicsEditor("PhysicsConstraintComponent", { kind: "fixed" });
    editor.edit("frameB-z", "90");
    const frame = editor.current().frameB as { x: number; y: number; z: number; w: number };
    expect(quaternionToEulerDegrees([frame.x, frame.y, frame.z, frame.w])[2]).toBeCloseTo(90);
    expect(Math.hypot(frame.x, frame.y, frame.z, frame.w)).toBeCloseTo(1);
    expect(editor.queryByTestId("property-actor-physics-limitsEnabled")).toBeNull();
  });

  it("keeps edited hinge limits inside the backend's valid degree range", () => {
    const editor = physicsEditor("PhysicsConstraintComponent", { kind: "hinge", limitsEnabled: true });
    editor.edit("minAngle", "-720");
    editor.edit("maxAngle", "720");
    expect(editor.current()).toMatchObject({ minAngle: -180, maxAngle: 180 });
    editor.edit("minAngle", "999");
    expect(editor.current()).toMatchObject({ minAngle: 180, maxAngle: 180 });
  });

  it("shows invalid draft directions without losing the editor and allows recovery", () => {
    const editor = physicsEditor("PhysicsConstraintComponent", { kind: "hinge" });
    editor.edit("axisA-y", "0");
    expect(editor.getByText(/Cannot simulate with a zero direction/)).toBeTruthy();
    editor.edit("axisA-x", "1");
    expect(editor.getByText(/reference direction is parallel/)).toBeTruthy();
    editor.edit("referenceAxisA-y", "1");
    expect(editor.queryByText(/Cannot simulate/)).toBeNull();
    expect(editor.current().axisA).toEqual({ x: 1, y: 0, z: 0 });
  });

  it("keeps 2D anchors planar and omits 3D hinge directions", () => {
    const editor = physicsEditor("PhysicsConstraintComponent", { kind: "hinge" }, "2d");
    editor.edit("anchorB-y", "4");
    expect(editor.current().anchorB).toEqual({ x: 0, y: 4, z: 0 });
    expect(editor.queryByTestId("property-actor-physics-anchorB-z")).toBeNull();
    expect(editor.queryByTestId("property-actor-physics-axisA-x")).toBeNull();
    expect(editor.getByTestId("property-actor-physics-targetActorId").hasAttribute("disabled")).toBe(true);
  });

  it("exposes incompatible 3D axes after switching a scene to 2D so they can be repaired", () => {
    const editor = physicsEditor("PhysicsConstraintComponent", { kind: "hinge", axisA: { x: 0, y: 1, z: 0 } }, "2d");
    expect(editor.getByText(/2D hinge axes must point along Z/)).toBeTruthy();
    fireEvent.click(editor.getByRole("button", { name: "Reset Local Hinge Axis" }));
    expect(editor.current().axisA).toEqual({ x: 0, y: 0, z: 1 });
    expect(editor.queryByTestId("property-actor-physics-axisA-x")).toBeNull();
  });

  it("resets instance anchors and frame rotations to their Class defaults without changing serialized types", () => {
    const editor = physicsEditor("PhysicsConstraintComponent", { kind: "fixed" }, "3d", {
      id: "joint-template", classId: "PhysicsConstraintComponent", properties: {
        anchorA: { x: 1, y: 2, z: 3 },
        frameA: { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 },
      },
    });
    fireEvent.click(editor.getByRole("button", { name: "Reset Local Anchor" }));
    fireEvent.click(editor.getByRole("button", { name: "Reset Local Frame Rotation" }));
    expect(editor.current().anchorA).toEqual({ x: 1, y: 2, z: 3 });
    const frame = editor.current().frameA as { x: number; y: number; z: number; w: number };
    expect(quaternionToEulerDegrees([frame.x, frame.y, frame.z, frame.w])[2]).toBeCloseTo(90);
  });

  it("keeps an imported 2D distance constraint visible as unsupported without an ineffective distance control", () => {
    const editor = physicsEditor("PhysicsConstraintComponent", { kind: "distance", distance: 3 }, "2d");
    expect(editor.getByText(/Distance constraints require 3D physics/)).toBeTruthy();
    expect(editor.queryByTestId("property-actor-physics-distance")).toBeNull();
    expect(editor.current().distance).toBe(3);
  });

  it("authors skeletal physics settings without enabling the ragdoll as a side effect", () => {
    const editor = physicsEditor("RagdollComponent", { boneNames: ["hips", "spine"] });
    editor.edit("totalMass", "75");
    editor.edit("radius", "0.12");
    editor.edit("angularLimit", "60");
    expect(editor.current()).toMatchObject({ enabled: false, totalMass: 75, radius: 0.12, angularLimit: 60, boneNames: ["hips", "spine"] });
    fireEvent.click(editor.getByTestId("property-actor-physics-enabled"));
    expect(editor.current().enabled).toBe(true);
  });
});
