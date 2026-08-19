import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createDefaultSkyboxCreatorPayload } from "@babylonslate/assets";
import {
  SkyboxCreatorCubemap,
  SkyboxCreatorEditor,
  SkyboxCreatorPreview,
} from "./skybox-creator-editor";

const createAsset = vi.fn();
const deleteAsset = vi.fn();
const refreshAssetRegistry = vi.fn();
const readAssetChunk = vi.fn(async () => Uint8Array.of(1, 2, 3));

vi.mock("../context/document-context", () => ({
  useDocuments: () => ({
    assetRegistry: {
      list: () => [
        {
          header: { guid: "tex-1", name: "Sky", type: "Texture" },
          path: "assets/Sky.babasset",
          rootId: "project",
        },
        {
          header: { guid: "face-px", name: "Day_px", type: "Texture" },
          path: "assets/Old_px.babasset",
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
  }),
}));

vi.mock("@babylonslate/assets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@babylonslate/assets")>();
  return {
    ...actual,
    decodeSourceToRgba: async () => {
      const rgba = new Uint8Array(4 * 3 * 4);
      return { rgba, width: 4, height: 3, clamped: false };
    },
  };
});

vi.mock("@babylonslate/render", () => ({
  encodePngRgba: () => Uint8Array.of(9),
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
});

describe("SkyboxCreatorEditor", () => {
  it("lets the author pick a Texture", async () => {
    const payload = createDefaultSkyboxCreatorPayload();
    const onChange = vi.fn();
    render(
      <SkyboxCreatorEditor
        payload={payload as unknown as Record<string, unknown>}
        helperPath="assets/Day.skyboxcreator.babasset"
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

  it("shows an alert when Create runs without a source Texture", async () => {
    render(
      <SkyboxCreatorEditor
        payload={createDefaultSkyboxCreatorPayload() as unknown as Record<string, unknown>}
        helperPath="assets/Day.skyboxcreator.babasset"
        onChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("skybox-creator-create"));
    await waitFor(() => {
      expect(screen.getByTestId("skybox-creator-alert")).toBeTruthy();
    });
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
        helperPath="assets/Day.skyboxcreator.babasset"
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId("skybox-creator-create"));
    await waitFor(() => {
      expect(createAsset).toHaveBeenCalledTimes(6);
    });
    expect(createAsset.mock.calls.map((call) => call[1])).toEqual([
      "Day_px.babasset",
      "Day_py.babasset",
      "Day_pz.babasset",
      "Day_nx.babasset",
      "Day_ny.babasset",
      "Day_nz.babasset",
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

  it("shows the template net labels and empty state without a Texture", () => {
    render(
      <SkyboxCreatorPreview
        payload={createDefaultSkyboxCreatorPayload() as unknown as Record<string, unknown>}
        onCreate={() => {}}
      />,
    );
    expect(screen.getByTestId("skybox-creator-preview")).toBeTruthy();
    expect(screen.getByTestId("skybox-creator-net")).toBeTruthy();
    expect(screen.getByText("FRONT")).toBeTruthy();
    expect(screen.getByText("BACK")).toBeTruthy();
    expect(screen.getByText("LEFT")).toBeTruthy();
    expect(screen.getByText("RIGHT")).toBeTruthy();
    expect(screen.getByText("UP")).toBeTruthy();
    expect(screen.getByText("DOWN")).toBeTruthy();
    expect(screen.getByTestId("skybox-creator-empty")).toBeTruthy();
    expect(screen.getByTestId("skybox-creator-create")).toBeTruthy();
    expect(screen.queryByTestId("skybox-creator-preview-canvas")).toBeNull();
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
    const net = screen.getByTestId("skybox-creator-net");
    expect(net.style.width).toBe("400px");
    expect(net.style.height).toBe("300px");
    const front = screen.getByText("FRONT").parentElement;
    expect(front?.style.width || getComputedStyle(front!).width).toBeTruthy();
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
    expect(net.style.width).toBe("400px");
    expect(net.style.height).toBe("300px");
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
    );
  });
});

describe("SkyboxCreatorCubemap", () => {
  it("renders the cubemap canvas in an overflow-hidden host without a min-height", async () => {
    render(
      <SkyboxCreatorCubemap
        payload={
          {
            ...createDefaultSkyboxCreatorPayload(),
            sourceTextureGuid: "tex-1",
          } as unknown as Record<string, unknown>
        }
      />,
    );
    const host = screen.getByTestId("skybox-creator-cubemap");
    expect(host.className).toMatch(/overflow-hidden/);
    expect(host.className).toMatch(/min-h-0/);
    const canvas = await screen.findByTestId("skybox-creator-preview-canvas");
    expect(host.contains(canvas)).toBe(true);
    expect(canvas.className).not.toMatch(/min-h-\[160px\]/);
    expect(canvas.className).toMatch(/h-full/);
  });
});
