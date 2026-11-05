import { Blob as NodeBlob, File as NodeFile } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BabylonSlateFileExportPlugin } from "./capacitor-file-export";

const getPlatform = vi.fn(() => "web");
const plugin = {
  begin: vi.fn(async (_options: { name: string; mimeType: string }) => ({ id: "export-1" })),
  append: vi.fn(async (_options: { id: string; data: string }) => {}),
  finish: vi.fn(async (_options: { id: string }) => ({ result: "shared" as "shared" | "saved" | "cancelled" })),
  discard: vi.fn(async (_options: { id: string }) => {}),
};

vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => getPlatform() },
  registerPlugin: () => plugin,
}));

const { exportThroughNativeShell, saveFile } = await import("./save-file");

const IPAD_SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15";
const IPHONE_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";
const DESKTOP_CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0";

function theme(): Blob {
  return new Blob(['{"format":"haptic-editor-theme"}'], { type: "application/json" });
}

/** File names the anchor fallback downloaded. */
function watchDownloads(): string[] {
  const downloads: string[] = [];
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:export");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push(this.download);
  });
  return downloads;
}

function browser(userAgent: string, share?: { canShare: boolean; share: (data: ShareData) => Promise<void> }) {
  vi.stubGlobal("navigator", {
    userAgent,
    maxTouchPoints: userAgent === IPAD_SAFARI ? 5 : 0,
    ...(share ? { canShare: () => share.canShare, share: share.share } : {}),
  });
}

// jsdom's Blob has no arrayBuffer() or text(); every browser Haptic supports has both.
beforeEach(() => {
  vi.stubGlobal("Blob", NodeBlob);
  vi.stubGlobal("File", NodeFile);
});

describe("saveFile", () => {
  beforeEach(() => {
    getPlatform.mockReturnValue("web");
    for (const method of Object.values(plugin)) method.mockClear();
    plugin.finish.mockResolvedValue({ result: "shared" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (globalThis as { haptic?: unknown }).haptic;
  });

  it("hands the file to the iOS app's share sheet instead of an anchor download", async () => {
    getPlatform.mockReturnValue("ios");
    const downloads = watchDownloads();
    await expect(saveFile("Haptic_Dark.haptic-theme.json", theme())).resolves.toBe("shared");
    expect(plugin.begin).toHaveBeenCalledWith({ name: "Haptic_Dark.haptic-theme.json", mimeType: "application/json" });
    expect(plugin.append).toHaveBeenCalledWith({ id: "export-1", data: btoa('{"format":"haptic-editor-theme"}') });
    expect(plugin.finish).toHaveBeenCalledWith({ id: "export-1" });
    expect(downloads).toEqual([]);
  });

  it("reports a closed share sheet or save dialog as cancelled, not as an error", async () => {
    getPlatform.mockReturnValue("android");
    plugin.finish.mockResolvedValue({ result: "cancelled" });
    await expect(saveFile("backup.zip", new Blob([new Uint8Array([1])], { type: "application/zip" }))).resolves.toBe("cancelled");
    expect(plugin.discard).not.toHaveBeenCalled();
  });

  it("shares a File of the right name and type from iPhone and iPad Safari within the tap", async () => {
    for (const userAgent of [IPAD_SAFARI, IPHONE_SAFARI]) {
      const shared: File[] = [];
      const share = vi.fn(async (data: ShareData) => { shared.push(...(data.files ?? [])); });
      browser(userAgent, { canShare: true, share });
      const downloads = watchDownloads();
      const saving = saveFile("Haptic_Dark.haptic-theme.json", theme());
      // Safari allows a share only during the tap, so it must start before the first await.
      expect(share).toHaveBeenCalledTimes(1);
      await expect(saving).resolves.toBe("shared");
      expect(shared.map((file) => [file.name, file.type])).toEqual([["Haptic_Dark.haptic-theme.json", "application/json"]]);
      expect(await shared[0]!.text()).toBe('{"format":"haptic-editor-theme"}');
      expect(downloads).toEqual([]);
      expect(plugin.begin).not.toHaveBeenCalled();
      vi.restoreAllMocks();
    }
  });

  it("treats a dismissed Safari share sheet as cancelled", async () => {
    browser(IPAD_SAFARI, { canShare: true, share: async () => { throw new DOMException("Share canceled", "AbortError"); } });
    const downloads = watchDownloads();
    await expect(saveFile("Haptic_Dark.haptic-theme.json", theme())).resolves.toBe("cancelled");
    expect(downloads).toEqual([]);
  });

  it("downloads in Safari when the tap that started a slow export has expired", async () => {
    browser(IPAD_SAFARI, { canShare: true, share: async () => { throw new DOMException("No user activation", "NotAllowedError"); } });
    const downloads = watchDownloads();
    await expect(saveFile("Harbour_Run.zip", theme())).resolves.toBe("downloaded");
    expect(downloads).toEqual(["Harbour_Run.zip"]);
  });

  it("rejects when Safari's share fails for another reason", async () => {
    browser(IPAD_SAFARI, { canShare: true, share: async () => { throw new DOMException("Bad data", "DataError"); } });
    const downloads = watchDownloads();
    await expect(saveFile("Harbour_Run.zip", theme())).rejects.toThrow("Bad data");
    expect(downloads).toEqual([]);
  });

  it("downloads with an anchor where files cannot be shared", async () => {
    const share = vi.fn(async () => {});
    for (const [userAgent, canShare] of [[IPAD_SAFARI, false], [DESKTOP_CHROME, true]] as const) {
      browser(userAgent, { canShare, share });
      const downloads = watchDownloads();
      await expect(saveFile("Harbour_Run.zip", theme())).resolves.toBe("downloaded");
      expect(downloads).toEqual(["Harbour_Run.zip"]);
      vi.restoreAllMocks();
    }
    browser(IPHONE_SAFARI);
    const downloads = watchDownloads();
    await expect(saveFile("Harbour_Run.zip", theme())).resolves.toBe("downloaded");
    expect(downloads).toEqual(["Harbour_Run.zip"]);
    expect(share).not.toHaveBeenCalled();
  });

  it("saves through the desktop app's save dialog with the file's bytes", async () => {
    const save = vi.fn(async (_name: string, _data: ArrayBuffer) => true);
    (globalThis as { haptic?: unknown }).haptic = { userData: {}, files: { save } };
    const downloads = watchDownloads();
    await expect(saveFile("Haptic_Dark.haptic-theme.json", theme())).resolves.toBe("saved");
    expect(save.mock.calls[0]![0]).toBe("Haptic_Dark.haptic-theme.json");
    expect(new TextDecoder().decode(save.mock.calls[0]![1])).toBe('{"format":"haptic-editor-theme"}');
    save.mockResolvedValue(false);
    await expect(saveFile("Haptic_Dark.haptic-theme.json", theme())).resolves.toBe("cancelled");
    expect(downloads).toEqual([]);
  });
});

describe("exportThroughNativeShell", () => {
  function nativePlugin(overrides: Partial<BabylonSlateFileExportPlugin> = {}) {
    const appended: string[] = [];
    const calls: string[] = [];
    const native: BabylonSlateFileExportPlugin = {
      begin: async () => { calls.push("begin"); return { id: "export-7" }; },
      append: async ({ data }) => { calls.push("append"); appended.push(data); },
      finish: async () => { calls.push("finish"); return { result: "saved" }; },
      discard: async ({ id }) => { calls.push(`discard ${id}`); },
      ...overrides,
    };
    return { native, appended, calls };
  }

  it("streams the file in base64 chunks before presenting it", async () => {
    const { native, appended, calls } = nativePlugin();
    const data = new Blob([new Uint8Array([0, 1, 2, 3, 4])]);
    await expect(exportThroughNativeShell(native, "save.babsave", data, 2)).resolves.toBe("saved");
    expect(appended).toEqual(["AAE=", "AgM=", "BA=="]);
    expect(calls).toEqual(["begin", "append", "append", "append", "finish"]);
  });

  it("presents an empty file without appending", async () => {
    const { native, calls } = nativePlugin();
    await expect(exportThroughNativeShell(native, "empty.json", new Blob([]), 2)).resolves.toBe("saved");
    expect(calls).toEqual(["begin", "finish"]);
  });

  it("discards the temporary file and rejects when a chunk fails", async () => {
    const { native, calls } = nativePlugin({
      append: async () => { calls.push("append"); throw new Error("Disk full"); },
    });
    await expect(exportThroughNativeShell(native, "Harbour_Run.zip", new Blob([new Uint8Array(5)]), 2)).rejects.toThrow("Disk full");
    expect(calls).toEqual(["begin", "append", "discard export-7"]);
  });
});
