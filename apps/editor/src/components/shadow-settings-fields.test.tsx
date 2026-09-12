import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { normalizeShadowSettings, type ShadowOverrides } from "@babylonslate/core";
import { ShadowSettingsFields } from "./shadow-settings-fields";
afterEach(cleanup);

function SceneFields({ distance = 200 }: { distance?: number }) {
  const [overrides, setOverrides] = useState<ShadowOverrides>({});
  return <ShadowSettingsFields project={normalizeShadowSettings({ distance })} overrides={overrides} onChange={setOverrides} />;
}
it("keeps independent scene overrides and resets to live project shadow distance", () => {
  const view = render(<SceneFields />);
  const distance = () => screen.getByLabelText("Shadow Distance") as HTMLInputElement;
  expect(distance().disabled).toBe(true);
  expect(distance().value).toBe("200");
  fireEvent.click(screen.getByRole("button", { name: "Override Shadow Distance" }));
  fireEvent.change(distance(), { target: { value: "75" } });
  fireEvent.blur(distance());
  view.rerender(<SceneFields distance={350} />);
  expect(distance().value).toBe("75");
  expect((screen.getByLabelText("Shadow Normal Bias") as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Reset Shadow Distance" }));
  expect(distance().disabled).toBe(true);
  expect(distance().value).toBe("350");
});
