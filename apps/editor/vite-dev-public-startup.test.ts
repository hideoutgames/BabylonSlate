import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { describe, expect, it } from "vitest";
import { ENGINE_BILLBOARD_FILES } from "../../packages/render/src/default-billboard/urls";
import { engineBillboardsVitePlugin } from "./vite-engine-billboards";
import { enginePluginsVitePlugin } from "./vite-engine-plugins";
import { engineDefaultSkyboxVitePlugin } from "./vite-engine-skybox";
import { kenneyMannequinVitePlugin } from "./vite-kenney-mannequin";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

async function get(base: string, path: string) {
  const res = await fetch(new URL(path, base));
  return {
    status: res.status,
    contentType: res.headers.get("content-type") ?? "",
    bytes: new Uint8Array(await res.arrayBuffer()),
  };
}

describe("dev server first-run public snapshot", () => {
  it("serves copied and packed engine assets on first listen with the watcher off", {
    timeout: 30_000,
  }, async () => {
    const root = mkdtempSync(join(tmpdir(), "vite-dev-public-"));
    const publicDir = join(root, "public");
    let server: Awaited<ReturnType<typeof createServer>> | undefined;
    try {
      mkdirSync(publicDir, { recursive: true });
      writeFileSync(join(root, "index.html"), "<html><body>app</body></html>");
      server = await createServer({
        root,
        configFile: false,
        logLevel: "silent",
        server: { port: 0, host: "127.0.0.1", watch: null },
        publicDir,
        plugins: [
          engineBillboardsVitePlugin(REPO_ROOT, publicDir),
          engineDefaultSkyboxVitePlugin(REPO_ROOT, publicDir),
          kenneyMannequinVitePlugin({
            sourceDir: join(REPO_ROOT, "engine-content/kenney-assets/Mannequin"),
            publicDir: join(
              publicDir,
              "engine-content/kenney-assets/Mannequin",
            ),
          }),
          enginePluginsVitePlugin({
            sourceDir: join(REPO_ROOT, "engine-plugins"),
            publicDir: join(publicDir, "engine-plugins"),
          }),
        ],
      });
      await server.listen();
      const base = server.resolvedUrls!.local[0]!;

      const glb = await get(
        base,
        "/engine-content/kenney-assets/Mannequin/mannequin.glb",
      );
      expect(glb.status).toBe(200);
      expect(String.fromCharCode(...glb.bytes.slice(0, 4))).toBe("glTF");
      expect(glb.contentType).toContain("model/gltf-binary");

      const png = await get(
        base,
        "/engine-content/kenney-assets/Mannequin/mannequin.png",
      );
      expect(png.status).toBe(200);
      expect([...png.bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);

      const face = await get(base, "/engine-content/skybox/px.png");
      expect(face.status).toBe(200);
      expect([...face.bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);

      const billboard = await get(
        base,
        `/engine-content/billboards/${ENGINE_BILLBOARD_FILES[0]}`,
      );
      expect(billboard.status).toBe(200);
      expect(billboard.bytes.byteLength).toBeGreaterThan(0);

      const index = await get(base, "/engine-plugins/index.json");
      expect(index.status).toBe(200);
      const entries = JSON.parse(new TextDecoder().decode(index.bytes)) as Array<{
        id: string;
        file: string;
      }>;
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        const plugin = await get(base, `/engine-plugins/${entry.file}`);
        expect(plugin.status).toBe(200);
        expect([...plugin.bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
      }

      // The whitelist must not pretend arbitrary names are generated assets;
      // a miss falls through to the SPA fallback or a 404.
      const missing = await get(base, "/engine-plugins/nope.babplugin");
      expect(
        missing.status === 404 || missing.contentType.includes("text/html"),
      ).toBe(true);
    } finally {
      await server?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
