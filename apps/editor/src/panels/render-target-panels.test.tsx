import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import { RenderTargetDetailsPanel, RenderTargetTextureDetailsPanel } from "./render-target-panels";

const harness = vi.hoisted(() => ({
  content: {} as Record<string, unknown>,
  commit: vi.fn(),
}));
vi.mock("../context/document-workspace-context", () => ({ useDocumentWorkspace: () => ({ documentId: "target" }) }));
vi.mock("../context/document-context", () => ({ useDocuments: () => ({
  openDocuments: [{ id: "target", content: harness.content }], applyAssetDocumentChange: harness.commit,
  assetRegistry: { list: () => [
    { header: { guid: "depth", name: "Depth Capture", type: "RenderTarget" }, path: "assets/depth.rendertarget.babasset" },
    { header: { guid: "image", name: "Image", type: "Texture" }, path: "assets/image.texture.babasset" },
  ] },
}) }));
afterEach(() => { cleanup(); harness.commit.mockReset(); harness.content = {}; });

it("saves the selected engine render mode while retaining the resolution", async () => {
  harness.content = { mode: "SceneColor", width: 640, height: 320 };
  render(<RenderTargetDetailsPanel {...({} as IDockviewPanelProps)} />);
  fireEvent.click(screen.getByTestId("property-render-target-mode"));
  const option = await screen.findByRole("option", { name: "Depth Pass" });
  fireEvent.pointerDown(option, { pointerType: "mouse" });
  fireEvent.click(option);
  await waitFor(() => expect(harness.commit).toHaveBeenLastCalledWith("target", { mode: "DepthPass", width: 640, height: 320 }));
});

it("links a Render Target Texture to a target and excludes image assets", async () => {
  render(<RenderTargetTextureDetailsPanel {...({} as IDockviewPanelProps)} />);
  fireEvent.click(screen.getByTestId("property-render-target-texture-target"));
  expect(await screen.findByRole("option", { name: /Depth Capture/ })).toBeTruthy();
  expect(screen.queryByRole("option", { name: /Image/ })).toBeNull();
  fireEvent.click(screen.getByRole("option", { name: /Depth Capture/ }));
  expect(harness.commit).toHaveBeenLastCalledWith("target", { renderTargetGuid: "depth" });
});
