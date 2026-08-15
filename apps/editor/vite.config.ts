import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { enginePluginsVitePlugin } from "./vite-engine-plugins.ts";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(rootDir, "../..");

export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? "/",
  plugins: [
    react(),
    tailwindcss(),
    enginePluginsVitePlugin({
      sourceDir: path.join(repoRoot, "engine-plugins"),
      publicDir: path.join(rootDir, "public/engine-plugins"),
    }),
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
