import { afterEach, describe, expect, it, vi } from "vitest";
import { pickImportFiles } from "./import-picker";

describe("pickImportFiles", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
  });

  it("uses the DOM file input on web", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const clickSpy = vi
      .spyOn(HTMLInputElement.prototype, "click")
      .mockImplementation(function (this: HTMLInputElement) {
        const file = {
          name: "a.png",
          arrayBuffer: async () => bytes.buffer.slice(0),
        } as unknown as File;
        Object.defineProperty(this, "files", {
          configurable: true,
          value: [file],
        });
        this.dispatchEvent(new Event("change"));
      });

    const picked = await pickImportFiles({ multiple: true });
    expect(clickSpy).toHaveBeenCalled();
    expect(picked).toHaveLength(1);
    expect(picked[0]!.name).toBe("a.png");
    expect(picked[0]!.bytes).toEqual(bytes);
    clickSpy.mockRestore();
  });

  it("does not cancel the pick when the window focuses before files are chosen", async () => {
    vi.useFakeTimers();
    const bytes = new Uint8Array([4, 5]);
    const clickSpy = vi
      .spyOn(HTMLInputElement.prototype, "click")
      .mockImplementation(() => {
        /* picker still open */
      });

    const pending = pickImportFiles();
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(500);

    const input = document.querySelector(
      '[data-testid="vfs-import-picker-input"]',
    ) as HTMLInputElement;
    expect(input).toBeTruthy();
    const file = {
      name: "late.png",
      arrayBuffer: async () => bytes.buffer.slice(0),
    } as unknown as File;
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [file],
    });
    input.dispatchEvent(new Event("change"));

    const picked = await pending;
    expect(picked).toHaveLength(1);
    expect(picked[0]!.name).toBe("late.png");
    clickSpy.mockRestore();
    vi.useRealTimers();
  });

  it("rejects a provider audio read failure and removes the input so importing can be retried", async () => {
    const clickSpy = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
      Object.defineProperty(this, "files", { value: [{
        name: "cloud.wav",
        arrayBuffer: async () => { throw new Error("Audio is offline"); },
      }] });
      this.dispatchEvent(new Event("change"));
    });
    try {
      await expect(pickImportFiles()).rejects.toThrow("Audio is offline");
      expect(document.querySelector('[data-testid="vfs-import-picker-input"]')).toBeNull();
    } finally {
      clickSpy.mockRestore();
    }
  });
});
