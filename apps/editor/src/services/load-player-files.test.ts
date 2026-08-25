import { describe, expect, it } from "vitest";
import { loadPlayerDistFiles } from "./load-player-files";

describe("loadPlayerDistFiles", () => {
  it("loads listed player files and skips the file list itself", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("player-files.json")) {
        return new Response(JSON.stringify(["index.html", "player.js", "player-files.json"]));
      }
      if (url.endsWith("index.html")) {
        return new Response("<!doctype html>");
      }
      if (url.endsWith("player.js")) {
        return new Response("void 0");
      }
      return new Response("missing", { status: 404 });
    };
    const files = await loadPlayerDistFiles("/player/", fetchImpl);
    expect(files.has("player-files.json")).toBe(false);
    expect(new TextDecoder().decode(files.get("index.html"))).toContain("doctype");
    expect(files.has("player.js")).toBe(true);
  });

  it("fetches UASTC and Zstd wasm when player-files.json is missing", async () => {
    const requested: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith("index.html")) {
        return new Response("<!doctype html>");
      }
      return new Response("missing", { status: 404 });
    };
    await loadPlayerDistFiles("/player/", fetchImpl);
    expect(requested.some((url) => url.includes("ktx2/uastc_astc.wasm"))).toBe(
      true,
    );
    expect(requested.some((url) => url.includes("ktx2/uastc_bc7.wasm"))).toBe(
      true,
    );
    expect(requested.some((url) => url.includes("ktx2/zstddec.wasm"))).toBe(
      true,
    );
  });
});
