import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createDefaultSkyboxCreatorPayload } from "@haptic/assets";
import {
  SkyboxCreatorCubemap,
  SkyboxCreatorEditor,
  SkyboxCreatorPreview,
} from "./skybox-creator-editor";

const PNG_MAGIC = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

const createAsset = vi.fn();
const deleteAsset = vi.fn();
const refreshAssetRegistry = vi.fn();
const readAssetChunk = vi.fn(async () => PNG_MAGIC);
const decodeSourceToRgba = vi.hoisted(() =>
  vi.fn(async () => {
    const rgba = new Uint8Array(4 * 3 * 4);
    return { rgba, width: 4, height: 3, clamped: false };
  }),
);

vi.mock("../context/document-context", async () => (await import("../testing/document-context-mock")).documentContextMock(() => ({
  assetRegistry: {
    list: () => [
      {
        header: { guid: "tex-1", name: "Sky", type: "Texture" },
        path: "assets/Sky.hasset",
        rootId: "project",
      },
      {
        header: { guid: "face-px", name: "Day_px", type: "Texture" },
        path: "assets/Old_px.hasset",
        rootId: "project",
      },
    ],
    getRoot: () => ({ id: "project", pathPrefix: "assets" }),
    createAsset,
    deleteAsset,
  },
  openDocuments: [],
  readAssetChunk,
  refreshAssetRegistry,
})));

vi.mock("@haptic/assets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@haptic/assets")>();
  return {
    ...actual,
    decodeSourceToRgba,
  };
});

const encodePngRgba = vi.hoisted(() => vi.fn(() => Uint8Array.of(9)));

vi.mock("@haptic/render", () => ({
  encodePngRgba,
  createMaterialPreviewScene: () => null,
  createMaterialPreviewPresenter: () => null,
  createSkyboxMeshForFaces: () => null,
  ResourceCache: class {},
}));

afterEach(() => {
  cleanup();
  createAsset.mockReset();
  deleteAsset.mockReset();
  refreshAssetRegistry.mockReset();
  readAssetChunk.mockReset();
  readAssetChunk.mockImplementation(async () => PNG_MAGIC);
  decodeSourceToRgba.mockClear();
});

describe("SkyboxCreatorEditor", () => {
  it("lets the author pick a Texture", async () => {
    const payload = createDefaultSkyboxCreatorPayload();
    const onChange = vi.fn();
    render(
      <SkyboxCreatorEditor
        payload={payload as unknown as Record<string, unknown>}
        helperPath="assets/Day.skyboxcreator.hasset"
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId("skybox-creator-editor")).toBeTruthy();
    fireEvent.click(screen.getByTestId("property-source"));
    await waitFor(() => {
      expect(screen.getByTestId("search-item-tex-1")).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId("search-item-tex-1"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceTextureGuid: "tex-1",
        sourcePlacement: null,
      }),
    );
  });

  it("keeps Create unavailable until a source Texture is picked", () => {
    render(
      <SkyboxCreatorEditor
        payload={createDefaultSkyboxCreatorPayload() as unknown as Record<string, unknown>}
        helperPath="assets/Day.skyboxcreator.hasset"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId("skybox-creator-create")).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByTestId("skybox-creator-create"));
    expect(createAsset).not.toHaveBeenCalled();
  });

  it("writes six skybox Textures from the picked source", async () => {
    const payload = {
      ...createDefaultSkyboxCreatorPayload(),
      sourceTextureGuid: "tex-1",
    };
    const onChange = vi.fn();
    render(
      <SkyboxCreatorEditor
        payload={payload as unknown as Record<string, unknown>}
        helperPath="assets/Day.skyboxcreator.hasset"
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId("skybox-creator-create"));
    await waitFor(() => {
      expect(createAsset).toHaveBeenCalledTimes(6);
    });
    expect(createAsset.mock.calls.map((call) => call[1])).toEqual([
      "Day_px.hasset",
      "Day_py.hasset",
      "Day_pz.hasset",
      "Day_nx.hasset",
      "Day_ny.hasset",
      "Day_nz.hasset",
    ]);
    expect(refreshAssetRegistry).toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceTextureGuid: "tex-1",
        generatedFaces: expect.objectContaining({
          px: expect.any(String),
        }),
      }),
    );
    expect(onChange.mock.invocationCallOrder[0]!).toBeLessThan(
      refreshAssetRegistry.mock.invocationCallOrder[0]!,
    );
  });

  it("records the created faces on the document as it is when the writes finish", async () => {
    let releaseRead!: () => void;
    readAssetChunk.mockImplementationOnce(
      () => new Promise<typeof PNG_MAGIC>((resolve) => { releaseRead = () => resolve(PNG_MAGIC); }),
    );
    const payload = (x: number) => ({
      ...createDefaultSkyboxCreatorPayload(),
      sourceTextureGuid: "tex-1",
      sourcePlacement: { x, y: 0, width: 1, height: 1 },
    }) as unknown as Record<string, unknown>;
    const onChange = vi.fn();
    const editor = (x: number) => (
      <SkyboxCreatorEditor payload={payload(x)} helperPath="assets/Day.skyboxcreator.hasset" onChange={onChange} />
    );
    const { rerender } = render(editor(0));
    fireEvent.click(screen.getByTestId("skybox-creator-create"));
    await waitFor(() => expect(readAssetChunk).toHaveBeenCalled());
    rerender(editor(0.25));
    releaseRead();
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({
      sourcePlacement: { x: 0.25, y: 0, width: 1, height: 1 },
      generatedFaces: expect.objectContaining({ px: expect.any(String) }),
    }));
  });

  it("shows the createAsset failure instead of a decode error", async () => {
    createAsset.mockRejectedValueOnce(
      new Error("Asset already exists: assets/Day_px.hasset"),
    );
    render(
      <SkyboxCreatorEditor
        payload={
          {
            ...createDefaultSkyboxCreatorPayload(),
            sourceTextureGuid: "tex-1",
          } as unknown as Record<string, unknown>
        }
        helperPath="assets/Day.skyboxcreator.hasset"
        onChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("skybox-creator-create"));
    await waitFor(() => {
      expect(screen.getByTestId("skybox-creator-alert").textContent).toContain(
        "Asset already exists: assets/Day_px.hasset",
      );
    });
    expect(screen.getByTestId("skybox-creator-alert").textContent).not.toContain(
      "could not be decoded",
    );
  });
});

describe("SkyboxCreatorPreview", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        private readonly callback: ResizeObserverCallback;
        constructor(callback: ResizeObserverCallback) {
          this.callback = callback;
        }
        observe(target: Element) {
          this.callback(
            [{ target } as ResizeObserverEntry],
            this as unknown as ResizeObserver,
          );
        }
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal(
      "PointerEvent",
      class PointerEvent extends MouseEvent {
        pointerId: number;
        pointerType: string;
        constructor(
          type: string,
          init: MouseEventInit & { pointerId?: number; pointerType?: string } = {},
        ) {
          super(type, init);
          this.pointerId = init.pointerId ?? 0;
          this.pointerType = init.pointerType ?? "mouse";
        }
      },
    );
    URL.createObjectURL = vi.fn(() => "blob:skybox-source");
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockRect(element: Element, width: number, height: number) {
    Object.defineProperty(element, "clientWidth", {
      configurable: true,
      value: width,
    });
    Object.defineProperty(element, "clientHeight", {
      configurable: true,
      value: height,
    });
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
      width,
      height,
      toJSON() {
        return {};
      },
    } as DOMRect);
  }

  it("picks the source Texture from the empty Preview", async () => {
    const onChange = vi.fn();
    render(
      <SkyboxCreatorPreview
        payload={createDefaultSkyboxCreatorPayload() as unknown as Record<string, unknown>}
        onCreate={() => {}}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId("skybox-creator-pick-texture"));
    fireEvent.click(await screen.findByTestId("search-item-tex-1"));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ sourceTextureGuid: "tex-1", sourcePlacement: null }),
    );
  });

  it("letterboxes the net to 4 by 3 with square cells in a wide host", () => {
    const { rerender } = render(
      <SkyboxCreatorPreview
        payload={createDefaultSkyboxCreatorPayload() as unknown as Record<string, unknown>}
        onCreate={() => {}}
      />,
    );
    mockRect(screen.getByTestId("skybox-creator-net-host"), 800, 300);
    rerender(
      <SkyboxCreatorPreview
        payload={createDefaultSkyboxCreatorPayload() as unknown as Record<string, unknown>}
        onCreate={() => {}}
      />,
    );
    // 12px stays clear around the fitted net.
    const net = screen.getByTestId("skybox-creator-net");
    expect(net.style.width).toBe("368px");
    expect(net.style.height).toBe("276px");
    const front = screen.getByTestId("skybox-creator-cell-front");
    expect(front.style.width).toBe("");
    expect(front.style.height).toBe("");
  });

  it("letterboxes the net to 4 by 3 with square cells in a tall host", () => {
    const { rerender } = render(
      <SkyboxCreatorPreview
        payload={createDefaultSkyboxCreatorPayload() as unknown as Record<string, unknown>}
        onCreate={() => {}}
      />,
    );
    mockRect(screen.getByTestId("skybox-creator-net-host"), 400, 600);
    rerender(
      <SkyboxCreatorPreview
        payload={createDefaultSkyboxCreatorPayload() as unknown as Record<string, unknown>}
        onCreate={() => {}}
      />,
    );
    const net = screen.getByTestId("skybox-creator-net");
    expect(net.style.width).toBe("376px");
    expect(net.style.height).toBe("282px");
    const front = screen.getByTestId("skybox-creator-cell-front");
    expect(front.style.width).toBe("");
    expect(front.style.height).toBe("");
  });

  it("does not re-decode when assetRegistry.list returns a new row identity", async () => {
    const payload = {
      ...createDefaultSkyboxCreatorPayload(),
      sourceTextureGuid: "tex-1",
      sourcePlacement: { x: 0, y: 0, width: 1, height: 1 },
    };
    const { rerender } = render(
      <SkyboxCreatorPreview
        payload={payload as unknown as Record<string, unknown>}
        onCreate={() => {}}
        onChange={() => {}}
      />,
    );
    await screen.findByTestId("skybox-creator-source");
    await waitFor(() => {
      expect(decodeSourceToRgba.mock.calls.length).toBeGreaterThan(0);
    });
    const callsAfterLoad = decodeSourceToRgba.mock.calls.length;
    rerender(
      <SkyboxCreatorPreview
        payload={payload as unknown as Record<string, unknown>}
        onCreate={() => {}}
        onChange={() => {}}
      />,
    );
    await screen.findByTestId("skybox-creator-source");
    expect(decodeSourceToRgba).toHaveBeenCalledTimes(callsAfterLoad);
  });

  it("shows a source overlay and commits net-space placement on drag", async () => {
    const onChange = vi.fn();
    const payload = {
      ...createDefaultSkyboxCreatorPayload(),
      sourceTextureGuid: "tex-1",
      sourcePlacement: { x: 0, y: 0, width: 1, height: 1 },
    };
    render(
      <SkyboxCreatorPreview
        payload={payload as unknown as Record<string, unknown>}
        onCreate={() => {}}
        onChange={onChange}
      />,
    );
    mockRect(screen.getByTestId("skybox-creator-net-host"), 400, 300);
    mockRect(screen.getByTestId("skybox-creator-net"), 400, 300);
    const source = await screen.findByTestId("skybox-creator-source");
    expect(source.style.left).toBe("0%");
    expect(source.style.width).toBe("100%");
    expect(screen.getByTestId("skybox-creator-source-handle-se")).toBeTruthy();
    const dispatchPointer = (type: string, x: number, y: number) => {
      source.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          pointerId: 1,
          pointerType: "mouse",
        }),
      );
    };
    dispatchPointer("pointerdown", 40, 30);
    dispatchPointer("pointermove", 80, 60);
    dispatchPointer("pointerup", 80, 60);
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        sourcePlacement: expect.objectContaining({
          x: expect.closeTo(0.1, 5),
          y: expect.closeTo(0.1, 5),
          width: 1,
          height: 1,
        }),
      }),
      "skybox-creator-source",
    );
    // Inside the net the image is clipped at full strength; the frame's own copy shows past the net half-transparent.
    expect(source.className.split(" ")).not.toContain("overflow-hidden");
    expect(source.querySelector("img")?.className.split(" ")).toContain("opacity-50");
    const inside = screen.getByTestId("skybox-creator-source-inside");
    expect(inside.className.split(" ")).toContain("overflow-hidden");
    expect(inside.querySelector("img")).toBeTruthy();
    await waitFor(() => {
      expect(URL.createObjectURL).toHaveBeenCalled();
    });
    const blob = (URL.createObjectURL as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as Blob;
    expect(blob.type).toBe("image/png");
    expect(decodeSourceToRgba).toHaveBeenCalledWith(
      PNG_MAGIC,
      16384,
      "image/png",
    );
  });
});

describe("SkyboxCreatorCubemap", () => {
  it("does not re-decode when only sourcePlacement changes", async () => {
    const { rerender } = render(
      <SkyboxCreatorCubemap
        payload={
          {
            ...createDefaultSkyboxCreatorPayload(),
            sourceTextureGuid: "tex-1",
            sourcePlacement: { x: 0, y: 0, width: 1, height: 1 },
          } as unknown as Record<string, unknown>
        }
      />,
    );
    await screen.findByTestId("skybox-creator-preview-canvas");
    await waitFor(() => {
      expect(decodeSourceToRgba.mock.calls.length).toBeGreaterThan(0);
    });
    const callsAfterLoad = decodeSourceToRgba.mock.calls.length;
    rerender(
      <SkyboxCreatorCubemap
        payload={
          {
            ...createDefaultSkyboxCreatorPayload(),
            sourceTextureGuid: "tex-1",
            sourcePlacement: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
          } as unknown as Record<string, unknown>
        }
      />,
    );
    await screen.findByTestId("skybox-creator-preview-canvas");
    expect(decodeSourceToRgba).toHaveBeenCalledTimes(callsAfterLoad);
  });

  it("explains a source Texture that could not be read instead of waiting on the decode", async () => {
    readAssetChunk.mockRejectedValueOnce(new Error("Asset chunk assets/Sky.hasset#pixels could not be read."));
    render(
      <SkyboxCreatorCubemap
        payload={{ ...createDefaultSkyboxCreatorPayload(), sourceTextureGuid: "tex-1" } as unknown as Record<string, unknown>}
      />,
    );
    expect(await screen.findByText("Asset chunk assets/Sky.hasset#pixels could not be read.")).toBeTruthy();
    expect(screen.queryByText("Decoding the Texture…")).toBeNull();
    expect(decodeSourceToRgba).not.toHaveBeenCalled();
  });

  it("explains a source Texture that is no longer in the project", async () => {
    render(
      <SkyboxCreatorCubemap
        payload={{ ...createDefaultSkyboxCreatorPayload(), sourceTextureGuid: "tex-gone" } as unknown as Record<string, unknown>}
      />,
    );
    expect(await screen.findByText("The source Texture is missing.")).toBeTruthy();
    expect(screen.queryByText("Decoding the Texture…")).toBeNull();
    expect(readAssetChunk).not.toHaveBeenCalled();
  });

  it("encodes the six preview faces once after a placement drag settles", async () => {
    const payload = (x: number) => ({
      ...createDefaultSkyboxCreatorPayload(),
      sourceTextureGuid: "tex-1",
      sourcePlacement: { x, y: 0, width: 1, height: 1 },
    }) as unknown as Record<string, unknown>;
    const { rerender } = render(<SkyboxCreatorCubemap payload={payload(0)} />);
    await screen.findByTestId("skybox-creator-preview-canvas");
    encodePngRgba.mockClear();
    vi.useFakeTimers();
    try {
      for (const x of [0.01, 0.02, 0.03]) rerender(<SkyboxCreatorCubemap payload={payload(x)} />);
      expect(encodePngRgba).not.toHaveBeenCalled();
      act(() => { vi.runAllTimers(); });
      expect(encodePngRgba).toHaveBeenCalledTimes(6);
    } finally {
      vi.useRealTimers();
    }
  });
});
