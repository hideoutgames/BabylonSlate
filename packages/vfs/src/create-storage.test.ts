import { beforeEach, describe, expect, it, vi } from "vitest";

const isMobile = vi.fn(() => false);
const init = vi.fn(async () => {});

vi.mock("./platform", () => ({
  isMobilePlatform: () => isMobile(),
  getHostPlatform: () => (isMobile() ? "ios" : "web"),
}));

vi.mock("./scoped-storage-adapter", () => ({
  ScopedStorageAdapter: class {
    init = init;
  },
}));

const { createStorage } = await import("./create-storage");
const { WebStorageAdapter } = await import("./web-adapter");
const { ScopedStorageAdapter } = await import("./scoped-storage-adapter");

describe("createStorage", () => {
  beforeEach(() => {
    isMobile.mockReturnValue(false);
    init.mockClear();
  });

  it("uses the web adapter on web hosts", () => {
    expect(createStorage()).toBeInstanceOf(WebStorageAdapter);
    expect(init).not.toHaveBeenCalled();
  });

  it("uses the scoped-storage adapter on mobile hosts and initializes it", () => {
    isMobile.mockReturnValue(true);
    expect(createStorage()).toBeInstanceOf(ScopedStorageAdapter);
    expect(init).toHaveBeenCalledOnce();
  });
});
