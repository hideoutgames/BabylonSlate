import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot } from "./process-runner.mjs";

export async function startBrowserServer(directory, identity) {
  const require = createRequire(join(repoRoot, "apps/editor/package.json"));
  const { preview } = await import(pathToFileURL(require.resolve("vite")).href);
  const nonce = randomUUID();
  const server = await preview({
    configFile: false,
    root: join(repoRoot, "apps/editor"),
    base: "/",
    build: { outDir: directory },
    preview: { host: "127.0.0.1", port: 0, strictPort: true },
    plugins: [
      {
        name: "owned-test-server",
        configurePreviewServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url !== "/__test_identity") return next();
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Cache-Control", "no-store");
            res.end(JSON.stringify({ key: identity.key, nonce }));
          });
        },
      },
    ],
  });
  const address = server.httpServer.address();
  if (!address || typeof address === "string")
    throw new Error("Test server did not bind a TCP port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    nonce,
    close: () =>
      new Promise((done) => {
        server.httpServer.close(done);
        server.httpServer.closeAllConnections();
      }),
  };
}
