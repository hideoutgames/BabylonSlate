import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createDefaultMaterialDocument, newCustomGlslProperties } from "@babylonslate/shader-graph";
import { MaterialCustomGlsl } from "./material-custom-glsl";

afterEach(cleanup);

describe("Custom GLSL sampler editor", () => {
  it("offers Texture for inputs and keeps output types numeric", async () => {
    function Host() {
      const [properties, setProperties] = useState(newCustomGlslProperties());
      return <MaterialCustomGlsl document={createDefaultMaterialDocument()} node={{ id: "custom", type: "custom.glsl", position: { x: 0, y: 0 }, properties }} setProperties={(patch) => setProperties((previous) => ({ ...previous, ...patch }))} />;
    }
    render(<Host />);
    fireEvent.click(screen.getByTestId("custom-glsl-input-a-type"));
    fireEvent.click(await screen.findByTestId("search-item-texture"));
    expect(screen.getByTestId("custom-glsl-input-a-type").textContent).toContain("Texture");
    fireEvent.change(screen.getByTestId("custom-glsl-output-add-name"), { target: { value: "Mask" } });
    fireEvent.click(screen.getByTestId("custom-glsl-output-add"));
    const outputs = screen.getAllByTestId("pin-list-editor")[1]!;
    fireEvent.click(outputs.querySelector('[aria-label="Pin type"]')!);
    await screen.findByTestId("search-item-float");
    expect(screen.queryByTestId("search-item-texture")).toBeNull();
  });
});
