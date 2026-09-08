import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareProjectPicture } from "./homepage-project-appearance";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Project Picture Import", () => {
  it("rejects unsupported and oversized input before decoding", async () => {
    await expect(
      prepareProjectPicture(
        new File(["<svg />"], "badge.svg", { type: "image/svg+xml" }),
      ),
    ).rejects.toThrow(/PNG, JPEG, or WebP/);
    const file = new File([new Uint8Array(10 * 1024 * 1024 + 1)], "large.png", {
      type: "image/png",
    });
    await expect(prepareProjectPicture(file)).rejects.toThrow(/10 MB/);
  });

  it("downsamples a large picture proportionally and releases its temporary URL", async () => {
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", {
      createObjectURL: () => "blob:project-picture",
      revokeObjectURL,
    });
    class DecodedImage {
      naturalWidth = 1600;
      naturalHeight = 800;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(value: string) {
        if (value) queueMicrotask(() => this.onload?.());
      }
    }
    vi.stubGlobal("Image", DecodedImage);
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D);
    const dataUrl = "data:image/webp;base64,AAAA";
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(dataUrl);

    await expect(
      prepareProjectPicture(
        new File([new Uint8Array(1)], "picture.png", { type: "image/png" }),
      ),
    ).resolves.toBe(dataUrl);
    expect(drawImage).toHaveBeenCalledWith(
      expect.any(DecodedImage),
      0,
      0,
      256,
      128,
    );
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:project-picture");
  });

  it("releases a pending picture when its dialog closes", async () => {
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", {
      createObjectURL: () => "blob:pending-picture",
      revokeObjectURL,
    });
    vi.stubGlobal(
      "Image",
      class {
        src = "";
        onload = null;
        onerror = null;
      },
    );
    const controller = new AbortController();
    const pending = prepareProjectPicture(
      new File([new Uint8Array(1)], "picture.png", { type: "image/png" }),
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:pending-picture");
  });
});
