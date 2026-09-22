import { readLocalResourceConfig } from "./local-resource-config.mjs";
import { hostedExecution } from "./execution-location.mjs";
import { workloadFor } from "./resource-admission.mjs";
export { workerArguments } from "./worker-arguments.mjs";

export async function resolveExecutionPlan(profile, env = process.env) {
  const hosted = hostedExecution(env);
  const config = await readLocalResourceConfig(env);
  const lowMemory = !hosted && config.profile === "low-memory";
  const request = workloadFor(profile, {
    ...env,
    BL_TEST_PROFILE: lowMemory ? "shared" : env.BL_TEST_PROFILE,
  });
  const workers = hosted ? 2 : lowMemory ? 1 : request.workers;
  const browserWorkers =
    !hosted && !lowMemory && env.BL_TEST_PROFILE === "fast" ? 2 : 1;
  return Object.freeze({
    profile,
    hosted,
    lowMemory,
    workers: profile === "build" ? 1 : workers,
    browserWorkers,
    workspaceConcurrency: 1,
    retries: hosted ? 2 : 0,
    // Consume the legacy queue's complete slot budget in low-memory mode. This
    // also prevents older worktrees from admitting light work beside this root.
    request: Object.freeze({
      ...request,
      workers: lowMemory ? config.capacity.workers : request.workers,
    }),
    config: Object.freeze({
      ...config,
      capacity: Object.freeze({ ...config.capacity }),
    }),
    messages: Object.freeze(
      lowMemory && env.BL_TEST_PROFILE === "fast"
        ? ["Low-memory host policy limits fast execution to one worker."]
        : [],
    ),
  });
}
