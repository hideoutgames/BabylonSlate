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
  let mount = "/player/";
  return {
    name: "player-host",
    configResolved(config) {
      // Preview Build requests the player through the Vite base, so a deployed
      // sub-path such as `/BabylonSlate/` must be served here too.
      const base = config.base && config.base !== "" ? config.base : "/";
      mount = `${base.endsWith("/") ? base : `${base}/`}player/`;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split("?")[0] ?? "";
        const bare = mount.slice(0, -1);
        if (!url.startsWith(mount) && url !== bare) return next();
        const rel =
          url === bare || url === mount
            ? "index.html"
            : decodeURIComponent(url.slice(mount.length));
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
