import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AssetOpenProvider, AssetPickerControl } from "@babylonslate/editor-kit";
import { GraphEditor } from "./graph-editor";

afterEach(cleanup);

it("keeps asset selection on built-in and custom nodes without Open Asset, and retains Inspector opening", () => {
  const openAsset = vi.fn();
  const selectAsset = vi.fn();
  const picker = (id: string) => <div data-testid={id}><AssetPickerControl value="texture">
    <button onClick={selectAsset}>Select Texture</button>
  </AssetPickerControl></div>;
  function CustomNode() { return picker("custom-picker"); }
  render(<AssetOpenProvider value={{ canOpen: () => true, openAsset }}>
    <div data-testid="inspector-picker"><AssetPickerControl value="texture"><button>Inspector Texture</button></AssetPickerControl></div>
    <GraphEditor
      initialGraph={{ nodes: [
        { id: "standard", type: "test.texture", position: { x: 0, y: 0 }, data: { title: "Texture", __pins: [] } },
        { id: "custom", type: "custom", position: { x: 300, y: 0 }, data: {} },
      ], edges: [] }}
      renderNodeBody={() => picker("body-picker")}
      nodeTypes={{ custom: CustomNode }}
    />
  </AssetOpenProvider>);
  for (const id of ["body-picker", "custom-picker"]) {
    const control = within(screen.getByTestId(id));
    expect(control.queryByRole("button", { name: "Open Asset" })).toBeNull();
    fireEvent.click(control.getByRole("button", { name: "Select Texture" }));
  }
  expect(selectAsset).toHaveBeenCalledTimes(2);
  fireEvent.click(within(screen.getByTestId("inspector-picker")).getByRole("button", { name: "Open Asset" }));
  expect(openAsset).toHaveBeenCalledWith("texture");
});
