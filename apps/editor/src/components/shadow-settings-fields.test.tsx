import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  normalizeShadowSettings,
  type ShadowOverrides,
} from "@haptic/core";
import { ShadowSettingsFields } from "./shadow-settings-fields";

// Base UI dispatches PointerEvent when activating its native switch input.
if (typeof window.PointerEvent === "undefined") {
  window.PointerEvent = MouseEvent as unknown as typeof PointerEvent;
}

afterEach(cleanup);

function SceneFields({ distance = 200 }: { distance?: number }) {
  const [overrides, setOverrides] = useState<ShadowOverrides>({});
  return (
    <ShadowSettingsFields
      project={normalizeShadowSettings({ distance })}
      overrides={overrides}
      onChange={setOverrides}
    />
  );
}

function BudgetFields() {
  const [overrides, setOverrides] = useState<ShadowOverrides>({ maxLocalLights: 16, localLightMode: "manual" });
  return <ShadowSettingsFields project={normalizeShadowSettings({ localLightMode: "auto" })} overrides={overrides} onChange={setOverrides} />;
}

it("preserves the manual count across Auto, reset and shadow disablement", async () => {
  render(<BudgetFields />);
  const count = () => screen.queryByLabelText("Local Shadow Light Budget");
  await waitFor(() => expect(count()).toHaveProperty("value", "16"));
  fireEvent.click(screen.getByLabelText("Local Shadow Budget Mode"));
  const automatic = await screen.findByRole("option", { name: "Auto" });
  fireEvent.pointerDown(automatic);
  fireEvent.click(automatic);
  await waitFor(() => expect(count()).toBeNull());
  fireEvent.click(screen.getByLabelText("Local Shadow Budget Mode"));
  const manual = await screen.findByRole("option", { name: "Manual" });
  fireEvent.pointerDown(manual);
  fireEvent.click(manual);
  await waitFor(() => expect(count()).toHaveProperty("value", "16"));
  fireEvent.click(screen.getByRole("button", { name: "Override Shadows Enabled" }));
  fireEvent.click(screen.getByRole("switch", { name: "Shadows Enabled" }));
  await waitFor(() => expect(count()).toBeNull());
  expect(screen.queryByLabelText("Local Shadow Budget Mode")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Reset Shadows Enabled" }));
  await waitFor(() => expect(count()).toHaveProperty("value", "16"));
  fireEvent.click(screen.getByRole("button", { name: "Reset Local Shadow Budget Mode" }));
  await waitFor(() => expect(count()).toBeNull());
  expect(screen.getByLabelText("Local Shadow Budget Mode")).toHaveProperty("disabled", true);
});
it("keeps independent scene overrides and resets to live project shadow distance", () => {
  const view = render(<SceneFields />);
  const distance = () =>
    screen.getByLabelText("Shadow Distance") as HTMLInputElement;
  expect(distance().disabled).toBe(true);
  expect(distance().value).toBe("200");
  fireEvent.click(
    screen.getByRole("button", { name: "Override Shadow Distance" }),
  );
  fireEvent.change(distance(), { target: { value: "75" } });
  fireEvent.blur(distance());
  view.rerender(<SceneFields distance={350} />);
  expect(distance().value).toBe("75");
  expect(
    (screen.getByLabelText("Shadow Normal Bias") as HTMLInputElement).disabled,
  ).toBe(true);
  fireEvent.click(
    screen.getByRole("button", { name: "Reset Shadow Distance" }),
  );
  expect(distance().disabled).toBe(true);
  expect(distance().value).toBe("350");
});
it("overrides Screen-Space Shadows for a scene and shows the project level", async () => {
  const written: ShadowOverrides[] = [];
  function Fields() {
    const [overrides, setOverrides] = useState<ShadowOverrides>({});
    return <ShadowSettingsFields project={normalizeShadowSettings({ profile: "high" })} overrides={overrides}
      onChange={(next) => { written.push(next); setOverrides(next); }} />;
  }
  render(<Fields />);
  const field = () => screen.getByLabelText("Screen-Space Shadows");
  expect(field().textContent).toMatch(/^Medium/);
  expect(field()).toHaveProperty("disabled", true);
  fireEvent.click(screen.getByRole("button", { name: "Override Screen-Space Shadows" }));
  fireEvent.click(field());
  const off = await screen.findByRole("option", { name: "Off" });
  fireEvent.pointerDown(off);
  fireEvent.click(off);
  await waitFor(() => expect(written.at(-1)).toMatchObject({ screenShadows: "off" }));
  expect(field().textContent).toMatch(/^Off/);
});
