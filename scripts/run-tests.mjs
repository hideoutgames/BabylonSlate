import { commandSignal, repoRoot } from "./process-runner.mjs";
import { runTests } from "./test-runner.mjs";
process.chdir(repoRoot);
const lifetime = commandSignal();
try {
  await runTests(process.argv[2], process.argv.slice(3), {
    signal: lifetime.signal,
  });
} catch (error) {
  process.stderr.write(error.message + "\n");
  process.exitCode = lifetime.signal.aborted ? 130 : (error.exitCode ?? 1);
} finally {
  lifetime.dispose();
}
