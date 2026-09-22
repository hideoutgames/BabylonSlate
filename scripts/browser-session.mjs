import { startBrowserServer } from "./browser-server.mjs";
import { browserPartitionArgs } from "./browser-partition.mjs";
import { readBrowserResults } from "./browser-results.mjs";
import { join, resolve } from "node:path";
import { verifyBrowserArtifact } from "./test-build.mjs";
import {
  commandSignal,
  runCommand,
  toolCli,
  repoRoot,
} from "./process-runner.mjs";

const directory = resolve(process.argv[2]);
const identity = await verifyBrowserArtifact(directory);
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
  if (result.code === 0) {
    const outcomes = await readBrowserResults(
      join(repoRoot, "test-results/timings.json"),
      server.nonce,
    );
    process.stdout.write(
      JSON.stringify({ event: "browser-results", ...outcomes }) + "\n",
    );
  }
} finally {
  await server.close();
  lifetime.dispose();
}
