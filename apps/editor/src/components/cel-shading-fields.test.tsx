import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  normalizeCelShadingSettings,
  type CelShadingOverrides,
  type CelShadingSettings,
} from "@babylonslate/core";
import { CelShadingFields } from "./cel-shading-fields";

afterEach(cleanup);
function SceneFields({
  bands = 3,
  mixing = "strongest",
}: {
  bands?: number;
  mixing?: CelShadingSettings["lightMixing"];
}) {
  const [overrides, setOverrides] = useState<CelShadingOverrides>({});
  return (
    <CelShadingFields
      project={normalizeCelShadingSettings({
        shadowBands: bands,
        lightMixing: mixing,
      })}
      overrides={overrides}
      onChange={setOverrides}
    />
  );
}

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
  const blend = screen.getByRole("option", { name: "Blend", exact: true });
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
