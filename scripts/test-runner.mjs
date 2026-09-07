import { pathToFileURL } from "node:url";
import {
  acquireResources,
  inheritedLease,
  workloads,
} from "./resource-admission.mjs";
import {
  commandSignal,
  pnpmCommand,
  repoRoot,
  runCommand,
  toolCli,
} from "./process-runner.mjs";

export async function runStage(profile, command, args, options = {}) {
  const signal = options.signal;
  const request = workloads[profile];
  if (!request) throw new Error(`Unknown workload: ${profile}`);
  const inherited = await inheritedLease(process.env.BL_TEST_LEASE, request);
  const ci = process.env.CI === "true";
  const lease =
    ci || inherited
      ? null
      : await acquireResources(request, {
          signal,
          onQueued: () =>
            process.stdout.write(
              JSON.stringify({ event: "queued", profile }) + "\n",
            ),
        });
  const env = {
    ...process.env,
    ...options.env,
    VITEST_MAX_WORKERS: ci ? "2" : String(request.workers),
    ...(lease
      ? {
          BL_TEST_LEASE: JSON.stringify({
            ticket: lease.ticket,
            token: lease.token,
          }),
        }
      : {}),
  };
  process.stdout.write(
    JSON.stringify({ event: "stage", profile, queueMs: lease?.queueMs ?? 0 }) +
      "\n",
  );
  try {
    const result = await runCommand(command, args, {
      ...options,
      env,
      onSpawn: (pid) => lease?.child(pid),
    });
    if (result.code !== 0)
      throw Object.assign(
        new Error(`${profile} command failed (${result.code})`),
        { exitCode: result.code },
      );
    return result;
  } finally {
    await lease?.release();
  }
}

export async function runPnpm(profile, args, options) {
  const [command, commandArgs] = pnpmCommand(args);
  return runStage(profile, command, commandArgs, options);
}

async function vitest(args, options = {}) {
  return runStage(
    options.profile ?? "dom",
    process.execPath,
    [
      toolCli("vitest"),
      "run",
      "--config",
      "vitest.workspace.ts",
      ...args,
      "--maxWorkers",
      process.env.CI === "true" ? "2" : "1",
    ],
    options,
  );
}

export async function editorTests(options = {}) {
  await vitest(["--project", "node", "apps/editor"], {
    ...options,
    profile: "unit",
    env: { VITEST_COVERAGE: "0" },
  });
  const listed = await runCommand(
    process.execPath,
    [
      toolCli("vitest"),
      "list",
      "--config",
      "vitest.workspace.ts",
      "--project",
      "jsdom",
      "apps/editor",
      "--filesOnly",
      "--json",
    ],
    {
      signal: options.signal,
      capture: true,
      env: { ...process.env, VITEST_COVERAGE: "0" },
    },
  );
  if (listed.code) throw new Error(listed.output);
  const files = JSON.parse(listed.output)
    .map((entry) => entry.file)
    .sort();
  if (!files.length)
    throw new Error("Editor DOM discovery unexpectedly selected no tests");
  for (let index = 0; index < files.length; index += 50) {
    await vitest(["--project", "jsdom", ...files.slice(index, index + 50)], {
      ...options,
      env: { VITEST_COVERAGE: "0" },
    });
  }
}

export async function fullVerification(options = {}) {
  await runPnpm("unit", ["run", "test:tooling"], options);
  await runPnpm(
    "build",
    ["--workspace-concurrency=1", "-r", "typecheck"],
    options,
  );
  await runPnpm("unit", ["run", "lint"], options);
  await runTests("coverage", [], options);
  await runTests("e2e", [], options);
  await runPnpm("build", ["--filter", "docs-site", "build"], options);
}

export async function runTests(mode, args, options = {}) {
  if (mode === "unit") return vitest(args, options);
  if (args.length && ["coverage", "editor", "verify"].includes(mode))
    throw new Error(
      `${mode} does not accept filters; use pnpm test for focused checks`,
    );
  if (mode === "editor") return editorTests(options);
  if (mode === "coverage") {
    await vitest(["--coverage"], {
      ...options,
      profile: "coverage",
      env: { VITEST_COVERAGE: "1", NODE_DISABLE_COMPILE_CACHE: "1" },
    });
    return editorTests(options);
  }
  if (mode === "verify") return fullVerification(options);
  if (mode === "e2e" || mode === "build") {
    const { runBrowserTests, buildTestArtifact } =
      await import("./test-build.mjs");
    return mode === "build"
      ? buildTestArtifact(options)
      : runBrowserTests(args, options);
  }
  throw new Error(`Unknown test mode: ${mode}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.chdir(repoRoot);
  const lifetime = commandSignal();
  try {
    await runTests(process.argv[2], process.argv.slice(3), {
      signal: lifetime.signal,
    });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = lifetime.signal.aborted ? 130 : (error.exitCode ?? 1);
  } finally {
    lifetime.dispose();
  }
}
