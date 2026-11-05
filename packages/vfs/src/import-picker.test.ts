import { afterEach, describe, expect, it, vi } from "vitest";

const getPlatform = vi.fn(() => "web");

vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => getPlatform() },
}));

const { pickImportFiles } = await import("./import-picker");

/** The `accept` the picker's input had when it opened, on a host with this user agent. */
async function pickedAccept(userAgent: string, maxTouchPoints = 0): Promise<string> {
  vi.stubGlobal("navigator", { userAgent, maxTouchPoints });
  const opened: { accept?: string } = {};
  const clickSpy = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
    opened.accept = this.accept;
    this.dispatchEvent(new Event("cancel"));
  });
  try {
    await pickImportFiles({ accept: ".png,.fbx" });
  } finally {
    clickSpy.mockRestore();
  }
  if (opened.accept === undefined) throw new Error("The picker did not open.");
  return opened.accept;
}

const DESKTOP_SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.0 Safari/605.1.15";

describe("pickImportFiles", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    getPlatform.mockReturnValue("web");
    document.body.innerHTML = "";
  });

  it("offers only the accepted types on desktop and Android", async () => {
    expect(await pickedAccept("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0")).toBe(".png,.fbx");
    expect(await pickedAccept(DESKTOP_SAFARI)).toBe(".png,.fbx");
    expect(await pickedAccept("Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile Safari/537.36", 5)).toBe(".png,.fbx");
  });

  it("offers every file on iPhone and iPad, where a type filter greys out extensions iOS has no type for", async () => {
    expect(await pickedAccept("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148")).toBe("");
    // iPadOS Safari and WKWebView report a Mac; touch support gives it away.
    expect(await pickedAccept(DESKTOP_SAFARI, 5)).toBe("");
    getPlatform.mockReturnValue("ios");
    expect(await pickedAccept(DESKTOP_SAFARI)).toBe("");
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
