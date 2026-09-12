import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { normalizeCelShadingSettings, type CelShadingOverrides } from "@babylonslate/core";
import { CelShadingFields } from "./cel-shading-fields";

afterEach(cleanup);
function SceneFields({ bands = 3 }: { bands?: number }) {
  const [overrides, setOverrides] = useState<CelShadingOverrides>({});
  return <CelShadingFields project={normalizeCelShadingSettings({ shadowBands: bands })} overrides={overrides} onChange={setOverrides} />;
}

it("shows live project values until a field is overridden, and reset restores inheritance", () => {
  const view = render(<SceneFields />);
  let bands = screen.getByLabelText("Shadow Bands") as HTMLInputElement;
  expect(bands.value).toBe("3");
  expect(bands.disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Override Shadow Bands" }));
  bands = screen.getByLabelText("Shadow Bands") as HTMLInputElement;
  expect(bands.disabled).toBe(false);
  fireEvent.change(bands, { target: { value: "6" } });
  expect(bands.value).toBe("6");
  expect(screen.getByText(/Scene Override · 3/)).toBeTruthy();
  expect((screen.getByLabelText("Shadow Strength") as HTMLInputElement).disabled).toBe(true);
  view.rerender(<SceneFields bands={4} />);
  expect(bands.value).toBe("6");
  fireEvent.click(screen.getByRole("button", { name: "Reset Shadow Bands To Project Settings" }));
  bands = screen.getByLabelText("Shadow Bands") as HTMLInputElement;
  expect(bands.disabled).toBe(true);
  expect(bands.value).toBe("4");
  view.rerender(<SceneFields bands={5} />);
  expect(bands.value).toBe("5");
});
