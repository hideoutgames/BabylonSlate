import { Directory } from "@capacitor/filesystem";
import { beforeEach, describe, expect, it, vi } from "vitest";

let platform = "web";
const init = vi.fn(async () => {});
const directories: unknown[] = [];

vi.mock("./platform", () => ({
  isMobilePlatform: () => platform === "ios" || platform === "android",
  isElectronHost: () => platform === "electron",
  getElectronProjectBridge: () => null,
  getHostPlatform: () => platform,
}));

vi.mock("./documents-adapter", () => ({
  DocumentsStorageAdapter: class {
    constructor(_filesystem: unknown, directory: unknown) {
      directories.push(directory);
    }
  },
}));

vi.mock("./mobile-storage-adapter", () => ({
  MobileStorageAdapter: class {
    init = init;
    constructor(readonly documents: unknown) {}
  },
}));

const { createStorage, mobileDocumentsDirectory } = await import("./create-storage");
const { OpfsStorageAdapter } = await import("./web-adapter");
const { MobileStorageAdapter } = await import("./mobile-storage-adapter");
const { ElectronStorageAdapter } = await import("./electron-storage-adapter");

describe("createStorage", () => {
  beforeEach(() => {
    platform = "web";
    init.mockClear();
    directories.length = 0;
  });

  it("uses the OPFS adapter on web hosts", () => {
    expect(createStorage()).toBeInstanceOf(OpfsStorageAdapter);
    expect(init).not.toHaveBeenCalled();
  });

  it("uses app-private Data for Android and Documents for iOS", () => {
    platform = "android";
    expect(createStorage()).toBeInstanceOf(MobileStorageAdapter);
    expect(directories).toEqual([Directory.Data]);
    directories.length = 0;
    platform = "ios";
    expect(createStorage()).toBeInstanceOf(MobileStorageAdapter);
    expect(directories).toEqual([Directory.Documents]);
    expect(mobileDocumentsDirectory("android")).toBe(Directory.Data);
    expect(mobileDocumentsDirectory("ios")).toBe(Directory.Documents);
  });

  it("uses the Electron adapter on desktop hosts", () => {
    platform = "electron";
    expect(createStorage()).toBeInstanceOf(ElectronStorageAdapter);
  });
});
