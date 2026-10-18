import { describe, expect, it } from "vitest";
import { loadPlayerDistFiles } from "./load-player-files";

describe("loadPlayerDistFiles", () => {
  it("loads listed player files and skips the file list itself and names outside the player root", async () => {
    const requested: string[] = [];
    const outside = ["../editor.js", "/player.js", "https://example.com/player.js", "havok/../../editor.js", "havok\\..\\editor.js"];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith("player-files.json")) {
        return new Response(JSON.stringify(["index.html", "player.js", "player-files.json", ...outside]));
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
    expect([...files.keys()].sort()).toEqual(["index.html", "player.js"]);
    expect(new TextDecoder().decode(files.get("index.html"))).toContain("doctype");
    const root = requested[0]!.replace(/player-files\.json$/, "");
    expect(root.endsWith("/player/")).toBe(true);
    expect(requested.slice(1)).toEqual([`${root}index.html`, `${root}player.js`]);
  });

  it("does not fetch dot-named marker files a stale list still names", async () => {
    const requested: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith("player-files.json")) {
        return new Response(JSON.stringify(["index.html", "ktx2/.keep", ".nojekyll", "ktx2/uastc_astc.wasm", ".hidden/player.js"]));
      }
      return new Response("bytes");
    };
    const files = await loadPlayerDistFiles("/player/", fetchImpl);
    expect([...files.keys()].sort()).toEqual(["index.html", "ktx2/uastc_astc.wasm"]);
    expect(requested.some((url) => url.includes(".keep") || url.includes(".nojekyll") || url.includes(".hidden"))).toBe(false);
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
    expect(requested.some((url) => url.includes("ktx2/uastc_rgba8_unorm_v2.wasm"))).toBe(
      true,
    );
    expect(requested.some((url) => url.includes("ktx2/zstddec.wasm"))).toBe(
      true,
    );
    expect(requested.some((url) => url.includes("draco/draco_decoder_gltf.wasm"))).toBe(
      true,
    );
    expect(requested.some((url) => url.includes("meshopt/meshopt_decoder.js"))).toBe(
      true,
    );
  });
});
