import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  normalizeCelShadingSettings,
  type CelShadingOverrides,
  type CelShadingSettings,
} from "@babylonslate/core";
import { CelShadingFields } from "./cel-shading-fields";

// Base UI dispatches PointerEvent when activating its native switch input.
if (typeof window.PointerEvent === "undefined") {
  window.PointerEvent = MouseEvent as unknown as typeof PointerEvent;
}

afterEach(cleanup);

it("disables specular independently without losing highlight settings and resets to project", () => {
  render(<SceneFields />);
  const specular = screen.getByRole("switch", { name: "Specular" });
  expect(specular.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Override Specular" }));
  fireEvent.click(specular);
  expect(specular.getAttribute("aria-checked")).toBe("false");
  expect((screen.getByLabelText("Specular Strength") as HTMLInputElement).value).toBe("0.2");
  fireEvent.click(screen.getByRole("button", { name: "Reset Specular To Project Settings" }));
  expect(specular.getAttribute("aria-checked")).toBe("true");
  expect(screen.queryByRole("button", { name: "Reset Specular To Project Settings" })).toBeNull();
});
function SceneFields({
  bands = 3,
  mixing = "strongest",
  outlineWidth = 1,
  outlineColor = [0.03, 0.03, 0.03],
}: {
  bands?: number;
  mixing?: CelShadingSettings["lightMixing"];
  outlineWidth?: number;
  outlineColor?: CelShadingSettings["outlineColor"];
}) {
  const [overrides, setOverrides] = useState<CelShadingOverrides>({});
  return (
    <CelShadingFields
      project={normalizeCelShadingSettings({
        shadowBands: bands,
        lightMixing: mixing,
        outlineWidth,
        outlineColor,
      })}
      overrides={overrides}
      onChange={setOverrides}
    />
  );
}

it("edits outline color and width independently, preserves appearance while disabled, and resets to live project values", () => {
  const view = render(<SceneFields />);
  const outlines = screen.getByRole("switch", { name: "Outlines" });
  expect(outlines.getAttribute("aria-checked")).toBe("true");
  expect((screen.getByLabelText("Outline Color Hex") as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Override Outline Color" }));
  fireEvent.change(screen.getByLabelText("Outline Color Hex"), { target: { value: "#804020" } });
  fireEvent.blur(screen.getByLabelText("Outline Color Hex"));
  fireEvent.click(screen.getByRole("button", { name: "Override Outline Width" }));
  fireEvent.change(screen.getByLabelText("Outline Width"), { target: { value: "2.375" } });
  fireEvent.click(screen.getByRole("button", { name: "Override Outlines" }));
  fireEvent.click(outlines);
  expect(outlines.getAttribute("aria-checked")).toBe("false");
  expect((screen.getByLabelText("Outline Width") as HTMLInputElement).value).toBe("2.375");
  expect((screen.getByLabelText("Outline Color Hex") as HTMLInputElement).value).toBe("#804020");
  view.rerender(<SceneFields outlineWidth={4} outlineColor={[0, 1, 0]} />);
  expect((screen.getByLabelText("Outline Width") as HTMLInputElement).value).toBe("2.375");
  fireEvent.click(screen.getByRole("button", { name: "Reset Outline Width To Project Settings" }));
  fireEvent.click(screen.getByRole("button", { name: "Reset Outline Color To Project Settings" }));
  expect((screen.getByLabelText("Outline Width") as HTMLInputElement).value).toBe("4");
  expect((screen.getByLabelText("Outline Color Hex") as HTMLInputElement).value).toBe("#00ff00");
  expect(outlines.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "Reset Outlines To Project Settings" }));
  expect(outlines.getAttribute("aria-checked")).toBe("true");
});

it("shows live project values until a field is overridden, and reset restores inheritance", () => {
  const view = render(<SceneFields />);
  expect(screen.queryByLabelText("Light Falloff")).toBeNull();
  let bands = screen.getByLabelText("Shadow Bands") as HTMLInputElement;
  expect(bands.value).toBe("3");
  expect(bands.disabled).toBe(true);
  fireEvent.click(
    screen.getByRole("button", { name: "Override Shadow Bands" }),
  );
  bands = screen.getByLabelText("Shadow Bands") as HTMLInputElement;
  expect(bands.disabled).toBe(false);
  fireEvent.change(bands, { target: { value: "6" } });
  expect(bands.value).toBe("6");
  expect(screen.getByText(/Scene Override · Project: 3/)).toBeTruthy();
  expect(
    (screen.getByLabelText("Shadow Strength") as HTMLInputElement).disabled,
  ).toBe(true);
  view.rerender(<SceneFields bands={4} />);
  expect(bands.value).toBe("6");
  fireEvent.click(
    screen.getByRole("button", {
      name: "Reset Shadow Bands To Project Settings",
    }),
  );
  bands = screen.getByLabelText("Shadow Bands") as HTMLInputElement;
  expect(bands.disabled).toBe(true);
  expect(bands.value).toBe("4");
  view.rerender(<SceneFields bands={5} />);
  expect(bands.value).toBe("5");
});

it("overrides light mixing independently and resets to the current project choice", () => {
  const view = render(<SceneFields />);
  expect(
    screen.getByRole("combobox", { name: "Light Mixing" }).textContent,
  ).toContain("Strongest Light");
  fireEvent.click(
    screen.getByRole("button", { name: "Override Light Mixing" }),
  );
  fireEvent.click(screen.getByRole("combobox", { name: "Light Mixing" }));
  const blend = screen.getByRole("option", { name: "Blend" });
  fireEvent.pointerDown(blend);
  fireEvent.click(blend);
  expect(
    screen.getByRole("combobox", { name: "Light Mixing" }).textContent,
  ).toContain("Blend");
  view.rerender(<SceneFields mixing="additive" />);
  expect(
    screen.getByRole("combobox", { name: "Light Mixing" }).textContent,
  ).toContain("Blend");
  fireEvent.click(
    screen.getByRole("button", {
      name: "Reset Light Mixing To Project Settings",
    }),
  );
  expect(
    screen.getByRole("combobox", { name: "Light Mixing" }).textContent,
  ).toContain("Additive");
  expect(
    (screen.getByLabelText("Shadow Bands") as HTMLInputElement).disabled,
  ).toBe(true);
});
