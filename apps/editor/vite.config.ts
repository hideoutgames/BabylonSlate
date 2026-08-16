import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { enginePluginsVitePlugin } from "./vite-engine-plugins.ts";
import { playerHostVitePlugin } from "./vite-player-host.ts";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(rootDir, "../..");

// #region agent log
function agentDebugLogPlugin(): Plugin {
  const handler = (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
  ) => {
    if (req.url?.split("?")[0] !== "/__agent_debug_log" || req.method !== "POST") {
      next();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString();
        fs.mkdirSync("/opt/cursor/logs", { recursive: true });
        fs.appendFileSync(
          "/opt/cursor/logs/debug.log",
          body.endsWith("\n") ? body : `${body}\n`,
        );
      } catch {
        /* ignore */
      }
      res.statusCode = 204;
      res.end();
    });
  };
  return {
    name: "agent-debug-log",
    configureServer(server) {
      return () => {
        server.middlewares.use(handler);
      };
    },
    configurePreviewServer(server) {
      return () => {
        server.middlewares.use(handler);
      };
    },
  };
}
// #endregion

export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? "/",
  plugins: [
    react(),
    tailwindcss(),
    agentDebugLogPlugin(),
    enginePluginsVitePlugin({
      sourceDir: path.join(repoRoot, "engine-plugins"),
      publicDir: path.join(rootDir, "public/engine-plugins"),
    }),
    playerHostVitePlugin(
      path.join(rootDir, "../player/dist"),
      path.join(rootDir, "dist"),
    ),
  ],
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "./src"),
      "@babylonslate/ui": path.resolve(rootDir, "../../packages/ui/src"),
    },
  },
  server: {
    host: true,
    port: 5173,
  },
});
