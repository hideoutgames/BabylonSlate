import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { GlobalParameter } from "@haptic/core";
import type { PinDefaultEditorRequest } from "@haptic/graph-ui";
import { GlobalParameterListEditor } from "./global-parameter-collection-editor";
import { globalParameterPinTypes } from "../lib/global-parameter-pin-types";
import { GlobalParameterNamePin } from "./global-parameter-name-pin";

if (typeof window !== "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init?: MouseEventInit) {
      super(type, init);
    }
  }
  Object.defineProperty(window, "PointerEvent", { configurable: true, writable: true, value: PointerEventPolyfill });
}

vi.mock("../lib/global-parameter-catalog", () => ({
  useGlobalParameterCatalog: () => ({
    fx: [
      { id: "heat", name: "Heat", type: "float", defaultValue: [1] },
      { id: "wind", name: "Wind", type: "vec3", defaultValue: [0, 0, 0] },
      { id: "drift", name: "Drift", type: "vec2", defaultValue: [0, 0] },
      { id: "gust", name: "Gust", type: "vec3", defaultValue: [0, 0, 0] },
      { id: "rect", name: "Rect", type: "vec4", defaultValue: [0, 0, 1, 1] },
    ],
  }),
}));

afterEach(() => cleanup());

function request(nodeType: string, nodeData: Record<string, unknown>, connectedInputIds: string[] = []) {
  const onChange = vi.fn();
  return {
    onChange,
    request: { nodeId: "n", nodeType, nodeData, connectedInputIds, pin: { id: "parameter", name: "Parameter", type: { kind: "string" } },
      value: "", preview: { kind: "string" }, disabled: false, onChange } as unknown as PinDefaultEditorRequest,
  };
}

describe("Global Parameter pin", () => {
  it("lists the collection's parameters of the node's type once Collection is set and unwired", async () => {
    const { request: vector, onChange } = request("globalParameters.setVector3Parameter", { "default:collection": "fx" });
    expect(globalParameterPinTypes(vector)).toEqual(["vec3"]);
    // Each vector node lists the parameters of its own width only.
    expect(globalParameterPinTypes(request("globalParameters.getVector2Parameter", { "default:collection": "fx" }).request)).toEqual(["vec2"]);
    expect(globalParameterPinTypes(request("globalParameters.setVector4Parameter", { "default:collection": "fx" }).request)).toEqual(["vec4"]);
    render(<GlobalParameterNamePin request={vector} />);
    fireEvent.click(screen.getByTestId("property-n:parameter"));
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["Wind", "Gust"]);
    const wind = screen.getByRole("option", { name: "Wind" });
    fireEvent.pointerDown(wind);
    fireEvent.click(wind);
    expect(onChange).toHaveBeenCalledWith("Wind");
    // Free text without a collection, with a wired one, and on other pins.
    expect(globalParameterPinTypes(request("globalParameters.setVector3Parameter", {}).request)).toBeUndefined();
    expect(globalParameterPinTypes(request("globalParameters.getFloatParameter", { "default:collection": "fx" }, ["collection"]).request)).toBeUndefined();
    expect(globalParameterPinTypes(request("debug.log", { "default:collection": "fx" }).request)).toBeUndefined();
  });
});

describe("Global Parameter Collection editor", () => {
  function renderList(initial: GlobalParameter[]) {
    let current = initial;
    function Host() {
      const [parameters, setParameters] = useState(initial);
      current = parameters;
      return <GlobalParameterListEditor parameters={parameters} onChange={(next) => { current = next; setParameters(next); }} />;
    }
    render(<Host />);
    return () => current;
  }

  it("adds parameters with free names, keeps renames unique and resizes on retype", async () => {
    const read = renderList([]);
    fireEvent.click(screen.getByTestId("global-parameter-list-add"));
    fireEvent.click(screen.getByTestId("global-parameter-list-add"));
    expect(read().map(({ name, type, defaultValue }) => ({ name, type, defaultValue }))).toEqual([
      { name: "Parameter", type: "float", defaultValue: [0] },
      { name: "Parameter_1", type: "float", defaultValue: [0] },
    ]);
    const second = read()[1]!;
    const name = screen.getByTestId(`property-global-parameter-${second.id}-name`);
    fireEvent.change(name, { target: { value: "Parameter" } });
    fireEvent.blur(name);
    expect(read()[1]!.name).toBe("Parameter_1");
    fireEvent.change(name, { target: { value: " Heat " } });
    fireEvent.blur(name);
    expect(read()[1]!.name).toBe("Heat");
    fireEvent.click(screen.getByTestId(`property-global-parameter-${second.id}-type`));
    const color = await screen.findByRole("option", { name: "Color" });
    fireEvent.pointerDown(color);
    fireEvent.click(color);
    expect(read()[1]).toMatchObject({ type: "color", defaultValue: [0, 0, 0, 1] });
    // A Vector4 offers four number fields, where a Color offers a colour picker.
    fireEvent.click(screen.getByTestId(`property-global-parameter-${second.id}-type`));
    const vector4 = await screen.findByRole("option", { name: "Vector4" });
    fireEvent.pointerDown(vector4);
    fireEvent.click(vector4);
    expect(read()[1]).toMatchObject({ type: "vec4", defaultValue: [0, 0, 0, 1] });
    for (const axis of ["x", "y", "z", "w"]) expect(screen.getByTestId(`property-global-parameter-${second.id}-default-${axis}`)).toBeTruthy();
  });
});
