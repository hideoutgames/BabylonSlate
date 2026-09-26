import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AreaEmissionProgress } from "@babylonslate/assets";
import { TextureDetails, TexturePreview } from "./texture-editor";

if (typeof window !== "undefined" && typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init?: MouseEventInit) {
      super(type, init);
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

const retryTextureEncoding = vi.hoisted(() => vi.fn(async () => true));
const prepareAreaEmission = vi.hoisted(() => vi.fn(async (_guid: string, options: { signal: AbortSignal; onProgress: (value: AreaEmissionProgress) => void }) => {
  options.onProgress({ phase: "filtering", progress: 0.5 });
  await new Promise<void>((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
}));
const readAssetChunk = vi.hoisted(() => vi.fn(async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47])));

vi.mock("../context/document-context", () => ({
  useDocuments: () => ({
    prepareAreaEmission,
    retryTextureEncoding,
    readAssetChunk,
    assetRegistry: { getByGuid: () => undefined },
  }),
}));

const ENVIRONMENT = { usage: "skybox", dimension: "cube", container: "dds", encoding: "linearFloat32", width: 2, height: 2, mipLevels: 2, prefiltered: true };

afterEach(() => {
  cleanup();
  retryTextureEncoding.mockClear();
  prepareAreaEmission.mockClear();
  readAssetChunk.mockClear();
});

describe("Texture editor", () => {
  it("shows cancellable emission preparation progress without editing the authored Texture", async () => {
    const onChange = vi.fn();
    render(<TextureDetails guid="tex-albedo" dependencies={[]} payload={{ usage: "albedo" }} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Prepare Emission" }));
    expect(await screen.findByText("Filtering 50%")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Prepare Emission" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(await screen.findByText("Not Prepared")).toBeTruthy();
    expect(prepareAreaEmission.mock.calls[0]?.[1].signal.aborted).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("presents cube metadata without exposing 2D downsampling or compression", () => {
    render(<TextureDetails guid="env" dependencies={[]} payload={ENVIRONMENT} onChange={vi.fn()} />);
    expect(screen.getAllByText("Environment Cube").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Encoding")).toHaveProperty("value", "Linear RGBA32F");
    expect(screen.getByLabelText("Roughness Mip Levels")).toHaveProperty("value", "2");
    expect(screen.queryByLabelText("Usage")).toBeNull();
    expect(screen.queryByLabelText("Downsample")).toBeNull();
  });

  it("does not decode 2D pixels for an environment cube preview", () => {
    render(<TexturePreview path="assets/environment.babasset" payload={ENVIRONMENT} />);
    expect(screen.getByText("Environment Cube")).toBeTruthy();
    expect(screen.queryByTestId("texture-preview-image")).toBeNull();
    expect(readAssetChunk).not.toHaveBeenCalled();
  });

  it("offers Usage and Downsample without extra filter toggles", () => {
    render(<TextureDetails guid="tex-albedo" dependencies={[]} payload={{ usage: "albedo" }} onChange={vi.fn()} />);
    expect(screen.getByTestId("property-downsample")).toBeTruthy();
    expect(screen.getByTestId("property-usage")).toBeTruthy();
    expect(screen.queryByTestId("property-mipmap")).toBeNull();
    expect(screen.queryByTestId("property-nearest")).toBeNull();
  });

  it("surfaces the latest encode error and retries encoding on request", () => {
    render(
      <TextureDetails
        guid="tex-albedo"
        dependencies={[]}
        payload={{ usage: "albedo", compressionState: "encode_failed", encodeError: "BasisEncoder.encode returned 0" }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId("texture-encode-error").textContent).toContain("BasisEncoder.encode returned 0");
    fireEvent.click(screen.getByTestId("texture-retry-encode"));
    expect(retryTextureEncoding).toHaveBeenCalledWith("tex-albedo", { force: true, usage: "albedo" });
  });

  it("offers no Retry Encoding once the Usage stays uncompressed", () => {
    render(
      <TextureDetails
        guid="tex-albedo"
        dependencies={[]}
        payload={{ usage: "pixelArt", compressionState: "encode_failed", encodeError: "BasisEncoder.encode returned 0" }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("texture-retry-encode")).toBeNull();
  });

  it("re-encodes with the new Usage when a Texture becomes Particle", () => {
    const onChange = vi.fn();
    render(<TextureDetails guid="tex-spark" dependencies={[]} payload={{ usage: "albedo", compressionState: "compressed" }} onChange={onChange} />);
    fireEvent.click(screen.getByRole("combobox", { name: "Usage" }));
    const particle = screen.getByRole("option", { name: "Particle" });
    fireEvent.pointerDown(particle);
    fireEvent.click(particle);
    expect(onChange).toHaveBeenCalledWith({ usage: "particle", compressionState: "compressed" });
    // The saved header still has the old Usage until the document saves.
    expect(retryTextureEncoding).toHaveBeenCalledWith("tex-spark", { force: true, usage: "particle" });
  });

  it("keeps Pixel Art Textures free of compression quality", () => {
    render(<TextureDetails guid="tex-sprite" dependencies={[]} payload={{ usage: "pixelArt", compressionState: "none" }} onChange={vi.fn()} />);
    expect(screen.getByTestId("property-usage")).toBeTruthy();
    expect(screen.getByTestId("property-downsample")).toBeTruthy();
    expect(screen.queryByTestId("property-compressionQuality")).toBeNull();
  });

  it("previews the decoded pixels", async () => {
    render(<TexturePreview path="assets/albedo.babasset" payload={{ usage: "albedo", sourceWidth: 64, sourceHeight: 32 }} />);
    expect(await screen.findByTestId("texture-preview-image")).toBeTruthy();
    expect(screen.getByTestId("texture-preview-size").textContent).toBe("64 × 32");
    expect(readAssetChunk).toHaveBeenCalledWith("assets/albedo.babasset", "pixels");
  });

  it("explains a Texture without decoded pixels", async () => {
    readAssetChunk.mockResolvedValueOnce(new Uint8Array());
    render(<TexturePreview path="assets/empty.babasset" payload={{ usage: "albedo" }} />);
    expect(await screen.findByText("No Image Data")).toBeTruthy();
  });
});
