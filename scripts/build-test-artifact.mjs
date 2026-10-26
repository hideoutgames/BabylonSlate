import { commandSignal } from "./process-runner.mjs";
import { buildOwnedArtifact } from "./test-build.mjs";
// A cancelled browser run signals this whole group. Stop the running compile
// stage first so it releases its nested scope under the root's lease.
const lifetime = commandSignal();
try {
  await buildOwnedArtifact({ signal: lifetime.signal });
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = lifetime.signal.aborted ? 130 : (error.exitCode ?? 1);
} finally {
  lifetime.dispose();
}
