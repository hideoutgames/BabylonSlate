import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  commandSignal,
  repoRoot,
  runCommand,
  toolCli,
} from "./process-runner.mjs";

const require = createRequire(join(repoRoot, "apps/editor/package.json"));
const { preview } = await import(pathToFileURL(require.resolve("vite")).href);
const directory = resolve(process.argv[2]);
const identity = JSON.parse(
  await readFile(join(directory, ".test-build.json"), "utf8"),
);
const nonce = randomUUID();
const lifetime = commandSignal();
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
try {
  const address = server.httpServer.address();
  if (!address || typeof address === "string")
    throw new Error("Test server did not bind a TCP port");
  const env = {
    ...process.env,
    BL_TEST_BASE_URL: `http://127.0.0.1:${address.port}`,
    BL_TEST_BUILD_KEY: identity.key,
    BL_TEST_SERVER_NONCE: nonce,
  };
  const result = await runCommand(
    process.execPath,
    [toolCli("@playwright/test"), "test", ...process.argv.slice(3)],
    { env, signal: lifetime.signal },
  );
  process.exitCode = result.code;
} finally {
  await new Promise((done) => {
    server.httpServer.close(done);
    server.httpServer.closeAllConnections();
  });
  lifetime.dispose();
}
