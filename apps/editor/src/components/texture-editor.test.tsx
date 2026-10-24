import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { IDockviewPanelProps } from "dockview-react";
import { AssetRegistry, projectContentRoot, type AreaEmissionProgress } from "@haptic/assets";
import { MemoryStorageAdapter } from "@haptic/vfs";
import { DocumentWorkspaceProvider } from "../context/document-workspace-context";
import { TextureDetails, TextureDetailsPanel, TexturePreview } from "./texture-editor";

if (typeof window !== "undefined" && typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    constructor(type: string, init?: MouseEventInit) {
      super(type, init);
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

const ENVIRONMENT = vi.hoisted(() => ({ usage: "skybox", dimension: "cube", container: "dds", encoding: "linearFloat32", width: 2, height: 2, mipLevels: 2, prefiltered: true }));

/** The Textures whose encode runs now, which only the editor's memory knows. */
const running = vi.hoisted(() => ({ guids: new Set<string>() }));
const retryTextureEncoding = vi.hoisted(() => vi.fn(async () => true));
const textureAlignmentStale = vi.hoisted(() => vi.fn<(guid: string, usage?: string) => Promise<boolean>>(async () => false));
const textureUsageBlockedReason = vi.hoisted(() => vi.fn<(guid: string) => string | null>(() => null));
const prepareAreaEmission = vi.hoisted(() => vi.fn(async (_guid: string, options: { signal: AbortSignal; onProgress: (value: AreaEmissionProgress) => void }) => {
  options.onProgress({ phase: "filtering", progress: 0.5 });
  await new Promise<void>((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
}));
const reconvertHdrEnvironment = vi.hoisted(() => vi.fn(async (_guid: string, _faceSize: number, options: { signal: AbortSignal; onProgress: (fraction: number) => void }) => {
  options.onProgress(0.4);
  return new Promise<boolean>((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
}));
const readAssetChunk = vi.hoisted(() => vi.fn(async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47])));
let assetRegistry: AssetRegistry;

beforeAll(async () => {
  const storage = new MemoryStorageAdapter("documents");
  await storage.openDocumentsProject("texture-details.hproject");
  assetRegistry = new AssetRegistry(storage);
  await assetRegistry.mountRoot(projectContentRoot());
  for (const guid of ["tex-other", "tex-active"]) {
    await assetRegistry.createAsset("project", `${guid}.hasset`, {
      guid, type: "Texture", name: guid, version: 1,
      dependencies: [], payload: {}, chunks: [],
    });
  }
  await assetRegistry.createAsset("project", "env-hdr.hasset", {
    guid: "env-hdr", type: "Texture", name: "env-hdr", version: 1, dependencies: [],
    payload: { ...ENVIRONMENT, hdrFaceSize: 256 },
    chunks: [
      { id: "source", kind: "source", mime: "image/vnd-ms.dds", data: new Uint8Array([0x44, 0x44, 0x53, 0x20]) },
      { id: "hdr", kind: "hdr", mime: "image/vnd.radiance", data: new Uint8Array([0x23, 0x3f]) },
    ],
  });
});

vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({
  prepareAreaEmission,
  reconvertHdrEnvironment,
  retryTextureEncoding,
  textureAlignmentStale,
  textureUsageBlockedReason,
  readAssetChunk,
  assetRegistry,
  registryEpoch: 0,
  encodingTextures: running.guids,
  openDocuments: [
    { id: "other", ref: { path: "assets/tex-other.hasset" }, content: {} },
    {
      id: "active",
      ref: { path: "assets/tex-active.hasset" },
      content: { usage: "albedo", compressionState: "encode_failed", encodeError: "Encoding failed" },
    },
  ],
})));


afterEach(() => {
  cleanup();
  running.guids.clear();
  retryTextureEncoding.mockClear();
  textureAlignmentStale.mockReset();
  textureAlignmentStale.mockResolvedValue(false);
  textureUsageBlockedReason.mockReset();
  textureUsageBlockedReason.mockReturnValue(null);
  prepareAreaEmission.mockClear();
  reconvertHdrEnvironment.mockClear();
  readAssetChunk.mockClear();
});

describe("Texture editor", () => {
  it("retries encoding for the asset at the active document path", () => {
    render(
      <DocumentWorkspaceProvider documentId="active">
        <TextureDetailsPanel {...({} as IDockviewPanelProps)} />
      </DocumentWorkspaceProvider>,
    );
    fireEvent.click(screen.getByTestId("texture-retry-encode"));
    expect(retryTextureEncoding).toHaveBeenCalledWith("tex-active", { force: true, usage: "albedo" });
  });

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

  it("converts a kept HDR panorama again at a new Face Size behind a cancelable progress dialog", async () => {
    const onChange = vi.fn();
    render(<TextureDetails guid="env-hdr" dependencies={[]} payload={{ ...ENVIRONMENT, hdrFaceSize: 256 }} onChange={onChange} />);
    // Converted at 2 × 2 under a 256 setting: the panorama's width capped it.
    expect(screen.getByText(/faces are at most about a quarter of the panorama's width/)).toBeTruthy();
    fireEvent.click(screen.getByRole("combobox", { name: "Face Size" }));
    const large = screen.getByRole("option", { name: "512 × 512" });
    fireEvent.pointerDown(large);
    fireEvent.click(large);

    await screen.findByTestId("importing-overlay");
    expect(reconvertHdrEnvironment).toHaveBeenCalledWith("env-hdr", 512, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(screen.getByText("Converting")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("importing-count").textContent).toBe("40%"));
    fireEvent.click(screen.getByTestId("importing-cancel"));
    await waitFor(() => expect(screen.queryByTestId("importing-overlay")).toBeNull());
    expect(reconvertHdrEnvironment.mock.calls[0]?.[2].signal.aborted).toBe(true);
    // The setting lives in the file, not the document; a cancel is no failure.
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByTestId("texture-hdr-error")).toBeNull();
  });

  it("shows Face Size read-only for a cube with no kept HDR panorama", () => {
    render(<TextureDetails guid="env" dependencies={[]} payload={ENVIRONMENT} onChange={vi.fn()} />);
    expect(screen.getByLabelText("Face Size")).toHaveProperty("value", "2 × 2");
    expect(screen.queryByRole("combobox", { name: "Face Size" })).toBeNull();
  });

  it("does not decode 2D pixels for an environment cube preview", () => {
    render(<TexturePreview path="assets/environment.hasset" payload={ENVIRONMENT} />);
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

  it("shows Encoding, not the last failure or Retry Encoding, while the Texture's encode runs", () => {
    const payload = { usage: "albedo", compressionState: "encode_failed", encodeError: "BasisEncoder.encode returned 0" };
    const { rerender } = render(<TextureDetails guid="tex-albedo" dependencies={[]} payload={payload} onChange={vi.fn()} />);
    expect(screen.getByTestId("texture-compression-state").textContent).toBe("Failed");
    expect(screen.getByTestId("texture-retry-encode")).toBeTruthy();

    running.guids.add("tex-albedo");
    rerender(<TextureDetails guid="tex-albedo" dependencies={[]} payload={{ ...payload }} onChange={vi.fn()} />);
    expect(screen.getByTestId("texture-compression-state").textContent).toBe("Encoding");
    expect(screen.queryByTestId("texture-encode-error")).toBeNull();
    expect(screen.queryByTestId("texture-retry-encode")).toBeNull();
  });

  it.each([true, false])("offers Retry Encoding for a compressed Texture only while its encode breaks the size rule (stale=%s)", async (stale) => {
    textureAlignmentStale.mockResolvedValue(stale);
    render(<TextureDetails guid="tex-odd" dependencies={[]} payload={{ usage: "normal", compressionState: "compressed" }} onChange={vi.fn()} />);
    // Checked with the tab's Usage, which may be an unsaved Details edit.
    await waitFor(() => expect(textureAlignmentStale).toHaveBeenCalledWith("tex-odd", "normal"));
    if (!stale) {
      await act(async () => {});
      expect(screen.queryByTestId("texture-retry-encode")).toBeNull();
      return;
    }
    fireEvent.click(await screen.findByTestId("texture-retry-encode"));
    expect(retryTextureEncoding).toHaveBeenCalledWith("tex-odd", { force: true, usage: "normal" });
  });

  it("explains a re-encode that could not start", async () => {
    retryTextureEncoding.mockRejectedValueOnce(new Error("Read-only during Simulation Play"));
    render(
      <TextureDetails
        guid="tex-albedo"
        dependencies={[]}
        payload={{ usage: "albedo", compressionState: "encode_failed" }}
        onChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("texture-retry-encode"));
    expect((await screen.findByTestId("texture-requeue-error")).textContent).toContain("Read-only during Simulation Play");
  });

  it("re-encodes and prepares nothing while another user's lock keeps the Texture read-only", async () => {
    textureUsageBlockedReason.mockReturnValue("The Texture is locked by Bob.");
    textureAlignmentStale.mockResolvedValue(true);
    const onChange = vi.fn();
    render(<TextureDetails guid="tex-locked" dependencies={[]} payload={{ usage: "albedo", compressionState: "compressed" }} onChange={onChange} />);
    const retry = await screen.findByTestId("texture-retry-encode");
    expect(retry).toHaveProperty("disabled", true);
    fireEvent.click(retry);
    // Emission preparation stores derived chunks in the same file.
    const prepare = screen.getByRole("button", { name: "Prepare Emission" });
    expect(prepare).toHaveProperty("disabled", true);
    fireEvent.click(prepare);
    expect(prepareAreaEmission).not.toHaveBeenCalled();
    // A Details change the read-only tab refuses must not re-encode the file either.
    fireEvent.click(screen.getByRole("combobox", { name: "Usage" }));
    const particle = screen.getByRole("option", { name: "Particle" });
    fireEvent.pointerDown(particle);
    fireEvent.click(particle);
    expect(onChange).toHaveBeenCalledWith({ usage: "particle", compressionState: "compressed" });
    expect(retryTextureEncoding).not.toHaveBeenCalled();
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
    render(<TexturePreview path="assets/albedo.hasset" payload={{ usage: "albedo", sourceWidth: 64, sourceHeight: 32 }} />);
    expect(await screen.findByTestId("texture-preview-image")).toBeTruthy();
    expect(screen.getByTestId("texture-preview-size").textContent).toBe("64 × 32");
    expect(readAssetChunk).toHaveBeenCalledWith("assets/albedo.hasset", "pixels");
  });

  it("zooms the preview on the wheel and returns to the fitted view from Fit", async () => {
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(232);
    const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(232);
    try {
      render(<TexturePreview path="assets/albedo.hasset" payload={{ usage: "albedo", sourceWidth: 100, sourceHeight: 100 }} />);
      await screen.findByTestId("texture-preview-image");
      const zoom = () => screen.getByTestId("texture-preview-zoom").textContent;
      await waitFor(() => expect(zoom()).toBe("200%"));
      fireEvent.wheel(screen.getByTestId("texture-preview-surface"), { deltaY: -200, clientX: 10, clientY: 10 });
      expect(zoom()).not.toBe("200%");
      expect(screen.getByTestId("texture-zoom-fit").getAttribute("aria-pressed")).toBe("false");
      fireEvent.click(screen.getByTestId("texture-zoom-fit"));
      expect(zoom()).toBe("200%");
      expect(screen.getByTestId("texture-zoom-fit").getAttribute("aria-pressed")).toBe("true");
    } finally {
      width.mockRestore();
      height.mockRestore();
    }
  });

  it("explains a Texture without decoded pixels", async () => {
    readAssetChunk.mockResolvedValueOnce(new Uint8Array());
    render(<TexturePreview path="assets/empty.hasset" payload={{ usage: "albedo" }} />);
    expect(await screen.findByText("No Image Data")).toBeTruthy();
  });

  it("reports a failed pixel read and previews the pixels on Retry", async () => {
    readAssetChunk.mockRejectedValueOnce(new Error("Asset chunk changed during 3 read attempts"));
    render(<TexturePreview path="assets/albedo.hasset" payload={{ usage: "albedo" }} />);
    expect(await screen.findByText("Texture Preview Failed")).toBeTruthy();
    expect(screen.getByText("Asset chunk changed during 3 read attempts")).toBeTruthy();
    expect(screen.queryByText("Loading Preview…")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByTestId("texture-preview-image")).toBeTruthy();
    expect(readAssetChunk).toHaveBeenCalledTimes(2);
  });
});
