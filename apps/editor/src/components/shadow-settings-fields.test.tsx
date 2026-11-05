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
it("offers an 8192 Directional Map Size only, which makes the project's level Custom", async () => {
  const written: ShadowOverrides[] = [];
  function Fields() {
    const [project, setProject] = useState(() => normalizeShadowSettings({ profile: "ultra" }));
    return <ShadowSettingsFields project={project}
      onChange={(next) => { written.push(next); setProject(normalizeShadowSettings(next)); }} />;
  }
  render(<Fields />);
  const listed = async () => (await screen.findAllByRole("option")).map((option) => option.textContent);
  fireEvent.click(screen.getByLabelText("Directional Map Size"));
  expect(await listed()).toEqual(["256", "512", "1024", "2048", "4096", "8192"]);
  const largest = screen.getByRole("option", { name: "8192" });
  fireEvent.pointerDown(largest);
  fireEvent.click(largest);
  await waitFor(() => expect(written.at(-1)).toMatchObject({ mapSize: 8192, preset: "custom" }));
  expect(normalizeShadowSettings(written.at(-1))).toMatchObject({ profile: "ultra", preset: "custom", mapSize: 8192 });
  expect(screen.getByLabelText("Directional Map Size").textContent).toMatch(/^8192/);
  await waitFor(() => expect(screen.queryAllByRole("option")).toEqual([]));
  fireEvent.click(screen.getByLabelText("Local Shadow Map Size"));
  expect(await listed()).toEqual(["256", "512", "1024", "2048", "4096"]);
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
it("switches Reflection Shadows for the project, which leaves its level Custom, and overrides them for a scene", async () => {
  const written: ShadowOverrides[] = [];
  function ProjectFields() {
    const [project, setProject] = useState(() => normalizeShadowSettings({ profile: "high" }));
    return <ShadowSettingsFields project={project}
      onChange={(next) => { written.push(next); setProject(normalizeShadowSettings(next)); }} />;
  }
  const view = render(<ProjectFields />);
  const toggle = () => screen.getByRole("switch", { name: "Reflection Shadows" });
  // High's own: off.
  expect(toggle().getAttribute("aria-checked")).toBe("false");
  fireEvent.click(toggle());
  await waitFor(() => expect(written.at(-1)).toMatchObject({ reflections: true, preset: "custom" }));
  expect(normalizeShadowSettings(written.at(-1))).toMatchObject({ profile: "high", preset: "custom", reflections: true });
  expect(toggle().getAttribute("aria-checked")).toBe("true");
  view.unmount();
  // A scene shows Ultra's (on) until it overrides it.
  function SceneFields() {
    const [overrides, setOverrides] = useState<ShadowOverrides>({});
    return <ShadowSettingsFields project={normalizeShadowSettings({ profile: "ultra" })} overrides={overrides}
      onChange={(next) => { written.push(next); setOverrides(next); }} />;
  }
  render(<SceneFields />);
  expect(toggle().getAttribute("aria-checked")).toBe("true");
  expect(toggle().hasAttribute("data-disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Override Reflection Shadows" }));
  fireEvent.click(toggle());
  await waitFor(() => expect(written.at(-1)).toEqual({ reflections: false }));
  expect(toggle().getAttribute("aria-checked")).toBe("false");
});
