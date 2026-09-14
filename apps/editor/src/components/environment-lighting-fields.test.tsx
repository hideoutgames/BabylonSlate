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
  normalizeEnvironmentLightingSettings,
  type EnvironmentLightingOverrides,
} from "@babylonslate/core";
import { EnvironmentLightingFields } from "./environment-lighting-fields";

if (typeof window.PointerEvent === "undefined")
  window.PointerEvent = MouseEvent as unknown as typeof PointerEvent;
afterEach(cleanup);

function SceneFields({ intensity = 2 }: { intensity?: number }) {
  const [overrides, setOverrides] = useState<EnvironmentLightingOverrides>({
    intensity: 3,
    rotationYDegrees: 90,
    celStrength: 0.4,
  });
  return (
    <EnvironmentLightingFields
      project={normalizeEnvironmentLightingSettings({ intensity })}
      overrides={overrides}
      onChange={setOverrides}
      cel
    >
      <button>Environment Texture</button>
    </EnvironmentLightingFields>
  );
}

it("retains independent authored values while disabled and resets intensity to live project inheritance", async () => {
  const view = render(<SceneFields />);
  fireEvent.click(
    screen.getByRole("button", { name: "Override Image-Based Lighting" }),
  );
  fireEvent.click(screen.getByRole("switch", { name: "Image-Based Lighting" }));
  await waitFor(() =>
    expect(screen.queryByLabelText("Environment Intensity")).toBeNull(),
  );
  expect(screen.queryByLabelText("Environment Rotation")).toBeNull();
  expect(screen.queryByLabelText("CEL Environment Strength")).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Environment Texture" }),
  ).toBeNull();
  view.rerender(<SceneFields intensity={5} />);
  fireEvent.click(
    screen.getByRole("button", { name: "Reset Image-Based Lighting" }),
  );
  await waitFor(() =>
    expect(screen.getByLabelText("Environment Intensity")).toHaveProperty(
      "value",
      "3",
    ),
  );
  expect(screen.getByLabelText("Environment Rotation")).toHaveProperty(
    "value",
    "90",
  );
  expect(screen.getByLabelText("CEL Environment Strength")).toHaveProperty(
    "value",
    "0.4",
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Reset Environment Intensity" }),
  );
  expect(screen.getByLabelText("Environment Intensity")).toHaveProperty(
    "disabled",
    true,
  );
  expect(screen.getByLabelText("Environment Intensity")).toHaveProperty(
    "value",
    "5",
  );
  view.rerender(<SceneFields intensity={6} />);
  expect(screen.getByLabelText("Environment Intensity")).toHaveProperty(
    "value",
    "6",
  );
  expect(screen.getByLabelText("Environment Rotation")).toHaveProperty(
    "value",
    "90",
  );
});

it("keeps CEL contribution controls absent from PBR project settings", () => {
  render(<EnvironmentLightingFields onChange={() => undefined} />);
  expect(screen.queryByLabelText("CEL Environment Strength")).toBeNull();
  expect(screen.getByLabelText("Environment Intensity")).toHaveProperty(
    "value",
    "1",
  );
});
