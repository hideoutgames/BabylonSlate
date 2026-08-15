import { createReadStream, existsSync, statSync } from "node:fs";
import { cpSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".css": "text/css; charset=utf-8",
};

function contentType(file: string): string {
  const ext = path.extname(file).toLowerCase();
  return MIME[ext] ?? "application/octet-stream";
}

/**
 * Dev: serve a built `apps/player/dist` at `/player/`.
 * Build: copy that dist into `apps/editor/dist/player` so Preview Build is
 * same-origin on the editor preview host.
 */
export function playerHostVitePlugin(playerDist: string, editorDist: string): Plugin {
  return {
    name: "player-host",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split("?")[0] ?? "";
        if (!url.startsWith("/player/") && url !== "/player") return next();
        const rel =
          url === "/player" || url === "/player/"
            ? "index.html"
            : decodeURIComponent(url.slice("/player/".length));
        const file = path.resolve(playerDist, rel);
        if (!file.startsWith(path.resolve(playerDist))) return next();
        if (!existsSync(file) || statSync(file).isDirectory()) return next();
        res.setHeader("Content-Type", contentType(file));
        createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      if (!existsSync(playerDist)) return;
      const dest = path.join(editorDist, "player");
      mkdirSync(dest, { recursive: true });
      cpSync(playerDist, dest, { recursive: true });
    },
  };
}
