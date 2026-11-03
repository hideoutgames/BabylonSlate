import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ParticleSystemParameter } from "@haptic/assets";
import type { PinDefaultEditorRequest } from "@haptic/graph-ui";
import { ClassParticleSystemsContext } from "../context/class-particle-systems-context";
import { particleParameterNameTypes } from "../lib/particle-parameter-name-types";
import { ParticleParameterNamePin } from "./particle-parameter-name-pin";

if (typeof window !== "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init?: MouseEventInit) {
      super(type, init);
    }
  }
  Object.defineProperty(window, "PointerEvent", { configurable: true, writable: true, value: PointerEventPolyfill });
}

const declared: Record<string, ParticleSystemParameter[]> = {
  glow: [
    { name: "Heat", type: "float", defaultValue: [1], overridden: false, slots: [0] },
    { name: "Tint", type: "color", defaultValue: [1, 1, 1, 1], overridden: false, slots: [0] },
  ],
  sparks: [{ name: "Wind", type: "vec3", defaultValue: [0, 0, 0], overridden: false, slots: [0] }],
};
vi.mock("../lib/use-particle-system-parameters", () => ({
  useParticleSystemParameters: (guids: readonly string[]) => new Map(guids.map((guid) => [guid, declared[guid] ?? []])),
}));

afterEach(() => cleanup());

function renderPin(runtime: string, value: string, systems: readonly string[]) {
  const onChange = vi.fn();
  const nodeData = { classId: "ParticleComponent", functionName: "Set Parameter", runtime };
  const request = { nodeId: "n", nodeType: "functions.call", nodeData, pin: { id: "name", name: "Name", type: { kind: "string" } }, value,
    preview: { kind: "string" }, disabled: false, onChange } as unknown as PinDefaultEditorRequest;
  render(<ClassParticleSystemsContext.Provider value={systems}><ParticleParameterNamePin request={request} /></ClassParticleSystemsContext.Provider>);
  return onChange;
}

describe("particle parameter Name pin", () => {
  it("lists the Class's parameters of the function's type and keeps an undeclared name selected", async () => {
    const onChange = renderPin("setParticleFloatParameter", "Old", ["glow", "sparks"]);
    fireEvent.click(screen.getByTestId("property-n:name"));
    expect(await screen.findByRole("option", { name: "Old (Not Declared)" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Tint" })).toBeNull();
    const heat = screen.getByRole("option", { name: "Heat" });
    fireEvent.pointerDown(heat);
    fireEvent.click(heat);
    expect(onChange).toHaveBeenCalledWith("Heat");
  });

  it("lists every type for Reset and falls back to free text without known parameters", async () => {
    renderPin("resetParticleParameter", "", ["glow", "sparks"]);
    fireEvent.click(screen.getByTestId("property-n:name"));
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["Heat", "Tint", "Wind"]);
    cleanup();
    const onChange = renderPin("setParticleColorParameter", "", []);
    const field = screen.getByTestId("property-n:name") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "Glow" } });
    fireEvent.blur(field);
    expect(onChange).toHaveBeenCalledWith("Glow");
  });

  it("applies only to Particle component parameter functions", () => {
    expect(particleParameterNameTypes("functions.call", { classId: "ParticleComponent", runtime: "setParticleVectorParameter" }))
      .toEqual(["vec2", "vec3"]);
    expect(particleParameterNameTypes("functions.call", { classId: "ParticleComponent", runtime: "playParticles" })).toBeUndefined();
    expect(particleParameterNameTypes("functions.call", { classId: "AudioComponent", runtime: "resetParticleParameter" })).toBeUndefined();
    expect(particleParameterNameTypes("particles.setFloatParameter", {})).toBeUndefined();
  });
});
