import { startBrowserServer } from "./browser-server.mjs";
import { browserPartitionArgs } from "./browser-partition.mjs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { commandSignal, runCommand, toolCli } from "./process-runner.mjs";

const directory = resolve(process.argv[2]);
const identity = JSON.parse(
  await readFile(join(directory, ".test-build.json"), "utf8"),
);
const lifetime = commandSignal();
const server = await startBrowserServer(directory, identity);
try {
  const env = {
    ...process.env,
    BL_TEST_BASE_URL: server.url,
    BL_TEST_BUILD_KEY: identity.key,
    BL_TEST_SERVER_NONCE: server.nonce,
  };
  const args = await browserPartitionArgs(process.argv.slice(3), {
    signal: lifetime.signal,
    env,
  });
  const result = await runCommand(
    process.execPath,
    [toolCli("@playwright/test"), "test", ...args],
    { env, signal: lifetime.signal },
  );
  process.exitCode = result.code;
} finally {
  await server.close();
  lifetime.dispose();
}
