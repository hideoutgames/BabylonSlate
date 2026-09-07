import { appendFile } from "node:fs/promises";
import { commandSignal, repoRoot } from "./process-runner.mjs";
import { runTests } from "./test-runner.mjs";
process.chdir(repoRoot);
const lifetime = commandSignal();
try {
  const result = await runTests(process.argv[2], process.argv.slice(3), {
    signal: lifetime.signal,
  });
  if (result?.directory && process.env.GITHUB_OUTPUT) {
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `directory=${result.directory}\n`,
    );
  }
} catch (error) {
  process.stderr.write(error.message + "\n");
  process.exitCode = lifetime.signal.aborted ? 130 : (error.exitCode ?? 1);
} finally {
  lifetime.dispose();
}
