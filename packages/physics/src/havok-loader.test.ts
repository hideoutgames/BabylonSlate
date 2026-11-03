import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { instantiateHostedWasm, loadHavokModule, resetHavokModuleCache } from "./havok-loader";

// The smallest valid module: magic and version, no imports or exports.
const EMPTY_WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

describe("hosted Havok wasm instantiation", () => {
  it("compiles while downloading when the host serves application/wasm", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(EMPTY_WASM, { headers: { "content-type": "application/wasm" } })));
    const streaming = vi.spyOn(WebAssembly, "instantiateStreaming");
    const buffered = vi.spyOn(WebAssembly, "instantiate");
    const result = await instantiateHostedWasm("https://editor.test/havok/HavokPhysics.wasm", {});
    expect(result.instance).toBeInstanceOf(WebAssembly.Instance);
    expect(streaming).toHaveBeenCalledOnce();
    expect(buffered).not.toHaveBeenCalled();
  });

  it("instantiates the downloaded bytes from a host that does not serve the wasm type, with one request", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(EMPTY_WASM, { headers: { "content-type": "application/octet-stream" } }));
    vi.stubGlobal("fetch", fetch);
    const streaming = vi.spyOn(WebAssembly, "instantiateStreaming");
    const result = await instantiateHostedWasm("https://editor.test/havok/HavokPhysics.wasm", {});
    expect(result.instance).toBeInstanceOf(WebAssembly.Instance);
    expect(streaming).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("reports a missing hosted binary with its status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Missing", { status: 404 })));
    await expect(instantiateHostedWasm("https://editor.test/havok/HavokPhysics.wasm", {})).rejects.toThrow("Havok WASM request failed (404)");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetHavokModuleCache();
});

describe("explicit Havok WASM locations", () => {
  it("reports a missing hosted binary and retries the URL on the next load", async () => {
    resetHavokModuleCache();
    const bytes = readFileSync(
      new URL(
        "../../../apps/editor/public/havok/HavokPhysics.wasm",
        import.meta.url,
      ),
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("Missing", { status: 404 }))
        .mockResolvedValueOnce(new Response(Uint8Array.from(bytes).buffer)),
    );

    await expect(
      loadHavokModule(
        "https://editor.test/Haptic/havok/HavokPhysics.wasm",
      ),
    ).rejects.toThrow("404");
    const havok = await loadHavokModule(
      "https://editor.test/Haptic/havok/HavokPhysics.wasm",
    );
    expect(havok.HP_World_Create).toBeTypeOf("function");
  });

  it("propagates a download failure instead of using an unrelated local binary", async () => {
    resetHavokModuleCache();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("Network unavailable")),
    );
    await expect(
      loadHavokModule(
        "https://editor.test/Haptic/havok/HavokPhysics.wasm",
      ),
    ).rejects.toThrow("Network unavailable");
  });
});
