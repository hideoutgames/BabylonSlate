import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  applyProjectQualityPatch,
  DEFAULT_RENDER_PROJECT_SETTINGS,
  normalizeProjectSettings,
  normalizeShadowSettings,
  qualityPresetPatch,
} from "@babylonslate/core";
import { RenderQualityFields } from "./render-quality-fields";
import { ShadowSettingsFields } from "./shadow-settings-fields";

if (typeof window.PointerEvent === "undefined")
  window.PointerEvent = MouseEvent as unknown as typeof PointerEvent;
afterEach(cleanup);

function Fields() {
  const [settings, setSettings] = useState(() =>
    applyProjectQualityPatch(
      DEFAULT_RENDER_PROJECT_SETTINGS,
      qualityPresetPatch("high"),
    ),
  );
  const save: typeof setSettings = (next) =>
    setSettings(
      (previous) =>
        normalizeProjectSettings(
          JSON.parse(
            JSON.stringify({
              render: typeof next === "function" ? next(previous) : next,
            }),
          ),
        ).render,
    );
  return (
    <>
      <RenderQualityFields settings={settings} onChange={save} />
      <ShadowSettingsFields
        project={settings.shadows}
        onChange={(shadows) =>
          save({ ...settings, shadows: normalizeShadowSettings(shadows) })
        }
      />
    </>
  );
}
async function select(label: string, option: string) {
  fireEvent.click(screen.getByLabelText(label));
  const item = await screen.findByRole("option", { name: option });
  fireEvent.pointerDown(item);
  fireEvent.click(item);
  await waitFor(() => expect(selected(label)).toBe(option));
}
function selected(label: string) {
  return screen
    .getByLabelText(label)
    .querySelector('[data-slot="select-value"]')?.textContent;
}

it("applies the local shadow count with each preset and makes its category Custom after an edit", async () => {
  render(<Fields />);
  await select("Local Shadow Budget Mode", "Manual");
  fireEvent.change(screen.getByLabelText("Local Shadow Light Budget"), {
    target: { value: "16" },
  });
  expect(selected("Shadows Quality")).toBe("Custom");
  expect(selected("Overall Quality")).toBe("Custom");
  await select("Overall Quality", "Low");
  expect(selected("Local Shadow Budget Mode")).toBe("Auto");
  expect(
    screen.getByText(/Current Auto Budget: 1 local shadow lights/),
  ).toBeTruthy();
  await select("Local Shadow Budget Mode", "Manual");
  expect(screen.getByLabelText("Local Shadow Light Budget")).toHaveProperty(
    "value",
    "1",
  );
  await select("Shadows Quality", "Medium");
  expect(
    screen.getByText(/Current Auto Budget: 2 local shadow lights/),
  ).toBeTruthy();
  expect(selected("Textures Quality")).toBe("Low");
});

it("keeps a manually matched tier Custom through saved normalization until explicitly reapplied", async () => {
  render(<Fields />);
  fireEvent.change(screen.getByLabelText("Texture Anisotropy"), {
    target: { value: "16" },
  });
  fireEvent.change(screen.getByLabelText("Texture Budget (MiB)"), {
    target: { value: "2048" },
  });
  expect(selected("Textures Quality")).toBe("Custom");
  expect(selected("Shadows Quality")).toBe("High");
  await select("Textures Quality", "Ultra");
  expect(screen.getByLabelText("Texture Anisotropy")).toHaveProperty(
    "value",
    "16",
  );
  fireEvent.change(screen.getByLabelText("Post Processing Resolution Scale"), {
    target: { value: "0.8" },
  });
  expect(selected("Post Processing Quality")).toBe("Custom");
  expect(selected("Textures Quality")).toBe("Ultra");
});

it("separates local illumination cost from shadow budgeting", async () => {
  render(<Fields />);
  await select("Lighting Quality", "Low");
  await select("Local Light Budget Mode", "Manual");
  fireEvent.change(screen.getByLabelText("Local Light Budget"), {
    target: { value: "32" },
  });
  expect(selected("Lighting Quality")).toBe("Custom");
  expect(screen.getByText(/4 local lights requested/)).toBeTruthy();
  expect(selected("Shadows Quality")).toBe("High");
  await select("Lighting Quality", "Medium");
  expect(screen.getByText(/16 local lights requested/)).toBeTruthy();
});
