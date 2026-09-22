/** Reject competing CLI values before spawn, including equal-sign aliases. */
export function workerArguments(args, plan, kind) {
  const names =
    kind === "browser"
      ? ["--workers", "-j", "--retries"]
      : ["--maxWorkers", "--minWorkers", "--fileParallelism", "--retry"];
  for (const arg of args) {
    const normalized = arg.replaceAll("-", "").toLowerCase().split("=")[0];
    if (
      names.some(
        (name) => normalized === name.replaceAll("-", "").toLowerCase(),
      ) ||
      /^-j\d/.test(arg)
    )
      throw new Error(
        "Worker/retry CLI overrides conflict with the resolved host execution policy",
      );
  }
  return [
    ...args,
    ...(kind === "browser"
      ? [`--workers=${plan.browserWorkers}`, `--retries=${plan.retries}`]
      : [
          `--maxWorkers=${plan.workers}`,
          ...(plan.workers === 1 ? ["--fileParallelism=false"] : []),
          "--retry=0",
        ]),
  ];
}
