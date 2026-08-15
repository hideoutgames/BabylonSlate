import { beforeEach, describe, expect, it, vi } from "vitest";

const isMobile = vi.fn(() => false);
const isElectron = vi.fn(() => false);
const init = vi.fn(async () => {});

vi.mock("./platform", () => ({
  isMobilePlatform: () => isMobile(),
  isElectronHost: () => isElectron(),
  getElectronProjectBridge: () => null,
  getHostPlatform: () => (isMobile() ? "ios" : isElectron() ? "electron" : "web"),
}));

vi.mock("./mobile-storage-adapter", () => ({
  MobileStorageAdapter: class {
    init = init;
  },
}));

const { createStorage } = await import("./create-storage");
const { OpfsStorageAdapter } = await import("./web-adapter");
const { MobileStorageAdapter } = await import("./mobile-storage-adapter");
const { ElectronStorageAdapter } = await import("./electron-storage-adapter");

describe("createStorage", () => {
  beforeEach(() => {
    isMobile.mockReturnValue(false);
    isElectron.mockReturnValue(false);
    init.mockClear();
  });

  it("uses the OPFS adapter on web hosts", () => {
    expect(createStorage()).toBeInstanceOf(OpfsStorageAdapter);
    expect(init).not.toHaveBeenCalled();
  });

  it("uses the mobile adapter on mobile hosts and initializes it", () => {
    isMobile.mockReturnValue(true);
    expect(createStorage()).toBeInstanceOf(MobileStorageAdapter);
    expect(init).toHaveBeenCalledOnce();
  });

  it("uses the Electron adapter on desktop hosts", () => {
    isElectron.mockReturnValue(true);
    expect(createStorage()).toBeInstanceOf(ElectronStorageAdapter);
  });
});
