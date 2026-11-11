import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PinDefaultEditorRequest } from "@haptic/graph-ui";
import { ClassMaterialsContext } from "../context/class-materials-context";
import { materialParameterPinTypes } from "../lib/material-parameter-pin-types";
import { materialParameterNames, meshMaterialGuidsOf } from "../lib/use-material-parameter-names";
import { MaterialParameterNamePin } from "./material-parameter-name-pin";

if (typeof window !== "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init?: MouseEventInit) {
      super(type, init);
    }
  }
  Object.defineProperty(window, "PointerEvent", { configurable: true, writable: true, value: PointerEventPolyfill });
}

vi.mock("../lib/use-material-parameter-names", async (original) => ({
  ...(await original<typeof import("../lib/use-material-parameter-names")>()),
  useMaterialParameterNames: (guids: readonly string[]) => new Map(guids.map((guid) => [guid, guid === "rock"
    ? [{ name: "Tiling", type: "vec2" }, { name: "Tint", type: "color" }, { name: "Glow", type: "vec3" }, { name: "Offset", type: "vec2" }, { name: "Rect", type: "vec4" }]
    : []])),
}));

afterEach(() => cleanup());

function renderPin(nodeType: string, value: string, materials: readonly string[]) {
  const onChange = vi.fn();
  const request = { nodeId: "n", nodeType, nodeData: {}, pin: { id: "name", name: "Name", type: { kind: "string" } }, value,
    preview: { kind: "string" }, disabled: false, onChange } as unknown as PinDefaultEditorRequest;
  render(<ClassMaterialsContext.Provider value={materials}><MaterialParameterNamePin request={request} /></ClassMaterialsContext.Provider>);
  return onChange;
}

describe("Material parameter Name pin", () => {
  it("lists the Class's Material parameters of the node's type", async () => {
    const onChange = renderPin("material.setVector2Parameter", "", ["rock"]);
    fireEvent.click(screen.getByTestId("property-n:name"));
    // A Vector2 node lists Vector2 parameters only: not the Vector3 Glow or the Vector4 Rect.
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["Offset", "Tiling"]);
    const tiling = screen.getByRole("option", { name: "Tiling" });
    fireEvent.pointerDown(tiling);
    fireEvent.click(tiling);
    expect(onChange).toHaveBeenCalledWith("Tiling");
  });

  it("stays free text without a known parameter and applies only to Material parameter nodes", () => {
    renderPin("material.getFloatParameter", "", ["rock"]);
    expect((screen.getByTestId("property-n:name") as HTMLInputElement).tagName).toBe("INPUT");
    expect(materialParameterPinTypes({ nodeType: "material.resetTextureParameter", pin: { id: "name" } as never })).toEqual(["texture"]);
    expect(materialParameterPinTypes({ nodeType: "material.setFloatParameter", pin: { id: "value" } as never })).toBeUndefined();
  });

  it("reads parameter names from a Material and the Materials of mesh components", () => {
    expect(materialParameterNames({ nodes: [
      { type: "param.vec2", properties: { name: " Tiling " } },
      { type: "param.float", properties: { name: "" } },
      { type: "const.float", properties: { value: [1] } },
    ] })).toEqual([{ name: "Tiling", type: "vec2" }]);
    expect(meshMaterialGuidsOf({ components: [
      { id: "a", classId: "MeshComponent", properties: { materialGuid: "rock" } },
      { id: "b", classId: "DynamicRuntimeMeshComponent", properties: { materialGuid: "glass" } },
      { id: "c", classId: "MeshComponent", properties: { materialGuid: "rock" } },
      { id: "d", classId: "ParticleComponent", properties: { materialGuid: "x" } },
    ] })).toEqual(["glass", "rock"]);
  });
});
