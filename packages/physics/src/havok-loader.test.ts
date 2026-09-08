import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadHavokModule, resetHavokModuleCache } from "./havok-loader";

afterEach(() => {
  vi.unstubAllGlobals();
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
        "https://editor.test/BabylonSlate/havok/HavokPhysics.wasm",
      ),
    ).rejects.toThrow("404");
    const havok = await loadHavokModule(
      "https://editor.test/BabylonSlate/havok/HavokPhysics.wasm",
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
        "https://editor.test/BabylonSlate/havok/HavokPhysics.wasm",
      ),
    ).rejects.toThrow("Network unavailable");
  });
});
