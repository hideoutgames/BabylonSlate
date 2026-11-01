import { describe, expect, it, vi } from "vitest";
import { editorBuildReplaced, type BuildStalenessHost } from "./build-staleness";

function page(scripts: string[], live: string | Error, ok = true): BuildStalenessHost & { fetch: ReturnType<typeof vi.fn> } {
  const elements = scripts.map((src) => ({ getAttribute: () => src }));
  return {
    document: { baseURI: "https://example.test/BabylonSlate/editor/project?id=1", querySelectorAll: () => elements } as unknown as BuildStalenessHost["document"],
    fetch: vi.fn(async () => {
      if (live instanceof Error) throw live;
      return { ok, text: async () => live };
    }),
  };
}

describe("editorBuildReplaced", () => {
  it("is true once the live index no longer names the entry this page loaded, fetched past caches from the deploy root", async () => {
    const host = page(["/BabylonSlate/assets/index-15sEOQr_.js"], '<script type="module" src="/BabylonSlate/assets/index-Zx9QwErT.js">');
    await expect(editorBuildReplaced(host)).resolves.toBe(true);
    expect(host.fetch).toHaveBeenCalledWith("https://example.test/BabylonSlate/", expect.objectContaining({ cache: "no-store" }));
  });

  it("is false while the live index still names it", async () => {
    await expect(editorBuildReplaced(page(["/BabylonSlate/assets/index-15sEOQr_.js"], '<script src="/BabylonSlate/assets/index-15sEOQr_.js">'))).resolves.toBe(false);
  });

  it("cannot tell, and says false, offline, on an error page, or on a dev server's unhashed entry", async () => {
    await expect(editorBuildReplaced(page(["/assets/index-15sEOQr_.js"], new TypeError("Failed to fetch")))).resolves.toBe(false);
    await expect(editorBuildReplaced(page(["/assets/index-15sEOQr_.js"], "Not Found", false))).resolves.toBe(false);
    const dev = page(["/src/main.tsx"], "");
    await expect(editorBuildReplaced(dev)).resolves.toBe(false);
    expect(dev.fetch).not.toHaveBeenCalled();
  });
});
