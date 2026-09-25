import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { PropertyGrid } from "@babylonslate/editor-kit";
import { componentPropertyRows } from "./component-property-rows";

afterEach(cleanup);

function BuoyancyDetails() {
  const [properties, setProperties] = useState<Record<string, unknown>>({ volume: 0.002 });
  return <PropertyGrid rows={componentPropertyRows("float", {
    id: "buoyancy", classId: "WaterBuoyancyComponent", properties,
  }, (key, value) => setProperties((previous) => ({ ...previous, [key]: value })), {
    sortingLayers: [], assetLabel: () => undefined, onPickAsset: () => {},
  })} />;
}

it("keeps small displacement values visible through edits and resets Volume to automatic", () => {
  render(<BuoyancyDetails />);
  const volume = screen.getByRole("textbox", { name: "Volume" }) as HTMLInputElement;
  expect(volume.value).toBe("0.002");
  fireEvent.change(volume, { target: { value: "0.00025" } });
  fireEvent.blur(volume);
  expect(volume.value).toBe("0.00025");
  fireEvent.change(volume, { target: { value: "*2" } });
  fireEvent.blur(volume);
  expect(volume.value).toBe("0.0005");
  fireEvent.click(screen.getByRole("button", { name: "Reset Volume" }));
  expect(volume.value).toBe("0");
});
