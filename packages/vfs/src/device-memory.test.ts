import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getPlatform = vi.fn(() => "web");
const nativeStats = vi.fn(async () => ({
  appFootprintBytes: 40 * 1024 * 1024,
  appAvailableBytes: 256 * 1024 * 1024 as number | null,
  systemAvailableBytes: 1024 * 1024 * 1024,
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => getPlatform() },
  registerPlugin: () => ({ stats: nativeStats }),
}));

const { getHostMemoryStats } = await import("./device-memory");

function setPerformanceMemory(value: { usedJSHeapSize: number } | undefined) {
  Object.defineProperty(performance, "memory", {
    configurable: true,
    value,
  });
}

describe("host memory stats", () => {
  beforeEach(() => {
    getPlatform.mockReturnValue("web");
    nativeStats.mockClear();
  });

  afterEach(() => {
    setPerformanceMemory(undefined);
  });

  it("reports the JS heap where performance.memory exists", async () => {
    setPerformanceMemory({ usedJSHeapSize: 64 * 1024 * 1024 });
    const stats = await getHostMemoryStats();
    expect(stats?.jsHeapBytes).toBe(64 * 1024 * 1024);
    expect(nativeStats).not.toHaveBeenCalled();
  });

  it("returns null when no source can report", async () => {
    setPerformanceMemory(undefined);
    expect(await getHostMemoryStats()).toBeNull();
  });

  it("merges native process counters on ios", async () => {
    getPlatform.mockReturnValue("ios");
    setPerformanceMemory(undefined);
    const stats = await getHostMemoryStats();
    expect(nativeStats).toHaveBeenCalledOnce();
    expect(stats?.appFootprintBytes).toBe(40 * 1024 * 1024);
    expect(stats?.appAvailableBytes).toBe(256 * 1024 * 1024);
    expect(stats?.systemAvailableBytes).toBe(1024 * 1024 * 1024);
  });

  it("keeps JS heap data when the native plugin is absent", async () => {
    getPlatform.mockReturnValue("ios");
    setPerformanceMemory({ usedJSHeapSize: 8 * 1024 * 1024 });
    nativeStats.mockRejectedValueOnce(new Error("not implemented"));
    const stats = await getHostMemoryStats();
    expect(stats?.jsHeapBytes).toBe(8 * 1024 * 1024);
    expect(stats?.appFootprintBytes).toBeUndefined();
  });

  it("merges Android host counters and omits its unavailable app allowance", async () => {
    getPlatform.mockReturnValue("android");
    nativeStats.mockResolvedValueOnce({
      appFootprintBytes: 40 * 1024 * 1024,
      appAvailableBytes: null,
      systemAvailableBytes: 1024 * 1024 * 1024,
    });
    setPerformanceMemory({ usedJSHeapSize: 4 * 1024 * 1024 });
    const stats = await getHostMemoryStats();
    expect(nativeStats).toHaveBeenCalledOnce();
    expect(stats?.jsHeapBytes).toBe(4 * 1024 * 1024);
    expect(stats?.appFootprintBytes).toBe(40 * 1024 * 1024);
    expect(stats?.appAvailableBytes).toBeUndefined();
    expect(stats?.systemAvailableBytes).toBe(1024 * 1024 * 1024);
  });
});
